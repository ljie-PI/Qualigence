import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  ExecutionEventAck,
  ExecutionEventBatch,
} from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import { InMemoryRunnerControlStore } from "../../helpers/in-memory-runner-control-store.js";
import { SqliteRunnerSpool } from "@qualigence/runner-spool";
import { LeasedJobExecutor } from "../../../apps/runner/src/job-executor.js";
import { TraceUploadPump } from "../../../apps/runner/src/trace-upload-pump.js";
import { RunOwnershipService } from "../../../apps/core-daemon/src/index.js";
import { createGrpcTestPki } from "../../helpers/grpc-test-pki.js";
import type { GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { makeHello, makeTestClient, startTestServer } from "../../helpers/grpc-harness.js";
import {
  UNSUPPORTED_TOKEN,
  WEB_TARGET_TOKEN,
  deterministicRunnerDependencies,
  offerFor,
  openMemorySpool,
  webJob,
} from "../../helpers/core-runner-harness.js";

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

/** Records every ack so the test can prove the Core cursor advanced contiguously. */
class RecordingSubmitter {
  readonly nextExpected: number[] = [];
  constructor(private readonly session: RunnerSession) {}
  async submit(batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    const ack = await this.session.submit(batch);
    this.nextExpected.push(ack.nextExpectedSequenceNumber);
    return ack;
  }
}

describe("core/runner independent-process integration", () => {
  it("runs a leased web job end to end over real mutual-TLS gRPC and loses no trace", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port, pki.clientFor("runner-1"));
    cleanups.push(async () => {
      await client.close();
      await server.shutdown();
    });

    const session = await client.connect(makeHello("runner-1"));
    const connection = await server.waitForConnection("runner-1");
    expect(connection.authenticatedRunner.runnerId).toBe("runner-1");
    expect(connection.authenticatedRunner.scope).toEqual({ kind: "local" });
    expect(connection.authenticatedRunner.capabilities).toContain(WEB_TARGET_TOKEN);

    const job = webJob();
    const leasePromise = connection.offer(job, [WEB_TARGET_TOKEN]);

    const spool = await openMemorySpool();
    spools.push(spool);
    const executor = new LeasedJobExecutor(
      deterministicRunnerDependencies(spool, { monotonic: 1_000, wall: 100_000 }),
    );

    const offer = await session.nextOffer(new AbortController().signal);
    const result = await executor.execute(offer, session);
    const serverLease = await leasePromise;

    expect(result.completion.status).toBe("passed");
    expect(serverLease.runId).toBe(job.runId);

    const spooledCount = (await spool.usage()).events;
    expect(spooledCount).toBeGreaterThan(0);

    const submitter = new RecordingSubmitter(session);
    await new TraceUploadPump(spool, submitter, job.runId, {
      maximumEvents: session.welcome.traceBatchMaximumEvents,
      maximumBytes: session.welcome.traceBatchMaximumBytes,
    }).drain();
    await session.complete(result.lease, result.completion);

    // Every spooled event was acknowledged by Core: the spool is now empty and
    // the Core cursor advanced past the final sequence with no gap.
    expect((await spool.usage()).events).toBe(0);
    expect(submitter.nextExpected.at(-1)).toBe(spooledCount + 1);
    expect([...submitter.nextExpected].sort((a, b) => a - b)).toEqual(submitter.nextExpected);
  });

  it("rejects an offer with an unmet capability instead of silently downgrading", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port, pki.clientFor("runner-1"));
    cleanups.push(async () => {
      await client.close();
      await server.shutdown();
    });

    const session = await client.connect(makeHello("runner-1"));
    const connection = await server.waitForConnection("runner-1");

    const job = webJob();
    await expect(connection.offer(job, [UNSUPPORTED_TOKEN])).rejects.toMatchObject({
      code: "CapabilityMismatch",
    });
    const spool = await openMemorySpool();
    spools.push(spool);
    expect((await spool.usage()).events).toBe(0);
    void session;
  });

  it("grants a run to a single owner and refuses a second owner for the same run", async () => {
    const ownership = new RunOwnershipService({
      store: new InMemoryRunnerControlStore(),
      integrityEvents: { emit: () => undefined },
    });
    const job = webJob();

    await ownership.grant(job, { runnerId: "runner-1", sessionId: "session-1" });

    await expect(
      ownership.grant(job, { runnerId: "runner-2", sessionId: "session-2" }),
    ).rejects.toThrowError(/already has an owner/);
    expect((await ownership.ownerOf(job.runId))?.runnerId).toBe("runner-1");
  });

  it("binds identity to the certificate: another runner's certificate cannot impersonate", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port, pki.clientFor("runner-2"));
    cleanups.push(async () => {
      await client.close();
      await server.shutdown();
    });

    await expect(client.connect(makeHello("runner-1"))).rejects.toMatchObject({
      code: "RunnerIdentityMismatch",
    });
  });
});
