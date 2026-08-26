import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  canonicalPayloadHash,
  type AcceptedExecutionJob,
  type ExecutionCompletion,
} from "@qualigence/runner-protocol";
import {
  createPostgresRuntime,
  OperationScopedPostgresRunnerControlStore,
  type RuntimeStores,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { RunnerControlStoreError } from "@qualigence/runner-control";
import { dockerAvailable } from "../../helpers/docker-container.js";
import {
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";

const CREATED_AT = "2026-08-22T00:00:00.000Z";
const CHECKED_AT = "2026-08-22T00:00:30.000Z";
const EXPIRES_AT = "2026-08-22T00:01:00.000Z";
const TENANT_ID = "tenant-self-hosted-completion";

type CorruptProvenance = (stores: RuntimeStores, seed: SeededAttempt) => Promise<void>;

const mismatchedProvenanceCases: readonly [string, CorruptProvenance][] = [
  ["runner_execution_jobs.runner_job_id", async ({ db }, seed) => {
    await db.updateTable("runner_execution_jobs").set({ runner_job_id: `${seed.job.jobId}-mismatch` }).where("tenant_id", "=", seed.tenantId).where("attempt_id", "=", seed.attemptId).execute();
  }],
  ["runner_execution_jobs.runner_id", async ({ db }, seed) => {
    await db.updateTable("runner_execution_jobs").set({ runner_id: "runner-mismatch" }).where("tenant_id", "=", seed.tenantId).where("attempt_id", "=", seed.attemptId).execute();
  }],
  ["runner_execution_jobs.attempt_id", async (stores, seed) => {
    const alternateAttemptId = await insertAlternateAttempt(stores, seed, "runner-job-attempt");
    await stores.db.updateTable("runner_execution_jobs").set({ attempt_id: alternateAttemptId }).where("tenant_id", "=", seed.tenantId).where("runner_job_id", "=", seed.job.jobId).execute();
  }],
  ["execution_runs.job_id", async ({ db }, seed) => {
    await db.updateTable("execution_runs").set({ job_id: `${seed.job.jobId}-mismatch` }).where("tenant_id", "=", seed.tenantId).where("run_id", "=", seed.job.runId).execute();
  }],
  ["missions.project_id", async ({ db }, seed) => {
    await db.updateTable("missions").set({ project_id: `${seed.job.projectId}-mismatch` }).where("tenant_id", "=", seed.tenantId).where("mission_id", "=", seed.missionId).where("revision", "=", seed.missionRevision).execute();
  }],
  ["mission_execution_provenance.mission_id", async ({ db }, seed) => {
    await db.updateTable("mission_execution_provenance").set({ mission_id: `${seed.missionId}-mismatch` }).where("tenant_id", "=", seed.tenantId).where("attempt_id", "=", seed.attemptId).execute();
  }],
  ["mission_execution_provenance.mission_revision", async ({ db }, seed) => {
    await db.updateTable("mission_execution_provenance").set({ mission_revision: seed.missionRevision + 1 }).where("tenant_id", "=", seed.tenantId).where("attempt_id", "=", seed.attemptId).execute();
  }],
  ["mission_execution_provenance.logical_job_id", async ({ db }, seed) => {
    await db.updateTable("mission_execution_provenance").set({ logical_job_id: `${seed.logicalJobId}-mismatch` }).where("tenant_id", "=", seed.tenantId).where("attempt_id", "=", seed.attemptId).execute();
  }],
  ["mission_execution_provenance.runner_id", async ({ db }, seed) => {
    await db.updateTable("mission_execution_provenance").set({ runner_id: "runner-mismatch" }).where("tenant_id", "=", seed.tenantId).where("attempt_id", "=", seed.attemptId).execute();
  }],
  ["mission_execution_provenance.attempt_id", async (stores, seed) => {
    const alternateAttemptId = await insertAlternateAttempt(stores, seed, "provenance-attempt");
    await stores.db.updateTable("mission_execution_provenance").set({ attempt_id: alternateAttemptId }).where("tenant_id", "=", seed.tenantId).where("attempt_id", "=", seed.attemptId).execute();
  }],
];

describe.skipIf(!dockerAvailable())("Self-hosted Run completion projection", () => {
  let fixture: PostgresFixture;
  let runtime: TenantTransactionProvider;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
    runtime = createPostgresRuntime(fixture.serverConfig);
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await fixture?.stop();
  });

  it("atomically applies an accepted completion to Run, attempt, logical Job, and Mission", async () => {
    const seed = selfHostedAttempt("happy");
    await seedAttempt(runtime, TENANT_ID, seed);
    const store = projectedStore(runtime);
    await store.grantLease(lease(seed.job));

    await expect(store.completeLease(completionInput(seed.job, passed(seed.job)))).resolves.toEqual({ outcome: "completed" });

    await expect(snapshot(runtime, TENANT_ID, seed)).resolves.toEqual({
      runStatus: "passed",
      runCompletedAt: CHECKED_AT,
      runErrorCode: null,
      attemptStatus: "passed",
      logicalJobStatus: "completed",
      missionStatus: "completed",
      completions: 1,
      leaseCompletedAt: CHECKED_AT,
    });
  });

  it("replays the canonical completion without changing the terminal projection", async () => {
    const seed = selfHostedAttempt("duplicate");
    await seedAttempt(runtime, TENANT_ID, seed);
    const store = projectedStore(runtime);
    await store.grantLease(lease(seed.job));

    await expect(store.completeLease(completionInput(seed.job, passed(seed.job)))).resolves.toEqual({ outcome: "completed" });
    await expect(store.completeLease(completionInput(seed.job, passed(seed.job)))).resolves.toEqual({ outcome: "duplicate" });

    await expect(snapshot(runtime, TENANT_ID, seed)).resolves.toMatchObject({
      runStatus: "passed",
      attemptStatus: "passed",
      logicalJobStatus: "completed",
      missionStatus: "completed",
      completions: 1,
    });
  });

  it("rejects conflicting completion replay and preserves the original terminal state", async () => {
    const seed = selfHostedAttempt("conflict");
    await seedAttempt(runtime, TENANT_ID, seed);
    const store = projectedStore(runtime);
    await store.grantLease(lease(seed.job));
    await store.completeLease(completionInput(seed.job, passed(seed.job)));

    await expect(store.completeLease(completionInput(seed.job, { jobId: seed.job.jobId, runId: seed.job.runId, status: "error", errorCode: "RunnerCrashed" }))).resolves.toMatchObject({ outcome: "completion_conflict" });

    await expect(snapshot(runtime, TENANT_ID, seed)).resolves.toMatchObject({
      runStatus: "passed",
      runErrorCode: null,
      attemptStatus: "passed",
      logicalJobStatus: "completed",
      missionStatus: "completed",
      completions: 1,
    });
  });

  it("rolls back the completion and all projections when the accepted-job hash does not match", async () => {
    const seed = selfHostedAttempt("bad-hash", { acceptedJobHash: "0".repeat(64) });
    await expectCompletionRejectedWithoutWrites(runtime, seed);
  });

  it.each(mismatchedProvenanceCases)("rolls back the completion and all projections when %s does not match", async (_name, corrupt) => {
    const seed = selfHostedAttempt(`mismatch-${_name.replaceAll(".", "-")}`);
    await seedAttempt(runtime, TENANT_ID, seed);
    await runtime.withTenant(TENANT_ID, (stores) => corrupt(stores, seed));
    const store = projectedStore(runtime);
    await store.grantLease(lease(seed.job));

    await expect(store.completeLease(completionInput(seed.job, passed(seed.job)))).rejects.toBeInstanceOf(RunnerControlStoreError);

    await expect(snapshot(runtime, TENANT_ID, seed)).resolves.toEqual(runningSnapshot());
  });

  it("rolls back every linked terminal projection when a later write fails", async () => {
    const seed = selfHostedAttempt("rollback");
    await seedAttempt(runtime, TENANT_ID, seed);
    const store = new OperationScopedPostgresRunnerControlStore(runtime, TENANT_ID, {
      projectSelfHostedCompletion: true,
      failAfterCompletionProjectionWrite: 3,
    });
    await store.grantLease(lease(seed.job));

    await expect(store.completeLease(completionInput(seed.job, passed(seed.job)))).rejects.toThrow("InjectedSelfHostedCompletionFailureAfterWrite:3");

    await expect(snapshot(runtime, TENANT_ID, seed)).resolves.toEqual({
      runStatus: "running",
      runCompletedAt: null,
      runErrorCode: null,
      attemptStatus: "accepted",
      logicalJobStatus: "queued",
      missionStatus: "running",
      completions: 0,
      leaseCompletedAt: null,
    });
  });

  it("serializes concurrent terminal projections for different Runs in the same Mission", async () => {
    const first = selfHostedAttempt("concurrent-a", {
      missionId: "mission-concurrent",
      projectId: "project-concurrent",
    });
    const second = selfHostedAttempt("concurrent-b", {
      missionId: first.missionId,
      projectId: first.job.projectId,
    });
    await seedAttempt(runtime, TENANT_ID, first);
    await seedAdditionalAttempt(runtime, TENANT_ID, second);
    const store = projectedStore(runtime);
    await store.grantLease(lease(first.job));
    await store.grantLease(lease(second.job));

    const missionLocked = deferred();
    const releaseMission = deferred();
    const missionLock = runtime.withTenant(TENANT_ID, async ({ db }) => {
      await sql`
        select status
        from missions
        where tenant_id = ${TENANT_ID}
          and mission_id = ${first.missionId}
          and revision = ${first.missionRevision}
        for update
      `.execute(db);
      missionLocked.resolve();
      await releaseMission.promise;
    });
    await missionLocked.promise;

    const completions = Promise.all([
      store.completeLease(completionInput(first.job, passed(first.job))),
      store.completeLease(completionInput(second.job, passed(second.job))),
    ]);
    await delay(100);
    releaseMission.resolve();

    await expect(missionLock).resolves.toBeUndefined();
    await expect(completions).resolves.toEqual([{ outcome: "completed" }, { outcome: "completed" }]);
    await expect(snapshot(runtime, TENANT_ID, first)).resolves.toMatchObject({
      runStatus: "passed",
      attemptStatus: "passed",
      logicalJobStatus: "completed",
      missionStatus: "completed",
      completions: 1,
      leaseCompletedAt: CHECKED_AT,
    });
    await expect(snapshot(runtime, TENANT_ID, second)).resolves.toMatchObject({
      runStatus: "passed",
      attemptStatus: "passed",
      logicalJobStatus: "completed",
      missionStatus: "completed",
      completions: 1,
      leaseCompletedAt: CHECKED_AT,
    });
  });

  it("does not disclose or write a completion for a nonvisible tenant", async () => {
    const seed = selfHostedAttempt("tenant-hidden");
    await seedAttempt(runtime, "tenant-visible", seed);
    const hiddenStore = new OperationScopedPostgresRunnerControlStore(runtime, "tenant-hidden", { projectSelfHostedCompletion: true });

    await expect(hiddenStore.completeLease(completionInput(seed.job, passed(seed.job)))).resolves.toEqual({ outcome: "rejected" });
    await expect(snapshot(runtime, "tenant-visible", seed)).resolves.toMatchObject({
      runStatus: "running",
      attemptStatus: "accepted",
      logicalJobStatus: "queued",
      missionStatus: "running",
      completions: 0,
    });
  });
});

interface SeededAttempt {
  readonly tenantId: string;
  readonly missionId: string;
  readonly missionRevision: number;
  readonly logicalJobId: string;
  readonly attemptId: string;
  readonly runnerId: string;
  readonly job: AcceptedExecutionJob;
  readonly acceptedJobHash: string;
}

function projectedStore(provider: TenantTransactionProvider): OperationScopedPostgresRunnerControlStore {
  return new OperationScopedPostgresRunnerControlStore(provider, TENANT_ID, { projectSelfHostedCompletion: true });
}

function selfHostedAttempt(
  name: string,
  overrides: Partial<Pick<SeededAttempt, "acceptedJobHash" | "missionId" | "missionRevision">> & { readonly projectId?: string } = {},
): SeededAttempt {
  const missionId = overrides.missionId ?? `mission-${name}`;
  const missionRevision = overrides.missionRevision ?? 1;
  const job = acceptedJob(name, {
    missionId,
    missionRevision,
    projectId: overrides.projectId ?? `project-${name}`,
  });
  return {
    tenantId: TENANT_ID,
    missionId,
    missionRevision,
    logicalJobId: `logical-${name}`,
    attemptId: `attempt-${name}`,
    runnerId: "runner-1",
    job,
    acceptedJobHash: overrides.acceptedJobHash ?? canonicalPayloadHash(job),
  };
}

async function expectCompletionRejectedWithoutWrites(
  provider: TenantTransactionProvider,
  seed: SeededAttempt,
): Promise<void> {
  await seedAttempt(provider, TENANT_ID, seed);
  const store = projectedStore(provider);
  await store.grantLease(lease(seed.job));

  await expect(store.completeLease(completionInput(seed.job, passed(seed.job)))).rejects.toBeInstanceOf(RunnerControlStoreError);

  await expect(snapshot(provider, TENANT_ID, seed)).resolves.toEqual(runningSnapshot());
}

function runningSnapshot() {
  return {
    runStatus: "running",
    runCompletedAt: null,
    runErrorCode: null,
    attemptStatus: "accepted",
    logicalJobStatus: "queued",
    missionStatus: "running",
    completions: 0,
    leaseCompletedAt: null,
  };
}

async function insertAlternateAttempt(
  { db }: RuntimeStores,
  seed: SeededAttempt,
  suffix: string,
): Promise<string> {
  const logicalJobId = `${seed.logicalJobId}-${suffix}`;
  const runnerJobId = `${seed.job.jobId}-${suffix}`;
  const runId = `${seed.job.runId}-${suffix}`;
  const attemptId = `${seed.attemptId}-${suffix}`;
  await db.insertInto("execution_jobs").values({ tenant_id: seed.tenantId, job_id: logicalJobId, mission_id: seed.missionId, mission_revision: seed.missionRevision, test_case_id: `${seed.job.plan?.testCaseId ?? "case"}-${suffix}`, objective: seed.job.objective, required_capabilities_json: JSON.stringify(["target:web-playwright"]), source_refs_json: "[]", snapshot_hash: `snapshot-${attemptId}`, snapshot_json: JSON.stringify({ id: `${seed.job.plan?.testCaseId ?? "case"}-${suffix}`, objective: seed.job.objective }), idempotency_key: `logical-${attemptId}`, status: "queued" } as never).execute();
  await db.insertInto("execution_runs").values({ tenant_id: seed.tenantId, run_id: runId, job_id: runnerJobId, target_kind: "web", objective: seed.job.objective, status: "running", next_sequence_number: 1, created_at: CREATED_AT, completed_at: null, error_code: null } as never).execute();
  await db.insertInto("mission_job_attempts").values({ tenant_id: seed.tenantId, attempt_id: attemptId, mission_id: seed.missionId, mission_revision: seed.missionRevision, logical_job_id: logicalJobId, runner_job_id: runnerJobId, run_id: runId, status: "accepted", created_at: CREATED_AT } as never).execute();
  return attemptId;
}

async function seedAttempt(provider: TenantTransactionProvider, tenantId: string, seed: SeededAttempt): Promise<void> {
  await provider.withTenant(tenantId, async ({ db }) => {
    await db.insertInto("missions").values({ tenant_id: tenantId, mission_id: seed.missionId, revision: seed.missionRevision, project_id: seed.job.projectId, plan_id: `plan-${seed.missionId}`, prd_id: `prd-${seed.missionId}`, prd_revision: 1, target_id: `target-${seed.missionId}`, compiled_hash: `compiled-${seed.missionId}`, status: "running", dispatch_json: "{}", stop_on_blocked: 1 } as never).execute();
    await insertAttemptRows(db, tenantId, seed);
  });
}

async function seedAdditionalAttempt(provider: TenantTransactionProvider, tenantId: string, seed: SeededAttempt): Promise<void> {
  await provider.withTenant(tenantId, ({ db }) => insertAttemptRows(db, tenantId, seed));
}

async function insertAttemptRows(db: RuntimeStores["db"], tenantId: string, seed: SeededAttempt): Promise<void> {
  await db.insertInto("execution_jobs").values({ tenant_id: tenantId, job_id: seed.logicalJobId, mission_id: seed.missionId, mission_revision: seed.missionRevision, test_case_id: seed.job.plan?.testCaseId ?? `case-${seed.missionId}`, objective: seed.job.objective, required_capabilities_json: JSON.stringify(["target:web-playwright"]), source_refs_json: "[]", snapshot_hash: `snapshot-${seed.logicalJobId}`, snapshot_json: JSON.stringify({ id: seed.job.plan?.testCaseId ?? `case-${seed.logicalJobId}`, objective: seed.job.objective }), idempotency_key: `logical-${seed.logicalJobId}`, status: "queued" } as never).execute();
  await db.insertInto("execution_runs").values({ tenant_id: tenantId, run_id: seed.job.runId, job_id: seed.job.jobId, target_kind: "web", objective: seed.job.objective, status: "running", next_sequence_number: 1, created_at: CREATED_AT, completed_at: null, error_code: null } as never).execute();
  await db.insertInto("mission_job_attempts").values({ tenant_id: tenantId, attempt_id: seed.attemptId, mission_id: seed.missionId, mission_revision: seed.missionRevision, logical_job_id: seed.logicalJobId, runner_job_id: seed.job.jobId, run_id: seed.job.runId, status: "accepted", created_at: CREATED_AT } as never).execute();
  await db.insertInto("runner_execution_jobs").values({ tenant_id: tenantId, runner_job_id: seed.job.jobId, attempt_id: seed.attemptId, runner_id: seed.runnerId, accepted_job_json: JSON.stringify(seed.job), accepted_job_hash: seed.acceptedJobHash, created_at: CREATED_AT } as never).execute();
  await db.insertInto("mission_execution_provenance").values({ tenant_id: tenantId, attempt_id: seed.attemptId, project_id: seed.job.projectId, mission_id: seed.missionId, mission_revision: seed.missionRevision, mission_compiled_hash: `compiled-${seed.missionId}`, mission_snapshot_json: JSON.stringify({ missionId: seed.missionId }), logical_job_id: seed.logicalJobId, test_case_snapshot_json: JSON.stringify({ id: seed.job.plan?.testCaseId ?? `case-${seed.logicalJobId}`, objective: seed.job.objective }), test_case_snapshot_hash: `snapshot-${seed.logicalJobId}`, plan_id: `plan-${seed.missionId}`, plan_version: 1, plan_snapshot_hash: `plan-hash-${seed.missionId}`, plan_snapshot_json: JSON.stringify({ planId: `plan-${seed.missionId}` }), target_id: `target-${seed.missionId}`, target_version: 1, target_snapshot_hash: `target-hash-${seed.missionId}`, target_snapshot_json: JSON.stringify({ targetId: `target-${seed.missionId}` }), runner_id: seed.runnerId, policy_json: JSON.stringify(seed.job.policy), policy_hash: canonicalPayloadHash(seed.job.policy), created_at: CREATED_AT } as never).execute();
}

function lease(job: AcceptedExecutionJob) {
  return {
    job,
    owner: { runnerId: "runner-1", sessionId: "session-1" },
    leaseEpoch: 1,
    leaseTokenHash: "hash-lease-1",
    expiresAt: EXPIRES_AT,
  };
}

function completionInput(job: AcceptedExecutionJob, completion: ExecutionCompletion) {
  return {
    runId: job.runId,
    jobId: job.jobId,
    owner: { runnerId: "runner-1", sessionId: "session-1" },
    leaseEpoch: 1,
    leaseTokenHash: "hash-lease-1",
    checkedAt: CHECKED_AT,
    completion,
  };
}

function passed(job: AcceptedExecutionJob): ExecutionCompletion {
  return { jobId: job.jobId, runId: job.runId, status: "passed" };
}

function acceptedJob(
  name: string,
  overrides: { readonly missionId?: string; readonly missionRevision?: number; readonly projectId?: string } = {},
): AcceptedExecutionJob {
  return {
    jobId: `runner-job-${name}`,
    runId: `run-${name}`,
    projectId: overrides.projectId ?? `project-${name}`,
    target: { kind: "web", url: "https://example.test/" },
    objective: "verify checkout",
    policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: CREATED_AT, expiresAt: EXPIRES_AT },
    plan: { missionId: overrides.missionId ?? `mission-${name}`, missionRevision: overrides.missionRevision ?? 1, testCaseId: `case-${name}`, steps: [{ kind: "navigate", path: "/checkout" }, { kind: "verify", claimIds: ["claim-1"] as [string] }], expectedClaimIds: ["claim-1"] as [string], budget: { maximumStepsPerJob: 2, maximumWallClockMs: 30_000, maximumModelTokens: 1_000 } },
  };
}

async function snapshot(provider: TenantTransactionProvider, tenantId: string, seed: SeededAttempt) {
  return provider.withTenant(tenantId, async ({ db }) => {
    const run = await db.selectFrom("execution_runs").select(["status", "completed_at", "error_code"]).where("tenant_id", "=", tenantId).where("run_id", "=", seed.job.runId).executeTakeFirstOrThrow();
    const attempt = await db.selectFrom("mission_job_attempts").select("status").where("tenant_id", "=", tenantId).where("attempt_id", "=", seed.attemptId).executeTakeFirstOrThrow();
    const logicalJob = await db.selectFrom("execution_jobs").select("status").where("tenant_id", "=", tenantId).where("job_id", "=", seed.logicalJobId).executeTakeFirstOrThrow();
    const mission = await db.selectFrom("missions").select("status").where("tenant_id", "=", tenantId).where("mission_id", "=", seed.missionId).where("revision", "=", seed.missionRevision).executeTakeFirstOrThrow();
    const completions = await db.selectFrom("execution_completions").select((eb) => eb.fn.countAll<number>().as("count")).where("tenant_id", "=", tenantId).where("run_id", "=", seed.job.runId).executeTakeFirstOrThrow();
    const leaseRow = await db.selectFrom("execution_leases").select("completed_at").where("tenant_id", "=", tenantId).where("run_id", "=", seed.job.runId).executeTakeFirst();
    return {
      runStatus: run.status,
      runCompletedAt: run.completed_at,
      runErrorCode: run.error_code,
      attemptStatus: attempt.status,
      logicalJobStatus: logicalJob.status,
      missionStatus: mission.status,
      completions: Number(completions.count),
      leaseCompletedAt: leaseRow?.completed_at ?? null,
    };
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
