import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalPayloadHash,
  canonicalTraceEventHash,
  type AcceptedExecutionJob,
  type ExecutionCompletion,
  type TraceEvent,
  type TraceEventHashInput,
} from "@qualigence/runner-protocol";
import {
  createPostgresRuntime,
  OperationScopedPostgresRunnerControlStore,
  OperationScopedPostgresTraceStore,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";
import {
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";

const CREATED_AT = "2026-08-25T00:00:00.000Z";
const CHECKED_AT = "2026-08-25T00:00:30.000Z";
const EXPIRES_AT = "2026-08-25T00:01:00.000Z";
const TENANT_ID = "tenant-e2e-run-trace-completion";

describe("Self-hosted Run Trace completion", () => {
  let fixture: PostgresFixture;
  let runtime: TenantTransactionProvider;

  beforeAll(async () => {
    if (!dockerAvailable()) {
      throw new Error("DockerUnavailable: PostgreSQL is required for self-hosted Run Trace completion acceptance");
    }
    fixture = await setupPostgresFixture();
    runtime = createPostgresRuntime(fixture.serverConfig);
  }, 180_000);

  afterAll(async () => {
    await runtime?.close();
    await fixture?.stop();
  });

  it("atomically persists Trace, Run, attempt, logical Job, and Mission terminal state", async () => {
    const seed = selfHostedAttempt("terminal");
    await seedAttempt(runtime, TENANT_ID, seed);

    const traceStore = new OperationScopedPostgresTraceStore(runtime, TENANT_ID);
    await expect(traceStore.appendTraceEvent(traceEvent(seed.job, 1))).resolves.toMatchObject({
      status: "accepted",
      nextSequenceNumber: 2,
    });

    const completionStore = new OperationScopedPostgresRunnerControlStore(runtime, TENANT_ID, {
      projectSelfHostedCompletion: true,
    });
    await completionStore.grantLease(lease(seed.job));

    await expect(completionStore.completeLease(completionInput(seed.job, passed(seed.job)))).resolves.toEqual({ outcome: "completed" });
    await expect(completionStore.completeLease(completionInput(seed.job, passed(seed.job)))).resolves.toEqual({ outcome: "duplicate" });

    await expect(traceStore.nextTraceSequenceNumber(seed.job.runId)).resolves.toBe(2);
    await expect(traceStore.eventAt(seed.job.runId, 1)).resolves.toMatchObject({
      runId: seed.job.runId,
      sequenceNumber: 1,
      stage: "observation",
    });
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
  }, 180_000);

  it("rolls back every terminal projection when the completion transaction fails", async () => {
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
  }, 180_000);
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

function selfHostedAttempt(name: string): SeededAttempt {
  const job = acceptedJob(name);
  return {
    tenantId: TENANT_ID,
    missionId: `mission-${name}`,
    missionRevision: 1,
    logicalJobId: `logical-${name}`,
    attemptId: `attempt-${name}`,
    runnerId: "runner-e2e",
    job,
    acceptedJobHash: canonicalPayloadHash(job),
  };
}

async function seedAttempt(provider: TenantTransactionProvider, tenantId: string, seed: SeededAttempt): Promise<void> {
  await provider.withTenant(tenantId, async ({ db }) => {
    await db.insertInto("missions").values({ tenant_id: tenantId, mission_id: seed.missionId, revision: seed.missionRevision, project_id: seed.job.projectId, plan_id: `plan-${seed.missionId}`, prd_id: `prd-${seed.missionId}`, prd_revision: 1, target_id: `target-${seed.missionId}`, compiled_hash: `compiled-${seed.missionId}`, status: "running", dispatch_json: "{}", stop_on_blocked: 1 } as never).execute();
    await db.insertInto("execution_jobs").values({ tenant_id: tenantId, job_id: seed.logicalJobId, mission_id: seed.missionId, mission_revision: seed.missionRevision, test_case_id: seed.job.plan?.testCaseId ?? `case-${seed.missionId}`, objective: seed.job.objective, required_capabilities_json: JSON.stringify(["target:web-playwright"]), source_refs_json: "[]", snapshot_hash: `snapshot-${seed.missionId}`, snapshot_json: JSON.stringify({ id: seed.job.plan?.testCaseId ?? `case-${seed.missionId}`, objective: seed.job.objective }), idempotency_key: `logical-${seed.missionId}`, status: "queued" } as never).execute();
    await db.insertInto("execution_runs").values({ tenant_id: tenantId, run_id: seed.job.runId, job_id: seed.job.jobId, target_kind: "web", objective: seed.job.objective, status: "running", next_sequence_number: 1, created_at: CREATED_AT, completed_at: null, error_code: null } as never).execute();
    await db.insertInto("mission_job_attempts").values({ tenant_id: tenantId, attempt_id: seed.attemptId, mission_id: seed.missionId, mission_revision: seed.missionRevision, logical_job_id: seed.logicalJobId, runner_job_id: seed.job.jobId, run_id: seed.job.runId, status: "accepted", created_at: CREATED_AT } as never).execute();
    await db.insertInto("runner_execution_jobs").values({ tenant_id: tenantId, runner_job_id: seed.job.jobId, attempt_id: seed.attemptId, runner_id: seed.runnerId, accepted_job_json: JSON.stringify(seed.job), accepted_job_hash: seed.acceptedJobHash, created_at: CREATED_AT } as never).execute();
    await db.insertInto("mission_execution_provenance").values({ tenant_id: tenantId, attempt_id: seed.attemptId, project_id: seed.job.projectId, mission_id: seed.missionId, mission_revision: seed.missionRevision, mission_compiled_hash: `compiled-${seed.missionId}`, mission_snapshot_json: JSON.stringify({ missionId: seed.missionId }), logical_job_id: seed.logicalJobId, test_case_snapshot_json: JSON.stringify({ id: seed.job.plan?.testCaseId ?? `case-${seed.missionId}`, objective: seed.job.objective }), test_case_snapshot_hash: `snapshot-${seed.missionId}`, plan_id: `plan-${seed.missionId}`, plan_version: 1, plan_snapshot_hash: `plan-hash-${seed.missionId}`, plan_snapshot_json: JSON.stringify({ planId: `plan-${seed.missionId}` }), target_id: `target-${seed.missionId}`, target_version: 1, target_snapshot_hash: `target-hash-${seed.missionId}`, target_snapshot_json: JSON.stringify({ targetId: `target-${seed.missionId}` }), runner_id: seed.runnerId, policy_json: JSON.stringify(seed.job.policy), policy_hash: canonicalPayloadHash(seed.job.policy), created_at: CREATED_AT } as never).execute();
  });
}

function lease(job: AcceptedExecutionJob) {
  return {
    job,
    owner: { runnerId: "runner-e2e", sessionId: "session-e2e" },
    leaseEpoch: 1,
    leaseTokenHash: "hash-lease-e2e",
    expiresAt: EXPIRES_AT,
  };
}

function completionInput(job: AcceptedExecutionJob, completion: ExecutionCompletion) {
  return {
    runId: job.runId,
    jobId: job.jobId,
    owner: { runnerId: "runner-e2e", sessionId: "session-e2e" },
    leaseEpoch: 1,
    leaseTokenHash: "hash-lease-e2e",
    checkedAt: CHECKED_AT,
    completion,
  };
}

function passed(job: AcceptedExecutionJob): ExecutionCompletion {
  return { jobId: job.jobId, runId: job.runId, status: "passed" };
}

function acceptedJob(name: string): AcceptedExecutionJob {
  return {
    jobId: `runner-job-${name}`,
    runId: `run-${name}`,
    projectId: `project-${name}`,
    target: { kind: "web", url: "https://example.test/" },
    objective: "verify checkout",
    policy: { policyId: "policy-e2e", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: CREATED_AT, expiresAt: EXPIRES_AT },
    plan: { missionId: `mission-${name}`, missionRevision: 1, testCaseId: `case-${name}`, steps: [{ kind: "navigate", path: "/checkout" }, { kind: "verify", claimIds: ["claim-1"] as [string] }], expectedClaimIds: ["claim-1"] as [string], budget: { maximumStepsPerJob: 2, maximumWallClockMs: 30_000, maximumModelTokens: 1_000 } },
  };
}

function traceEvent(job: AcceptedExecutionJob, sequenceNumber: number): TraceEvent {
  const input: TraceEventHashInput = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `trace-${job.runId}-${sequenceNumber}`,
    idempotencyKey: `trace-${job.runId}-${sequenceNumber}`,
    runId: job.runId,
    sequenceNumber,
    stage: "observation",
    occurredAt: CREATED_AT,
    payload: observationGraphV1(`graph-${job.runId}-${sequenceNumber}`),
  };
  return { ...input, payloadHash: canonicalTraceEventHash(input) } as TraceEvent;
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
