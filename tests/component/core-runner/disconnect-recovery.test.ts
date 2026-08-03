import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  ExecutionEventAck,
  ExecutionEventBatch,
} from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import { SqliteRunnerSpool } from "@qualigence/runner-spool";
import { LeaseWindow } from "../../../apps/runner/src/lease-window.js";
import { SpoolingTraceRecorder } from "../../../apps/runner/src/spooling-trace-recorder.js";
import { TraceUploadPump } from "../../../apps/runner/src/trace-upload-pump.js";
import { RunOwnershipService } from "../../../apps/core-daemon/src/index.js";
import { createGrpcTestPki } from "../../helpers/grpc-test-pki.js";
import type { GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { makeHello, makeTestClient, startTestServer } from "../../helpers/grpc-harness.js";
import { openMemorySpool, webJob } from "../../helpers/core-runner-harness.js";

let pki: GrpcTestPki;

beforeAll(() => {
  pki = createGrpcTestPki();
});

const cleanups: Array<() => Promise<void>> = [];
const spools: SqliteRunnerSpool[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
  await Promise.all(spools.splice(0).map((spool) => spool.close()));
});

class RecordingSubmitter {
  readonly firstSequenceNumbers: number[] = [];
  readonly nextExpected: number[] = [];
  constructor(private readonly session: RunnerSession) {}
  async submit(batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    this.firstSequenceNumbers.push(batch.firstSequenceNumber);
    const ack = await this.session.submit(batch);
    this.nextExpected.push(ack.nextExpectedSequenceNumber);
    return ack;
  }
}

async function spoolObservations(
  spool: SqliteRunnerSpool,
  runId: string,
  count: number,
): Promise<void> {
  const recorder = new SpoolingTraceRecorder(spool);
  for (let index = 0; index < count; index += 1) {
    await recorder.append({
      runId,
      stage: "observation",
      payload: { graphId: `graph-${index + 1}`, nodes: [] },
    });
  }
}

describe("core/runner disconnect recovery Gate", () => {
  it("loses no accepted trace when a runner disconnects mid-run and replays in order on reconnect", async () => {
    const { server, port } = await startTestServer(pki);
    const cert = pki.clientFor("runner-1");
    const runId = "run-attempt-1";
    const totalEvents = 6;

    const spool = await openMemorySpool();
    spools.push(spool);
    await spoolObservations(spool, runId, totalEvents);

    // First connection: submit only the first batch, then the transport drops.
    const client1 = makeTestClient(pki, port, cert);
    const session1 = await client1.connect(makeHello("runner-1"));
    const resumeToken = session1.welcome.resumeToken;

    const partialPump = new TraceUploadPump(spool, new RecordingSubmitter(session1), runId, {
      maximumEvents: 3,
      maximumBytes: 1_000_000,
    });
    const firstStep = await partialPump.pumpOnce();
    expect(firstStep.submitted).toBe(3);
    expect(firstStep.done).toBe(false);

    // Simulated disconnect mid-run: three events remain durably spooled.
    await client1.close();
    expect((await spool.usage()).events).toBe(totalEvents - 3);

    // Reconnect as the same identity with the rotating resume token and replay.
    const client2 = makeTestClient(pki, port, cert);
    cleanups.push(async () => {
      await client2.close();
      await server.shutdown();
    });
    const session2 = await client2.connect(makeHello("runner-1", { resumeToken }));
    expect(session2.welcome.resumeToken).not.toBe(resumeToken);

    const replaySubmitter = new RecordingSubmitter(session2);
    await new TraceUploadPump(spool, replaySubmitter, runId, {
      maximumEvents: 100,
      maximumBytes: 1_000_000,
    }).drain();

    // The replay resumes exactly at the surviving Core cursor (4), never resends
    // an already-acknowledged event, and drains every remaining event.
    expect(replaySubmitter.firstSequenceNumbers).toEqual([4]);
    expect(replaySubmitter.nextExpected.at(-1)).toBe(totalEvents + 1);
    expect((await spool.usage()).events).toBe(0);
  });

  it("blocks a new action after lease expiry on both the runner and core sides", () => {
    const lease = {
      jobId: "job-1",
      runId: "run-1",
      leaseToken: "lease-token",
      leaseEpoch: 1,
      expiresAt: "2026-08-01T00:00:30.000Z",
    } as const;

    // Runner side: the monotonic action window closes with no wall-clock reprieve.
    const state = { monotonic: 1_000, wall: 100_000 };
    const window = new LeaseWindow(
      lease,
      { monotonicNow: () => state.monotonic, wallNow: () => state.wall },
      { leaseDurationMs: 30_000, actionDeadlineSafetyMarginMs: 5_000 },
    );
    expect(window.mayStartAction()).toBe(true);
    state.monotonic = 1_000 + 30_000 - 5_000; // reach the safety-adjusted deadline
    expect(window.mayStartAction()).toBe(false);

    // Core side: ownership refuses to authorize a new action past lease expiry.
    let nowMs = 0;
    const ownership = new RunOwnershipService({ leaseDurationMs: 30_000, now: () => nowMs });
    const granted = ownership.grant(webJob({ runId: "run-1" }), {
      runnerId: "runner-1",
      sessionId: "session-1",
    });
    expect(ownership.mayStartAction(granted)).toBe(true);
    nowMs = 30_001; // advance the Core clock past expiry
    expect(ownership.mayStartAction(granted)).toBe(false);
  });

  it("refuses a second runner replaying another runner's resume token", async () => {
    const { server, port } = await startTestServer(pki);

    const client1 = makeTestClient(pki, port, pki.clientFor("runner-1"));
    const session1 = await client1.connect(makeHello("runner-1"));
    const stolenToken = session1.welcome.resumeToken;
    await client1.close();

    const client2 = makeTestClient(pki, port, pki.clientFor("runner-2"));
    cleanups.push(async () => {
      await client2.close();
      await server.shutdown();
    });

    await expect(
      client2.connect(makeHello("runner-2", { resumeToken: stolenToken })),
    ).rejects.toMatchObject({ code: "ResumeRejected" });
  });

  it("refuses a different runner uploading trace for a run it does not own", () => {
    const ownership = new RunOwnershipService();
    const job = webJob({ runId: "run-1" });
    ownership.grant(job, { runnerId: "runner-1", sessionId: "session-1" });

    const batch: ExecutionEventBatch = {
      batchId: "batch-1",
      runId: "run-1",
      firstSequenceNumber: 1,
      events: [],
    };

    expect(() =>
      ownership.authorizeTraceUpload(
        { runnerId: "runner-2", certificateFingerprint: "fp-runner-2" },
        batch,
      ),
    ).toThrowError(/may not upload Trace/);
    // The rightful owner is still allowed to upload its own run's trace.
    expect(() =>
      ownership.authorizeTraceUpload(
        { runnerId: "runner-1", certificateFingerprint: "fp-runner-1" },
        batch,
      ),
    ).not.toThrow();
  });
});
