import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalTraceEventHash } from "@qualigence/runner-protocol";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import type { ExecutionEventBatch, TraceEvent } from "@qualigence/runner-protocol";
import { startCoreDaemon } from "@qualigence/core-daemon";
import { SqliteRuntime } from "@qualigence/sqlite-runtime";
import { createGrpcTestPki } from "../../helpers/grpc-test-pki.js";
import type { GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { makeHello, makeTestClient } from "../../helpers/grpc-harness.js";
import { WEB_TARGET_TOKEN, webJob } from "../../helpers/core-runner-harness.js";

let pki: GrpcTestPki;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  pki = createGrpcTestPki();
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function event(runId: string, graphId = "graph-1"): TraceEvent {
  const input = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `${runId}:1`,
    idempotencyKey: `${runId}:1`,
    runId,
    sequenceNumber: 1,
    stage: "observation",
    occurredAt: "2026-08-17T00:00:00.000Z",
    payload: { graphId, nodes: [] },
  } as const;
  return { ...input, payloadHash: canonicalTraceEventHash(input) } as TraceEvent;
}

function batch(trace: TraceEvent): ExecutionEventBatch {
  return {
    batchId: `batch-${trace.payloadHash}`,
    runId: trace.runId,
    firstSequenceNumber: trace.sequenceNumber,
    events: [trace],
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

describe("Core runner protocol production composition", () => {
  it("rejects Phase A recovery candidates before SQLite opens or a listener binds", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-recovery-phase-a-"));
    const database = join(dataDir, "qualigence.db");
    const port = await freePort();
    try {
      await expect(startCoreDaemon({
        host: "127.0.0.1", port, dataDir, deploymentMode: "self_hosted", leaseDurationMs: 30_000,
        tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
        legacyM1LocalRecoveryCandidate: { format: "legacy-m1-local-recovery/v1", records: [] },
      })).rejects.toThrow(/Local deployment mode/);
      expect(existsSync(database)).toBe(false);
      const daemon = await startCoreDaemon({ host: "127.0.0.1", port, dataDir, leaseDurationMs: 30_000, tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key } });
      await daemon.shutdown();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects Phase B mismatches before bind, closes SQLite, and only upcasts a verified Local row", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-recovery-phase-b-"));
    const database = join(dataDir, "qualigence.db");
    const port = await freePort();
    const policyless = { jobId: "job-legacy", runId: "run-legacy", target: { kind: "web", url: "https://example.test/" }, objective: "legacy" };
    const policy = { policyId: "legacy-m1-local", environment: "isolated_test" as const, allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"] as const, maximumRisk: "Normal" as const, explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" };
    const seed = await SqliteRuntime.open({ filename: database, busyTimeoutMs: 5_000 });
    await seed.db.insertInto("execution_leases").values({
      run_id: policyless.runId, job_id: policyless.jobId, runner_id: "runner-1", session_id: "session-1", lease_epoch: 1,
      job_json: JSON.stringify(policyless), lease_token_hash: "token-hash", expires_at: "2099-01-01T00:00:00.000Z",
      lost_at: null, completed_at: null, recovery_of_run_id: null,
    }).execute();
    await seed.close();
    const candidate = { format: "legacy-m1-local-recovery/v1" as const, records: [{ jobId: policyless.jobId, runId: policyless.runId, canonicalJobSha256: canonicalPayloadHash(policyless), policy }] };
    try {
      await expect(startCoreDaemon({
        host: "127.0.0.1", port, dataDir, deploymentMode: "local", leaseDurationMs: 30_000,
        tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
        legacyM1LocalRecoveryCandidate: { ...candidate, records: [{ ...candidate.records[0], canonicalJobSha256: "0".repeat(64) }] },
      })).rejects.toThrow(/does not match/);
      const reopened = await SqliteRuntime.open({ filename: database, busyTimeoutMs: 5_000 });
      await reopened.close();

      const daemon = await startCoreDaemon({
        host: "127.0.0.1", port, dataDir, deploymentMode: "local", leaseDurationMs: 30_000,
        tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key }, legacyM1LocalRecoveryCandidate: candidate,
      });
      cleanups.push(async () => { await daemon.shutdown(); await rm(dataDir, { recursive: true, force: true }); });
      await daemon.application.ownership.markLost(policyless.runId, "expired");
      await expect(daemon.application.ownership.createRecoveryRun(policyless.runId)).resolves.toMatchObject({ job: { policy } });
    } catch (error) {
      await rm(dataDir, { recursive: true, force: true });
      throw error;
    }
  });

  it("persists trace before ACK and owns renew and completion behind gRPC", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-composition-"));
    const daemon = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client = makeTestClient(pki, daemon.port, pki.clientFor("runner-1"));
    cleanups.push(async () => {
      await client.close();
      await daemon.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });

    const session = await client.connect(makeHello("runner-1"));
    const connection = await daemon.server.waitForConnection("runner-1");
    const job = webJob();
    const leasePromise = connection.offer(job, [WEB_TARGET_TOKEN]);
    const replayLeasePromise = connection.offer(job, [WEB_TARGET_TOKEN]);
    await expect(
      connection.offer({ ...job, objective: "different objective" }, [WEB_TARGET_TOKEN]),
    ).rejects.toMatchObject({ code: "RunIdentityMismatch" });
    const offer = await session.nextOffer(new AbortController().signal);
    const lease = await session.accept(offer.offerId);
    await expect(Promise.all([leasePromise, replayLeasePromise])).resolves.toEqual([lease, lease]);

    const original = event(job.runId);
    const ack = await session.submit(batch(original));
    expect(await daemon.traceStore.eventAt(job.runId, 1)).toEqual(original);
    expect(ack.nextExpectedSequenceNumber).toBe(2);
    expect((await session.submit(batch(original))).nextExpectedSequenceNumber).toBe(2);

    const renewed = await session.renew(lease);
    const completion = { jobId: job.jobId, runId: job.runId, status: "passed" } as const;
    await session.complete(renewed, completion);
    await expect.poll(async () => daemon.application.jobs.completionOf(job.runId)).toEqual(completion);

    await expect(session.renew({ ...renewed, leaseToken: "wrong" })).rejects.toMatchObject({
      code: "LeaseLost",
    });
  });

  it("isolates a same-sequence different-hash session and closes database then port", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-composition-"));
    const daemon = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client = makeTestClient(pki, daemon.port, pki.clientFor("runner-1"));
    const session = await client.connect(makeHello("runner-1"));
    const connection = await daemon.server.waitForConnection("runner-1");
    const job = webJob();
    const leasePromise = connection.offer(job, [WEB_TARGET_TOKEN]);
    const offer = await session.nextOffer(new AbortController().signal);
    await session.accept(offer.offerId);
    await leasePromise;
    await session.submit(batch(event(job.runId)));

    await expect(session.submit(batch(event(job.runId, "tampered")))).rejects.toMatchObject({
      code: "TraceIntegrityViolation",
    });
    await client.close();
    await daemon.shutdown();
    await expect(daemon.traceStore.eventAt(job.runId, 1)).rejects.toMatchObject({
      code: "StorageClosed",
    });

    const probe = makeTestClient(pki, daemon.port, pki.clientFor("runner-1"));
    await expect(probe.connect(makeHello("runner-1"))).rejects.toMatchObject({
      code: expect.stringMatching(/TransportError|TlsPeerRejected/),
    });
    await probe.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("recreates an unaccepted offer after Core restart without stranding ownership", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-restart-"));
    const first = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client1 = makeTestClient(pki, first.port, pki.clientFor("runner-1"));
    const session1 = await client1.connect(makeHello("runner-1"));
    const connection1 = await first.server.waitForConnection("runner-1");
    const job = webJob({ jobId: "job-restart", runId: "run-restart" });
    const offering = connection1.offer(job, [WEB_TARGET_TOKEN]);
    offering.catch(() => undefined);
    await session1.nextOffer(new AbortController().signal);
    await client1.close();
    await first.shutdown();

    const second = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client2 = makeTestClient(pki, second.port, pki.clientFor("runner-1"));
    cleanups.push(async () => {
      await client2.close();
      await second.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });
    const session2 = await client2.connect(makeHello("runner-1"));
    const connection2 = await second.server.waitForConnection("runner-1");
    const leasePromise = connection2.offer(job, [WEB_TARGET_TOKEN]);
    const offer = await session2.nextOffer(new AbortController().signal);
    const lease = await session2.accept(offer.offerId);
    await expect(leasePromise).resolves.toEqual(lease);
    await expect(second.application.ownership.ownerOf(job.runId)).resolves.toEqual({
      runnerId: "runner-1",
      sessionId: session2.welcome.sessionId,
    });
  });

  it("resumes the same session after a real mTLS disconnect without extending the lease", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-resume-"));
    const daemon = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const cert = pki.clientFor("runner-1");
    const client1 = makeTestClient(pki, daemon.port, cert);
    const session1 = await client1.connect(makeHello("runner-1"));
    const connection = await daemon.server.waitForConnection("runner-1");
    const job = webJob({ jobId: "job-resume", runId: "run-resume" });
    const leasePromise = connection.offer(job, [WEB_TARGET_TOKEN]);
    const offer = await session1.nextOffer(new AbortController().signal);
    const lease = await session1.accept(offer.offerId);
    await leasePromise;
    const original = event(job.runId);
    await session1.submit(batch(original));
    const resumeToken = session1.welcome.resumeToken;
    await client1.close();
    await expect.poll(() => daemon.server.connection("runner-1")).toBeUndefined();

    const client2 = makeTestClient(pki, daemon.port, cert);
    cleanups.push(async () => {
      await client2.close();
      await daemon.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });
    const session2 = await client2.connect(makeHello("runner-1", { resumeToken }));
    expect(session2.welcome.sessionId).toBe(session1.welcome.sessionId);
    expect(session2.welcome.resumeToken).not.toBe(resumeToken);
    expect(lease.leaseEpoch).toBe(1);
    expect((await session2.submit(batch(original))).nextExpectedSequenceNumber).toBe(2);
    const completion = { jobId: job.jobId, runId: job.runId, status: "passed" } as const;
    await session2.complete(lease, completion);
    await expect.poll(async () => daemon.application.jobs.completionOf(job.runId)).toEqual(completion);
    const renewed = await session2.renew(lease).catch((error: unknown) => error);
    expect(renewed).toMatchObject({ code: "LeaseLost" });
  });
});
