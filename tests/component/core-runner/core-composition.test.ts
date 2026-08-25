import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PendingMissionDispatch } from "@qualigence/mission";
import { canonicalTraceEventHash } from "@qualigence/runner-protocol";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import type { ExecutionEventBatch, TraceEvent } from "@qualigence/runner-protocol";
import * as coreDaemon from "@qualigence/core-daemon";
import { startCoreDaemon } from "@qualigence/core-daemon";
import { SqliteRunnerControlStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import { MissionDispatchLoop } from "../../../apps/server/src/mission-dispatch-loop.js";
import { createGrpcTestPki } from "../../helpers/grpc-test-pki.js";
import type { GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { makeHello, makeTestClient } from "../../helpers/grpc-harness.js";
import { WEB_GRAPH_V1_REQUIREMENTS, WEB_TARGET_TOKEN, webJob } from "../../helpers/core-runner-harness.js";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";

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
    payload: observationGraphV1(graphId),
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

async function testBootstrapCredentials() {
  const backing = Buffer.alloc(100, 0x5a);
  return {
    userBootstrap: backing.subarray(20, 52),
    supervisor: backing.subarray(52, 84),
    createdAtEpochMs: Date.now(),
    userExpiresAtEpochMs: Date.now() + 60_000,
    destroy: () => backing.fill(0),
  };
}

async function canBind(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
  }
}

describe("Core runner protocol production composition", () => {
  it("exposes no callable legacy recovery helper outside Core startup", () => {
    expect(coreDaemon).not.toHaveProperty("validateLegacyM1LocalRecoveryCandidate");
    expect(coreDaemon).not.toHaveProperty("verifyLegacyM1LocalRecoveryRows");
    expect(coreDaemon).not.toHaveProperty("applyVerifiedLegacyM1LocalRecovery");
  });

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

  it.each([
    ["absent host", undefined, /exact loopback/],
    ["non-loopback host", "0.0.0.0", /exact loopback/],
    ["IPv6 loopback", "::1", /manifest format/],
  ])("rejects Phase A %s before opening SQLite", async (_name, host, message) => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-recovery-host-"));
    const database = join(dataDir, "qualigence.db");
    try {
      await expect(startCoreDaemon({
        host: host as never, port: await freePort(), dataDir, deploymentMode: "local", leaseDurationMs: 30_000,
        tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
        legacyM1LocalRecoveryCandidate: { format: "legacy-m1-local-recovery/v1", records: [] },
      })).rejects.toThrow(message);
      expect(existsSync(database)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed and duplicate Phase A manifests before a listener binds", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-recovery-manifest-"));
    const port = await freePort();
    const policy = { policyId: "legacy-m1-local", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" };
    const record = { jobId: "job-1", runId: "run-1", canonicalJobSha256: "0".repeat(64), policy };
    try {
      await expect(startCoreDaemon({ host: "127.0.0.1", port, dataDir, deploymentMode: "local", leaseDurationMs: 30_000, tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key }, legacyM1LocalRecoveryCandidate: { format: "unknown", records: [record] } })).rejects.toThrow();
      await expect(startCoreDaemon({ host: "127.0.0.1", port, dataDir, deploymentMode: "local", leaseDurationMs: 30_000, tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key }, legacyM1LocalRecoveryCandidate: { format: "legacy-m1-local-recovery/v1", records: [record, record] } })).rejects.toThrow(/duplicated/);
      const daemon = await startCoreDaemon({ host: "127.0.0.1", port, dataDir, leaseDurationMs: 30_000, tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key } });
      await daemon.shutdown();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["empty jobId", "", "run-1"],
    ["whitespace jobId", "   ", "run-1"],
    ["empty runId", "job-1", ""],
    ["whitespace runId", "job-1", "\t  "],
  ])("rejects Phase A %s before SQLite or listener side effects", async (_name, jobId, runId) => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-recovery-identity-"));
    const database = join(dataDir, "qualigence.db");
    const port = await freePort();
    const policy = { policyId: "legacy-m1-local", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" };
    try {
      await expect(startCoreDaemon({
        host: "127.0.0.1", port, dataDir, deploymentMode: "local", leaseDurationMs: 30_000,
        tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
        legacyM1LocalRecoveryCandidate: {
          format: "legacy-m1-local-recovery/v1",
          records: [{ jobId, runId, canonicalJobSha256: "0".repeat(64), policy }],
        },
      })).rejects.toThrow(/identity/);
      expect(existsSync(database)).toBe(false);

      const daemon = await startCoreDaemon({
        host: "127.0.0.1", port, dataDir, leaseDurationMs: 30_000,
        tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
      });
      await daemon.shutdown();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects Phase B mismatches before bind, closes SQLite, and only upcasts a verified Local row", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-recovery-phase-b-"));
    const database = join(dataDir, "qualigence.db");
    const port = await freePort();
    const httpPort = await freePort();
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
        host: "127.0.0.1", port, httpPort, configuredRunnerId: "runner-1", dataDir, deploymentMode: "local", leaseDurationMs: 30_000,
        tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
        legacyM1LocalRecoveryCandidate: { ...candidate, records: [{ ...candidate.records[0], canonicalJobSha256: "0".repeat(64) }] },
      }, { collectBootstrapCredentials: testBootstrapCredentials })).rejects.toThrow(/does not match/);
      const reopened = await SqliteRuntime.open({ filename: database, busyTimeoutMs: 5_000 });
      await reopened.close();

      const daemon = await startCoreDaemon({
        host: "127.0.0.1", port, httpPort, configuredRunnerId: "runner-1", dataDir, deploymentMode: "local", leaseDurationMs: 30_000,
        tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key }, legacyM1LocalRecoveryCandidate: candidate,
      }, { collectBootstrapCredentials: testBootstrapCredentials });
      cleanups.push(async () => { await daemon.shutdown(); await rm(dataDir, { recursive: true, force: true }); });
      const strictReaderRuntime = await SqliteRuntime.open({ filename: database, busyTimeoutMs: 5_000 });
      try {
        await expect(new SqliteRunnerControlStore(strictReaderRuntime).lease(policyless.runId)).resolves.toMatchObject({
          job: { projectId: "local", policy },
        });
      } finally {
        await strictReaderRuntime.close();
      }
      await daemon.application.ownership.markLost(policyless.runId, "expired");
      await expect(daemon.application.ownership.createRecoveryRun(policyless.runId)).resolves.toMatchObject({ job: { projectId: "local", policy } });
    } catch (error) {
      await rm(dataDir, { recursive: true, force: true });
      throw error;
    }
  });

  it("destroys credentials and closes SQLite when coordinator startup fails before listeners bind", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-startup-cleanup-"));
    const database = join(dataDir, "qualigence.db");
    const seed = await SqliteRuntime.open({ filename: database, busyTimeoutMs: 5_000 });
    await seed.close();
    const grpcPort = await freePort();
    const httpPort = await freePort();
    const frame = Buffer.alloc(100, 0x5a);
    const destroy = vi.fn(() => frame.fill(0));
    try {
      await expect(startCoreDaemon({
        host: "127.0.0.1", port: grpcPort, httpPort, dataDir, deploymentMode: "local", configuredRunnerId: "runner-1", leaseDurationMs: 30_000,
        tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
      }, {
        collectBootstrapCredentials: async () => ({ userBootstrap: frame.subarray(20, 52), supervisor: frame.subarray(52, 84), createdAtEpochMs: Date.now(), userExpiresAtEpochMs: Date.now() + 60_000, destroy }),
        startCoordinator: async () => { throw new Error("injected coordinator startup failure"); },
      })).rejects.toThrow("injected coordinator startup failure");
      expect(destroy).toHaveBeenCalledOnce();
      expect(frame.equals(Buffer.alloc(100))).toBe(true);
      await rm(database);
      expect(await canBind(grpcPort)).toBe(true);
      expect(await canBind(httpPort)).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing persisted row", undefined, { policyId: "legacy-m1-local", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" }],
    ["origin mismatch", "https://other.test/", { policyId: "legacy-m1-local", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" }],
    ["preexisting policy", "https://example.test/", { policyId: "legacy-m1-local", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" }],
  ])("rejects Phase B %s and releases SQLite/listener", async (name, targetUrl, policy) => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-recovery-phase-b-invalid-"));
    const database = join(dataDir, "qualigence.db");
    const port = await freePort();
    const job = { jobId: "job-legacy", runId: "run-legacy", target: { kind: "web", url: targetUrl ?? "https://example.test/" }, objective: "legacy" };
    try {
      if (name !== "missing persisted row") {
        const seed = await SqliteRuntime.open({ filename: database, busyTimeoutMs: 5_000 });
        await seed.db.insertInto("execution_leases").values({ run_id: job.runId, job_id: job.jobId, runner_id: "runner-1", session_id: "session-1", lease_epoch: 1, job_json: JSON.stringify(name === "preexisting policy" ? { ...job, policy } : job), lease_token_hash: "token-hash", expires_at: "2099-01-01T00:00:00.000Z", lost_at: null, completed_at: null, recovery_of_run_id: null }).execute();
        await seed.close();
      }
      const candidate = { format: "legacy-m1-local-recovery/v1", records: [{ jobId: job.jobId, runId: job.runId, canonicalJobSha256: canonicalPayloadHash(job), policy }] };
      await expect(startCoreDaemon({ host: "127.0.0.1", port, dataDir, deploymentMode: "local", leaseDurationMs: 30_000, tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key }, legacyM1LocalRecoveryCandidate: candidate })).rejects.toThrow();
      const reopened = await SqliteRuntime.open({ filename: database, busyTimeoutMs: 5_000 });
      await reopened.close();
      const daemon = await startCoreDaemon({ host: "127.0.0.1", port, dataDir, leaseDurationMs: 30_000, tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key } });
      await daemon.shutdown();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed on a normal policyless persisted Job when no recovery manifest is supplied", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-core-policyless-normal-"));
    const database = join(dataDir, "qualigence.db");
    const seed = await SqliteRuntime.open({ filename: database, busyTimeoutMs: 5_000 });
    await seed.db.insertInto("execution_leases").values({ run_id: "run-policyless", job_id: "job-policyless", runner_id: "runner-1", session_id: "session-1", lease_epoch: 1, job_json: JSON.stringify({ jobId: "job-policyless", runId: "run-policyless", target: { kind: "web", url: "https://example.test/" }, objective: "legacy" }), lease_token_hash: "token-hash", expires_at: "2099-01-01T00:00:00.000Z", lost_at: null, completed_at: null, recovery_of_run_id: null }).execute();
    await seed.close();
    const daemon = await startCoreDaemon({ host: "127.0.0.1", port: 0, dataDir, leaseDurationMs: 30_000, tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key } });
    try {
      await expect(daemon.application.ownership.ownerOf("run-policyless")).rejects.toMatchObject({ code: "PolicyMissing" });
    } finally {
      await daemon.shutdown();
      await rm(dataDir, { recursive: true, force: true });
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
    const leasePromise = connection.offer(job, WEB_GRAPH_V1_REQUIREMENTS);
    const replayLeasePromise = connection.offer(job, WEB_GRAPH_V1_REQUIREMENTS);
    await expect(
      connection.offer({ ...job, objective: "different objective" }, WEB_GRAPH_V1_REQUIREMENTS),
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
    const reader = await SqliteRuntime.open({ filename: join(dataDir, "qualigence.db"), busyTimeoutMs: 5_000, openMode: "require-current" });
    try {
      await expect(new SqliteRunnerControlStore(reader).completionRecord(job.runId)).resolves.toEqual({ runId: job.runId, jobId: job.jobId, jobSha256: canonicalPayloadHash(job), completion, completedAt: expect.any(String) });
    } finally { await reader.close(); }

    await expect(session.renew({ ...renewed, leaseToken: "wrong" })).rejects.toMatchObject({
      code: "LeaseLost",
    });
  });

  it("dispatches a Mission outbox row through the bound authenticated Runner only", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-bound-dispatch-"));
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
    const boundConnection = await daemon.server.waitForConnection("runner-1");
    const runnerJob: PendingMissionDispatch["job"] = {
      jobId: "runner-job-bound",
      runId: "run-bound",
      projectId: "project-test",
      target: { kind: "web", url: "https://shop.example.test/cart" },
      objective: "add the item to the cart",
      policy: {
        policyId: "policy-test",
        environment: "isolated_test",
        allowedOrigins: ["https://shop.example.test"],
        allowedActionKinds: ["click"],
        maximumRisk: "Normal",
        explorationAllowed: false,
        issuedAt: "2026-08-24T00:00:00.000Z",
        expiresAt: "2026-08-24T00:01:00.000Z",
      },
      plan: {
        missionId: "mission-bound",
        missionRevision: 1,
        testCaseId: "case-bound",
        steps: [{ kind: "click", target: { role: "button", name: "Add to cart", purpose: "add item" } }],
        expectedClaimIds: ["claim-bound"],
        budget: { maximumStepsPerJob: 1, maximumWallClockMs: 60_000, maximumModelTokens: 1_000 },
      },
    };
    const pending: PendingMissionDispatch = {
      attemptId: "attempt-bound",
      missionId: "mission-bound",
      runnerId: "runner-1",
      runnerJobId: runnerJob.jobId,
      runId: runnerJob.runId,
      requiredCapabilities: WEB_GRAPH_V1_REQUIREMENTS,
      job: runnerJob,
      status: "pending" as const,
      version: 1,
      createdAt: "2026-08-24T00:00:00.000Z",
    };
    const accepted: unknown[] = [];
    const loop = new MissionDispatchLoop({
      tenantId: "tenant-1",
      repository: {
        pendingDispatches: async () => [pending],
        markDispatchAccepted: async (attemptId, receipt, expectedVersion) => {
          accepted.push({ attemptId, receipt, expectedVersion });
          return { ...pending, status: "accepted" as const, version: expectedVersion + 1, acceptedAt: receipt.acceptedAt, receipt };
        },
        markDispatchBlocked: async () => {
          throw new Error("unexpected durable block");
        },
      },
      runners: {
        connectionFor: ({ tenantId, runnerId }) => {
          expect(tenantId).toBe("tenant-1");
          expect(runnerId).toBe("runner-1");
          return {
            authenticatedRunner: {
              runnerId: boundConnection.authenticatedRunner.runnerId,
              scope: { kind: "tenant" as const, tenantId: "tenant-1", projectIds: ["project-test"] },
              capabilities: boundConnection.authenticatedRunner.capabilities,
            },
            offer: (job, requirements) => boundConnection.offer(job, requirements),
          };
        },
      },
      leases: { lease: async () => undefined },
      clock: { now: () => "2026-08-24T00:00:01.000Z" },
    });

    const running = loop.runOnce();
    const offer = await session.nextOffer(new AbortController().signal);
    expect(offer.job).toEqual(runnerJob);
    const lease = await session.accept(offer.offerId);
    await expect(running).resolves.toMatchObject({ accepted: 1, pending: 0, blocked: 0 });
    expect(accepted).toEqual([{ attemptId: "attempt-bound", expectedVersion: 1, receipt: { status: "accepted", jobId: runnerJob.jobId, runId: runnerJob.runId, acceptedAt: pending.createdAt } }]);
    await expect(daemon.application.ownership.ownerOf(runnerJob.runId)).resolves.toEqual({ runnerId: "runner-1", sessionId: session.welcome.sessionId });
    expect(lease.runId).toBe(runnerJob.runId);
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
    const leasePromise = connection.offer(job, WEB_GRAPH_V1_REQUIREMENTS);
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
    const offering = connection1.offer(job, WEB_GRAPH_V1_REQUIREMENTS);
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
    const leasePromise = connection2.offer(job, WEB_GRAPH_V1_REQUIREMENTS);
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
    const leasePromise = connection.offer(job, WEB_GRAPH_V1_REQUIREMENTS);
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
