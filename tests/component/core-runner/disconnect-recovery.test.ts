import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalTraceEventHash } from "@qualigence/runner-protocol";
import type {
  ExecutionCompletion,
  ExecutionEventAck,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  TraceEvent,
} from "@qualigence/runner-protocol";
import type { RunnerClientPort, RunnerSession } from "@qualigence/grpc-runner-protocol";
import { startCoreDaemon } from "@qualigence/core-daemon";
import { SqliteRunnerSpool } from "@qualigence/runner-spool";
import { LeaseWindow } from "../../../apps/runner/src/lease-window.js";
import { RunnerClient } from "../../../apps/runner/src/runner-client.js";
import { SpoolingTraceRecorder } from "../../../apps/runner/src/spooling-trace-recorder.js";
import { TraceUploadPump } from "../../../apps/runner/src/trace-upload-pump.js";
import { InMemoryRunnerControlStore } from "../../helpers/in-memory-runner-control-store.js";
import { RunOwnershipService } from "../../../apps/core-daemon/src/index.js";
import { createGrpcTestPki } from "../../helpers/grpc-test-pki.js";
import type { GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { makeHello, makeTestClient, startTestServer } from "../../helpers/grpc-harness.js";
import { openMemorySpool, WEB_TARGET_TOKEN, webJob } from "../../helpers/core-runner-harness.js";

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

const latestLease: ExecutionJobLease = {
  jobId: "job-complete",
  runId: "run-complete",
  leaseToken: "renewed-token",
  leaseEpoch: 1,
  expiresAt: "2026-08-01T00:02:00.000Z",
};

class CompletionRecordingSession implements RunnerSession {
  readonly welcome = {
    sessionId: "session-complete",
    resumeToken: "resume-complete",
    selectedProtocolMajor: 1 as const,
    serverVersion: "test",
    heartbeatIntervalMs: 1_000,
    leaseDurationMs: 60_000,
    traceBatchMaximumEvents: 100,
    traceBatchMaximumBytes: 1_000_000,
    maximumInFlightBatches: 4,
    maximumPendingWriteBytes: 1_000_000,
  };
  completedLease: ExecutionJobLease | undefined;

  async nextOffer(): Promise<ExecutionJobOffer> {
    return {
      offerId: "offer-complete",
      job: {
        jobId: latestLease.jobId,
        runId: latestLease.runId,
        projectId: "project-test",
        target: { kind: "web", url: "https://example.test" },
        objective: "complete with the latest lease",
        policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
      },
      requiredCapabilities: [],
      leaseDurationMs: 60_000,
    };
  }
  async accept(): Promise<ExecutionJobLease> {
    throw new Error("not used");
  }
  async renew(): Promise<ExecutionJobLease> {
    throw new Error("not used");
  }
  async submit(batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    return {
      batchId: batch.batchId,
      runId: batch.runId,
      nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
    };
  }
  async complete(lease: ExecutionJobLease, _result: ExecutionCompletion): Promise<void> {
    this.completedLease = lease;
  }
  async close(): Promise<void> {}
}

describe("core/runner disconnect recovery Gate", () => {
  it("completes execution with the most recently renewed lease", async () => {
    const spool = await openMemorySpool();
    spools.push(spool);
    const session = new CompletionRecordingSession();
    const clientPort: RunnerClientPort = {
      connect: async () => session,
    };
    const window = new LeaseWindow(
      latestLease,
      { monotonicNow: () => 1_000, wallNow: () => 100_000 },
      { leaseDurationMs: 60_000, actionDeadlineSafetyMarginMs: 5_000 },
    );
    const client = new RunnerClient({
      clientPort,
      makeHello: () => makeHello("runner-1"),
      executor: {
        execute: async () => ({
          lease: latestLease,
          completion: {
            jobId: latestLease.jobId,
            runId: latestLease.runId,
            status: "passed",
          },
          window,
        }),
      },
      spool,
    });

    await client.connect();
    await client.serveNextOffer(new AbortController().signal);

    expect(session.completedLease?.leaseToken).toBe("renewed-token");
  });

  it("forwards the canonical stored completion to the sink on an authoritative duplicate", async () => {
    const store = new InMemoryRunnerControlStore();
    const ownership = new RunOwnershipService({ store, integrityEvents: { emit: () => undefined }, now: () => Date.parse("2026-08-19T00:00:01.000Z") });
    const job = webJob({ jobId: "job-duplicate-sink", runId: "run-duplicate-sink" });
    const lease = await ownership.grant(job, { runnerId: "runner-1", sessionId: "session-1" });
    const completion = { jobId: job.jobId, runId: job.runId, status: "passed" } as const;
    await ownership.complete(lease, completion);
    await expect(ownership.complete(lease, completion)).resolves.toBe("duplicate");
    await expect(store.completionRecord(job.runId)).resolves.toMatchObject({ completion, jobSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

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

  it("blocks a new action after lease expiry on both the runner and core sides", async () => {
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
    const ownership = new RunOwnershipService({
      store: new InMemoryRunnerControlStore(),
      integrityEvents: { emit: () => undefined },
      leaseDurationMs: 30_000,
      now: () => nowMs,
    });
    const granted = await ownership.grant(webJob({ runId: "run-1" }), {
      runnerId: "runner-1",
      sessionId: "session-1",
    });
    await expect(ownership.mayStartAction(granted)).resolves.toBe(true);
    nowMs = 30_001; // advance the Core clock past expiry
    await expect(ownership.mayStartAction(granted)).resolves.toBe(false);
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

  it("refuses a different runner uploading trace for a run it does not own", async () => {
    const ownership = new RunOwnershipService({
      store: new InMemoryRunnerControlStore(),
      integrityEvents: { emit: () => undefined },
    });
    const job = webJob({ runId: "run-1" });
    await ownership.grant(job, { runnerId: "runner-1", sessionId: "session-1" });

    const batch: ExecutionEventBatch = {
      batchId: "batch-1",
      runId: "run-1",
      firstSequenceNumber: 1,
      events: [],
    };

    await expect(
      ownership.authorizeTraceUpload(
        { runnerId: "runner-2", certificateFingerprint: "fp-runner-2", scope: { kind: "local" } },
        batch,
      ),
    ).rejects.toThrowError(/may not upload Trace/);
    await expect(
      ownership.authorizeTraceUpload(
        { runnerId: "runner-1", certificateFingerprint: "fp-runner-1", scope: { kind: "local" } },
        batch,
      ),
    ).resolves.toBeUndefined();
  });

  it("restores an accepted lease after Core restart and refuses a lost run to another runner", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-control-restart-"));
    const first = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const cert = pki.clientFor("runner-1");
    const client1 = makeTestClient(pki, first.port, cert);
    const session1 = await client1.connect(makeHello("runner-1"));
    const connection1 = await first.server.waitForConnection("runner-1");
    const job = webJob({ jobId: "job-persist", runId: "run-persist" });
    const leasePromise = connection1.offer(job, [WEB_TARGET_TOKEN]);
    const offer = await session1.nextOffer(new AbortController().signal);
    const lease = await session1.accept(offer.offerId);
    await leasePromise;
    const original = persistedEvent(job.runId);
    expect((await session1.submit(persistedBatch(original))).nextExpectedSequenceNumber).toBe(2);
    const resumeToken = session1.welcome.resumeToken;
    await client1.close();
    await first.shutdown();

    const second = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client2 = makeTestClient(pki, second.port, cert);
    cleanups.push(async () => {
      await client2.close();
      await second.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });
    const session2 = await client2.connect(makeHello("runner-1", { resumeToken }));
    expect(session2.welcome.sessionId).toBe(session1.welcome.sessionId);
    expect((await session2.submit(persistedBatch(original))).nextExpectedSequenceNumber).toBe(2);
    await expect(second.application.ownership.mayStartAction(lease)).resolves.toBe(true);
    await expect(second.application.ownership.ownerOf(job.runId)).resolves.toEqual({
      runnerId: "runner-1",
      sessionId: session2.welcome.sessionId,
    });

    await second.application.ownership.markLost(job.runId, "expired");
    await expect(second.application.ownership.mayStartAction(lease)).resolves.toBe(false);
    const recovery = await second.application.ownership.createRecoveryRun(job.runId);
    expect(recovery.job.runId).not.toBe(job.runId);
    await second.application.ownership.grant(
      recovery.job,
      { runnerId: "runner-1", sessionId: session2.welcome.sessionId },
      recovery.recoveryOfRunId,
    );
    await expect(second.application.ownership.ownerOf(job.runId)).resolves.toMatchObject({
      runnerId: "runner-1",
    });
    await expect(second.application.ownership.recoveryOf(recovery.job.runId)).resolves.toBe(job.runId);
  });
});

function persistedEvent(runId: string): TraceEvent {
  const input = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `${runId}:1`,
    idempotencyKey: `${runId}:1`,
    runId,
    sequenceNumber: 1,
    stage: "observation",
    occurredAt: "2026-08-18T00:00:00.000Z",
    payload: { graphId: "graph-1", nodes: [] },
  } as const;
  return { ...input, payloadHash: canonicalTraceEventHash(input) } as TraceEvent;
}

function persistedBatch(trace: TraceEvent): ExecutionEventBatch {
  return {
    batchId: `batch-${trace.payloadHash}`,
    runId: trace.runId,
    firstSequenceNumber: trace.sequenceNumber,
    events: [trace],
  };
}
