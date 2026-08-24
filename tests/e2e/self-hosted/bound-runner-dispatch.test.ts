import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AcceptedMissionExecutionJob, PendingMissionDispatch } from "@qualigence/mission";
import { startCoreDaemon } from "@qualigence/core-daemon";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import { SqlitePrdMissionStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import { MissionDispatchLoop, type MissionDispatchRunnerConnection } from "../../../apps/server/src/mission-dispatch-loop.js";
import { createGrpcTestPki, type GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { makeHello, makeTestClient } from "../../helpers/grpc-harness.js";
import { UNSUPPORTED_TOKEN, WEB_TARGET_TOKEN, webJob } from "../../helpers/core-runner-harness.js";

let pki: GrpcTestPki;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  pki = createGrpcTestPki();
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("Self-hosted bound Runner dispatch acceptance", () => {
  it("offers work only to the exact authenticated bound Runner", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-e2e-bound-runner-"));
    const daemon = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client = makeTestClient(pki, daemon.port, pki.clientFor("runner-bound"));
    cleanups.push(async () => {
      await client.close();
      await daemon.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });
    const session = await client.connect(makeHello("runner-bound"));
    const connection = await daemon.server.waitForConnection("runner-bound");
    const row = dispatch({ runnerId: "runner-bound" });
    const seeded = await seedDispatchStore(row);
    const loop = new MissionDispatchLoop({
      tenantId: "tenant-a",
      repository: seeded.store,
      runners: {
        connectionFor: ({ tenantId, runnerId }) => {
          expect({ tenantId, runnerId }).toEqual({ tenantId: "tenant-a", runnerId: "runner-bound" });
          return {
            authenticatedRunner: { runnerId: "runner-bound", scope: { kind: "tenant", tenantId: "tenant-a", projectIds: ["project-test"] }, capabilities: connection.authenticatedRunner.capabilities },
            offer: (job, requirements) => connection.offer(job, requirements),
          } satisfies MissionDispatchRunnerConnection;
        },
      },
      leases: { lease: async () => undefined },
      clock: { now: () => "2026-08-24T00:00:01.000Z" },
    });

    const running = loop.runOnce();
    const offer = await session.nextOffer(new AbortController().signal);
    expect(offer.job).toEqual(row.job);
    const lease = await session.accept(offer.offerId);

    await expect(running).resolves.toMatchObject({ accepted: 1, pending: 0, blocked: 0 });
    expect(lease).toMatchObject({ runId: row.runId, jobId: row.runnerJobId });
    await expect(seeded.store.pendingDispatches(1)).resolves.toEqual([]);
    await expect(dispatchState(seeded.runtime, row.attemptId)).resolves.toEqual({ outbox: "accepted", attempt: "accepted" });
  }, 60_000);

  it("leaves an offline bound Runner durably pending", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-e2e-offline-runner-"));
    const daemon = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    cleanups.push(async () => {
      await daemon.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });
    const row = dispatch();
    const seeded = await seedDispatchStore(row);
    const loop = new MissionDispatchLoop({
      tenantId: "tenant-a",
      repository: seeded.store,
      runners: { connectionFor: async ({ runnerId }) => daemon.server.connection(runnerId) === undefined ? undefined : connectionFor(row, [WEB_TARGET_TOKEN]) },
      leases: { lease: async () => undefined },
      clock: { now: () => "2026-08-24T00:00:01.000Z" },
    });

    await expect(loop.runOnce()).resolves.toMatchObject({ pending: 1, blocked: 0, accepted: 0, results: [{ outcome: "pending", reason: "runner_offline" }] });
    await expect(loop.runOnce()).resolves.toMatchObject({ pending: 1, results: [{ outcome: "pending", reason: "backing_off" }] });
    await expect(seeded.store.pendingDispatches(1)).resolves.toEqual([expect.objectContaining({ attemptId: row.attemptId, status: "pending" })]);
    await seeded.runtime.close();
    const reopened = await SqliteRuntime.open({ filename: seeded.filename, busyTimeoutMs: 5_000, openMode: "require-current" });
    cleanups.push(() => reopened.close());
    await expect(new SqlitePrdMissionStore(reopened).pendingDispatches(1)).resolves.toEqual([expect.objectContaining({ attemptId: row.attemptId, status: "pending" })]);
  });

  it("durably blocks a capability-mismatched bound Runner without selecting another Runner", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-e2e-capability-runner-"));
    const daemon = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client = makeTestClient(pki, daemon.port, pki.clientFor("runner-bound"));
    cleanups.push(async () => {
      await client.close();
      await daemon.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });
    await client.connect(makeHello("runner-bound"));
    await daemon.server.waitForConnection("runner-bound");
    const row = dispatch({ requiredCapabilities: [WEB_TARGET_TOKEN, UNSUPPORTED_TOKEN] });
    const seeded = await seedDispatchStore(row);
    const loop = new MissionDispatchLoop({
      tenantId: "tenant-a",
      repository: seeded.store,
      runners: { connectionFor: async ({ runnerId }) => daemon.server.connection(runnerId) === undefined ? undefined : connectionFor(row, [WEB_TARGET_TOKEN]) },
      leases: { lease: async () => undefined },
      clock: { now: () => "2026-08-24T00:00:01.000Z" },
    });

    await expect(loop.runOnce()).resolves.toMatchObject({ pending: 0, blocked: 1, accepted: 0, results: [{ outcome: "blocked", reason: "capability_mismatch" }] });
    await expect(seeded.store.pendingDispatches(1)).resolves.toEqual([]);
    await expect(dispatchState(seeded.runtime, row.attemptId)).resolves.toEqual({ outbox: "blocked", attempt: "blocked" });
  });
});

function dispatch(overrides: Partial<PendingMissionDispatch> = {}): PendingMissionDispatch {
  const job = webJob({
    jobId: "runner-job-bound",
    runId: "run-bound",
    policy: { ...webJob().policy, issuedAt: "2026-08-24T00:00:00.000Z", expiresAt: "2026-08-24T00:01:00.000Z" },
    plan: {
      missionId: "mission-bound",
      missionRevision: 1,
      testCaseId: "case-bound",
      steps: [{ kind: "click", target: { role: "button", name: "Add to cart", purpose: "add item" } }],
      expectedClaimIds: ["claim-bound"],
      budget: { maximumStepsPerJob: 1, maximumWallClockMs: 60_000, maximumModelTokens: 1_000 },
    },
  }) as AcceptedMissionExecutionJob;
  return {
    attemptId: "attempt-bound",
    missionId: "mission-bound",
    runnerId: "runner-bound",
    runnerJobId: job.jobId,
    runId: job.runId,
    requiredCapabilities: [WEB_TARGET_TOKEN],
    job,
    status: "pending",
    version: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

function connectionFor(row: PendingMissionDispatch, capabilities: readonly string[]): MissionDispatchRunnerConnection {
  return {
    authenticatedRunner: { runnerId: row.runnerId, scope: { kind: "tenant", tenantId: "tenant-a", projectIds: [row.job.projectId] }, capabilities },
    offer: async () => { throw new Error("capability mismatch must block before offer"); },
  };
}

async function seedDispatchStore(row: PendingMissionDispatch): Promise<{ readonly filename: string; readonly runtime: SqliteRuntime; readonly store: SqlitePrdMissionStore }> {
  const directory = await mkdtemp(join(tmpdir(), "qualigence-e2e-dispatch-store-"));
  const filename = join(directory, "qualigence.db");
  const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
  cleanups.push(async () => {
    await runtime.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.db.insertInto("missions").values({ mission_id: row.missionId, revision: 1, project_id: row.job.projectId, plan_id: "plan-bound", prd_id: "prd-bound", prd_revision: 1, target_id: "target-bound", compiled_hash: "compiled-bound", status: "running", dispatch_json: "{}", stop_on_blocked: 1 }).execute();
  await runtime.db.insertInto("execution_jobs").values({ job_id: "logical-bound", mission_id: row.missionId, mission_revision: 1, test_case_id: row.job.plan?.testCaseId ?? "case-bound", objective: row.job.objective, required_capabilities_json: JSON.stringify(row.requiredCapabilities), source_refs_json: "[]", snapshot_hash: "snapshot-bound", snapshot_json: JSON.stringify({ id: row.job.plan?.testCaseId ?? "case-bound" }), idempotency_key: "logical-bound", status: "queued" }).execute();
  await runtime.db.insertInto("execution_runs").values({ run_id: row.runId, job_id: row.runnerJobId, target_kind: "web", objective: row.job.objective, status: "running", next_sequence_number: 0, created_at: row.createdAt, completed_at: null, error_code: null }).execute();
  await runtime.db.insertInto("mission_job_attempts").values({ attempt_id: row.attemptId, mission_id: row.missionId, mission_revision: 1, logical_job_id: "logical-bound", runner_job_id: row.runnerJobId, run_id: row.runId, status: "pending_dispatch", created_at: row.createdAt }).execute();
  await runtime.db.insertInto("runner_execution_jobs").values({ runner_job_id: row.runnerJobId, attempt_id: row.attemptId, runner_id: row.runnerId, accepted_job_json: JSON.stringify(row.job), accepted_job_hash: canonicalPayloadHash(row.job), created_at: row.createdAt }).execute();
  await runtime.db.insertInto("mission_dispatch_outbox").values({ attempt_id: row.attemptId, mission_id: row.missionId, runner_id: row.runnerId, runner_job_id: row.runnerJobId, run_id: row.runId, idempotency_key: "dispatch-bound", required_capabilities_json: JSON.stringify(row.requiredCapabilities), accepted_job_json: JSON.stringify(row.job), status: "pending", version: row.version, accepted_at: null, acceptance_receipt_json: null, created_at: row.createdAt }).execute();
  return { filename, runtime, store: new SqlitePrdMissionStore(runtime) };
}

async function dispatchState(runtime: SqliteRuntime, attemptId: string): Promise<{ readonly outbox: string; readonly attempt: string }> {
  const outbox = await runtime.db.selectFrom("mission_dispatch_outbox").select("status").where("attempt_id", "=", attemptId).executeTakeFirstOrThrow();
  const attempt = await runtime.db.selectFrom("mission_job_attempts").select("status").where("attempt_id", "=", attemptId).executeTakeFirstOrThrow();
  return { outbox: outbox.status, attempt: attempt.status };
}
