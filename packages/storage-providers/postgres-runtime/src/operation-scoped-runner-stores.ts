import type { TraceStore } from "@qualigence/evidence";
import type {
  CompleteLeaseResult,
  HashedResumeTokenRecord,
  PersistedExecutionLease,
  PersistedRunnerSession,
  ResumePresentedIdentity,
  ResumeTokenBinding,
  RotateResumeTokenInput,
  RotateResumeTokenResult,
  RunnerControlStore,
  RunnerCompletionRecord,
} from "@qualigence/runner-control";
import { RunnerControlStoreError } from "@qualigence/runner-control";
import {
  canonicalPayloadHash,
  parseExecutionJob,
  type ExecutionCompletion,
  type TraceEvent,
  type FindingEnvelope,
  type RunId,
} from "@qualigence/runner-protocol";
import { sql, type Transaction } from "kysely";
import type { PostgresDatabase } from "./postgres-database.js";
import type { TenantTransactionProvider } from "./tenant-transaction.js";
import { PostgresRunnerControlStore } from "./postgres-runner-control-store.js";
import {
  PostgresTraceStore,
  type PostgresTraceClock,
} from "./postgres-trace-store.js";

/**
 * Long-lived Runner-control store facade for Self-hosted composition. Each
 * method opens a fresh tenant-scoped PostgreSQL transaction and delegates to the
 * normal transaction-backed store inside that operation, so the Runner
 * application graph never retains a completed transaction or an unscoped store.
 */
export interface OperationScopedPostgresRunnerControlStoreOptions {
  /**
   * When enabled, a successful lease completion also atomically advances the
   * Mission scheduling projections in the same tenant transaction.
   */
  readonly projectSelfHostedCompletion?: boolean;
  /** Test-only failure hook for proving the projection transaction rolls back. */
  readonly failAfterCompletionProjectionWrite?: number;
}

export class OperationScopedPostgresRunnerControlStore implements RunnerControlStore {
  constructor(
    private readonly provider: TenantTransactionProvider,
    private readonly tenantId: string,
    private readonly options: OperationScopedPostgresRunnerControlStoreOptions = {},
  ) {}

  saveSession(record: PersistedRunnerSession): Promise<void> {
    return this.withStore((store) => store.saveSession(record));
  }

  closeSession(sessionId: string, closedAt: string): Promise<void> {
    return this.withStore((store) => store.closeSession(sessionId, closedAt));
  }

  issueResumeToken(record: HashedResumeTokenRecord): Promise<void> {
    return this.withStore((store) => store.issueResumeToken(record));
  }

  consumeResumeToken(input: {
    tokenHash: string;
    presented: ResumePresentedIdentity;
    consumedAt: string;
  }): Promise<ResumeTokenBinding | undefined> {
    return this.withStore((store) => store.consumeResumeToken(input));
  }

  rotateResumeToken(input: RotateResumeTokenInput): Promise<RotateResumeTokenResult | undefined> {
    return this.withStore((store) => store.rotateResumeToken(input));
  }

  grantLease(input: PersistedExecutionLease): Promise<"granted" | "already_exists"> {
    return this.withStore((store) => store.grantLease(input));
  }

  renewLease(input: {
    runId: string;
    jobId: string;
    owner: { readonly runnerId: string; readonly sessionId: string };
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    newExpiresAt: string;
  }): Promise<"renewed" | "rejected"> {
    return this.withStore((store) => store.renewLease(input));
  }

  completeLease(input: {
    runId: string;
    jobId: string;
    owner: { readonly runnerId: string; readonly sessionId: string };
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    completion: ExecutionCompletion;
  }): Promise<CompleteLeaseResult> {
    return this.provider.withTenant(this.tenantId, async ({ db }) => {
      const store = new PostgresRunnerControlStore(db, this.tenantId);
      const outcome = await store.completeLease(input);
      if (this.options.projectSelfHostedCompletion === true && (outcome.outcome === "completed" || outcome.outcome === "duplicate")) {
        const record = await store.completionRecord(input.runId);
        if (record === undefined) {
          throw new RunnerControlStoreError("persisted completion authority is unavailable", "CompletionIdentityMismatch");
        }
        await applySelfHostedCompletionProjection(db, this.tenantId, {
          runnerId: input.owner.runnerId,
          ...record,
        }, this.options.failAfterCompletionProjectionWrite);
      }
      return outcome;
    });
  }

  markLeaseLost(runId: string, lostAt: string): Promise<boolean> {
    return this.withStore((store) => store.markLeaseLost(runId, lostAt));
  }

  lease(runId: string): Promise<PersistedExecutionLease | undefined> {
    return this.withStore((store) => store.lease(runId));
  }

  completion(runId: string): Promise<ExecutionCompletion | undefined> {
    return this.withStore((store) => store.completion(runId));
  }

  completionRecord(runId: string): Promise<RunnerCompletionRecord | undefined> {
    return this.withStore((store) => store.completionRecord(runId));
  }

  private withStore<T>(operation: (store: PostgresRunnerControlStore) => Promise<T>): Promise<T> {
    return this.provider.withTenant(this.tenantId, ({ db }) =>
      operation(new PostgresRunnerControlStore(db, this.tenantId)),
    );
  }
}

/**
 * Long-lived Trace store facade matching {@link OperationScopedPostgresRunnerControlStore}:
 * every Trace/finding read or write opens a fresh tenant-scoped transaction.
 */
export class OperationScopedPostgresTraceStore implements TraceStore {
  constructor(
    private readonly provider: TenantTransactionProvider,
    private readonly tenantId: string,
    private readonly clock?: PostgresTraceClock,
  ) {}

  appendTraceEvent(event: TraceEvent): ReturnType<PostgresTraceStore["appendTraceEvent"]> {
    return this.withStore((store) => store.appendTraceEvent(event));
  }

  appendFinding(finding: FindingEnvelope, payloadHash: string): ReturnType<PostgresTraceStore["appendFinding"]> {
    return this.withStore((store) => store.appendFinding(finding, payloadHash));
  }

  eventAt(runId: RunId, sequenceNumber: number): Promise<TraceEvent | undefined> {
    return this.withStore((store) => store.eventAt(runId, sequenceNumber));
  }

  nextTraceSequenceNumber(runId: RunId): Promise<number> {
    return this.withStore((store) => store.nextTraceSequenceNumber(runId));
  }

  findingReferences(runId: RunId): Promise<readonly { readonly findingId: string; readonly createdAt: string }[]> {
    return this.withStore((store) => store.findingReferences(runId));
  }

  private withStore<T>(operation: (store: PostgresTraceStore) => Promise<T>): Promise<T> {
    return this.provider.withTenant(this.tenantId, ({ db }) =>
      operation(new PostgresTraceStore(db, this.tenantId, this.clock)),
    );
  }
}

interface CompletionProjectionInput extends RunnerCompletionRecord {
  readonly runnerId: string;
}

interface CompletionProjectionRow {
  readonly attempt_id: string;
  readonly attempt_logical_job_id: string;
  readonly attempt_runner_job_id: string;
  readonly attempt_mission_id: string;
  readonly attempt_mission_revision: number;
  readonly run_job_id: string;
  readonly logical_job_mission_id: string;
  readonly logical_job_mission_revision: number;
  readonly mission_project_id: string;
  readonly provenance_project_id: string;
  readonly provenance_mission_id: string;
  readonly provenance_mission_revision: number;
  readonly provenance_logical_job_id: string;
  readonly provenance_runner_id: string;
  readonly runner_job_id: string;
  readonly runner_job_attempt_id: string;
  readonly runner_id: string;
  readonly accepted_job_json: string;
  readonly accepted_job_hash: string;
  readonly run_status: string;
  readonly run_completed_at: string | null;
  readonly run_error_code: string | null;
  readonly attempt_status: string;
  readonly logical_job_status: string;
  readonly mission_status: string;
  readonly stop_on_blocked: number;
}

async function applySelfHostedCompletionProjection(
  db: Transaction<PostgresDatabase>,
  tenantId: string,
  input: CompletionProjectionInput,
  failAfterWrite?: number,
): Promise<void> {
  let writes = 0;
  const wrote = (): void => {
    writes += 1;
    if (writes === failAfterWrite) {
      throw new Error(`InjectedSelfHostedCompletionFailureAfterWrite:${writes}`);
    }
  };
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:self-hosted-completion:${input.runId}`}, 0))`.execute(db);

  const row = await loadCompletionProjectionRow(db, tenantId, input.runId, input.jobId);
  if (row === undefined) {
    throw new RunnerControlStoreError("Self-hosted completion provenance is not visible", "CompletionIdentityMismatch");
  }

  const acceptedJob = parseExecutionJob(JSON.parse(row.accepted_job_json));
  if (
    row.runner_id !== input.runnerId ||
    row.provenance_runner_id !== input.runnerId ||
    row.runner_job_id !== input.jobId ||
    row.runner_job_attempt_id !== row.attempt_id ||
    row.attempt_runner_job_id !== input.jobId ||
    row.run_job_id !== input.jobId ||
    row.accepted_job_hash !== input.jobSha256 ||
    canonicalPayloadHash(acceptedJob) !== input.jobSha256 ||
    acceptedJob.jobId !== input.jobId ||
    acceptedJob.runId !== input.runId ||
    acceptedJob.projectId !== row.provenance_project_id ||
    acceptedJob.projectId !== row.mission_project_id ||
    row.mission_project_id !== row.provenance_project_id ||
    acceptedJob.plan === undefined ||
    acceptedJob.plan.missionId !== row.attempt_mission_id ||
    acceptedJob.plan.missionId !== row.provenance_mission_id ||
    acceptedJob.plan.missionRevision !== row.attempt_mission_revision ||
    acceptedJob.plan.missionRevision !== row.provenance_mission_revision ||
    row.provenance_logical_job_id !== row.attempt_logical_job_id ||
    row.logical_job_mission_id !== row.attempt_mission_id ||
    row.logical_job_mission_revision !== row.attempt_mission_revision ||
    input.completion.jobId !== input.jobId ||
    input.completion.runId !== input.runId
  ) {
    throw new RunnerControlStoreError("Self-hosted completion identity does not match Mission provenance", "CompletionIdentityMismatch");
  }

  const runStatus = input.completion.status;
  const runErrorCode = input.completion.status === "blocked" || input.completion.status === "error"
    ? input.completion.errorCode ?? null
    : null;
  const attemptStatus = input.completion.status;
  const jobStatus = jobStatusForCompletion(input.completion.status);

  if (row.run_status !== "running" && !sameRunTerminal(row, runStatus, input.completedAt, runErrorCode)) {
    throw new RunnerControlStoreError("Self-hosted completion conflicts with the Run terminal projection", "CompletionIdentityMismatch");
  }
  if (isAttemptTerminal(row.attempt_status) && row.attempt_status !== attemptStatus) {
    throw new RunnerControlStoreError("Self-hosted completion conflicts with the attempt terminal projection", "CompletionIdentityMismatch");
  }
  if (isJobTerminal(row.logical_job_status) && row.logical_job_status !== jobStatus) {
    throw new RunnerControlStoreError("Self-hosted completion conflicts with the logical Job terminal projection", "CompletionIdentityMismatch");
  }
  if (row.attempt_status !== "accepted" && row.attempt_status !== attemptStatus) {
    throw new RunnerControlStoreError("Self-hosted completion attempt is not accepted", "CompletionIdentityMismatch");
  }

  const lockedMission = await lockMissionProjectionRow(
    db,
    tenantId,
    row.attempt_mission_id,
    row.attempt_mission_revision,
  );

  await db
    .updateTable("execution_runs")
    .set({ status: runStatus, completed_at: input.completedAt, error_code: runErrorCode })
    .where("tenant_id", "=", tenantId)
    .where("run_id", "=", input.runId)
    .where("status", "=", "running")
    .execute();
  wrote();

  await db
    .updateTable("mission_job_attempts")
    .set({ status: attemptStatus })
    .where("tenant_id", "=", tenantId)
    .where("attempt_id", "=", row.attempt_id)
    .where("status", "=", "accepted")
    .execute();
  wrote();

  await db
    .updateTable("execution_jobs")
    .set({ status: jobStatus })
    .where("tenant_id", "=", tenantId)
    .where("job_id", "=", row.attempt_logical_job_id)
    .where("status", "in", ["queued", "leased"])
    .execute();
  wrote();

  const missionStatus = await missionStatusAfterCompletion(
    db,
    tenantId,
    row.attempt_mission_id,
    row.attempt_mission_revision,
    lockedMission.stop_on_blocked === 1,
  );
  await db
    .updateTable("missions")
    .set({ status: missionStatus })
    .where("tenant_id", "=", tenantId)
    .where("mission_id", "=", row.attempt_mission_id)
    .where("revision", "=", row.attempt_mission_revision)
    .where("status", "=", "running")
    .execute();
  wrote();

  const refreshed = await loadCompletionProjectionRow(db, tenantId, input.runId, input.jobId);
  if (
    refreshed === undefined ||
    !sameRunTerminal(refreshed, runStatus, input.completedAt, runErrorCode) ||
    refreshed.attempt_status !== attemptStatus ||
    refreshed.logical_job_status !== jobStatus ||
    refreshed.mission_status !== missionStatus
  ) {
    throw new RunnerControlStoreError("Self-hosted completion projection was not persisted atomically", "CompletionIdentityMismatch");
  }
}

async function loadCompletionProjectionRow(
  db: Transaction<PostgresDatabase>,
  tenantId: string,
  runId: string,
  runnerJobId: string,
): Promise<CompletionProjectionRow | undefined> {
  return db
    .selectFrom("mission_job_attempts")
    .innerJoin("runner_execution_jobs", (join) =>
      join
        .onRef("runner_execution_jobs.tenant_id", "=", "mission_job_attempts.tenant_id")
        .onRef("runner_execution_jobs.attempt_id", "=", "mission_job_attempts.attempt_id"),
    )
    .innerJoin("mission_execution_provenance", (join) =>
      join
        .onRef("mission_execution_provenance.tenant_id", "=", "mission_job_attempts.tenant_id")
        .onRef("mission_execution_provenance.attempt_id", "=", "mission_job_attempts.attempt_id"),
    )
    .innerJoin("execution_runs", (join) =>
      join
        .onRef("execution_runs.tenant_id", "=", "mission_job_attempts.tenant_id")
        .onRef("execution_runs.run_id", "=", "mission_job_attempts.run_id"),
    )
    .innerJoin("execution_jobs", (join) =>
      join
        .onRef("execution_jobs.tenant_id", "=", "mission_job_attempts.tenant_id")
        .onRef("execution_jobs.job_id", "=", "mission_job_attempts.logical_job_id"),
    )
    .innerJoin("missions", (join) =>
      join
        .onRef("missions.tenant_id", "=", "mission_job_attempts.tenant_id")
        .onRef("missions.mission_id", "=", "mission_job_attempts.mission_id")
        .onRef("missions.revision", "=", "mission_job_attempts.mission_revision"),
    )
    .select([
      "mission_job_attempts.attempt_id as attempt_id",
      "mission_job_attempts.logical_job_id as attempt_logical_job_id",
      "mission_job_attempts.runner_job_id as attempt_runner_job_id",
      "mission_job_attempts.mission_id as attempt_mission_id",
      "mission_job_attempts.mission_revision as attempt_mission_revision",
      "execution_runs.job_id as run_job_id",
      "execution_jobs.mission_id as logical_job_mission_id",
      "execution_jobs.mission_revision as logical_job_mission_revision",
      "missions.project_id as mission_project_id",
      "mission_execution_provenance.project_id as provenance_project_id",
      "mission_execution_provenance.mission_id as provenance_mission_id",
      "mission_execution_provenance.mission_revision as provenance_mission_revision",
      "mission_execution_provenance.logical_job_id as provenance_logical_job_id",
      "mission_execution_provenance.runner_id as provenance_runner_id",
      "runner_execution_jobs.runner_job_id as runner_job_id",
      "runner_execution_jobs.attempt_id as runner_job_attempt_id",
      "runner_execution_jobs.runner_id as runner_id",
      "runner_execution_jobs.accepted_job_json as accepted_job_json",
      "runner_execution_jobs.accepted_job_hash as accepted_job_hash",
      "execution_runs.status as run_status",
      "execution_runs.completed_at as run_completed_at",
      "execution_runs.error_code as run_error_code",
      "mission_job_attempts.status as attempt_status",
      "execution_jobs.status as logical_job_status",
      "missions.status as mission_status",
      "missions.stop_on_blocked as stop_on_blocked",
    ])
    .where("mission_job_attempts.tenant_id", "=", tenantId)
    .where("mission_job_attempts.run_id", "=", runId)
    .where("mission_job_attempts.runner_job_id", "=", runnerJobId)
    .executeTakeFirst();
}

async function lockMissionProjectionRow(
  db: Transaction<PostgresDatabase>,
  tenantId: string,
  missionId: string,
  missionRevision: number,
): Promise<{ readonly status: string; readonly stop_on_blocked: number }> {
  const result = await sql<{ readonly status: string; readonly stop_on_blocked: number }>`
    select status, stop_on_blocked
    from missions
    where tenant_id = ${tenantId}
      and mission_id = ${missionId}
      and revision = ${missionRevision}
    for update
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw new RunnerControlStoreError("Self-hosted completion Mission projection is not visible", "CompletionIdentityMismatch");
  }
  return row;
}

async function missionStatusAfterCompletion(
  db: Transaction<PostgresDatabase>,
  tenantId: string,
  missionId: string,
  missionRevision: number,
  stopOnBlocked: boolean,
): Promise<"running" | "completed" | "blocked"> {
  const rows = await db
    .selectFrom("execution_jobs")
    .select("status")
    .where("tenant_id", "=", tenantId)
    .where("mission_id", "=", missionId)
    .where("mission_revision", "=", missionRevision)
    .execute();
  const statuses = rows.map((row) => row.status);
  const hasBlocked = statuses.some((status) => status === "blocked" || status === "failed");
  const allTerminal = statuses.every((status) => status === "completed" || status === "blocked" || status === "failed");
  if (hasBlocked && (stopOnBlocked || allTerminal)) return "blocked";
  if (allTerminal) return "completed";
  return "running";
}

function jobStatusForCompletion(status: ExecutionCompletion["status"]): "completed" | "blocked" | "failed" {
  switch (status) {
    case "passed":
    case "finding":
      return "completed";
    case "blocked":
      return "blocked";
    case "error":
      return "failed";
  }
}

function isAttemptTerminal(status: string): boolean {
  return status === "passed" || status === "finding" || status === "blocked" || status === "error";
}

function isJobTerminal(status: string): boolean {
  return status === "completed" || status === "blocked" || status === "failed";
}

function sameRunTerminal(
  row: Pick<CompletionProjectionRow, "run_status" | "run_completed_at" | "run_error_code">,
  status: ExecutionCompletion["status"],
  completedAt: string,
  errorCode: string | null,
): boolean {
  return row.run_status === status && row.run_completed_at === completedAt && row.run_error_code === errorCode;
}
