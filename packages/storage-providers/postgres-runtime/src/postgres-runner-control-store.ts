import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
} from "@qualigence/runner-protocol";
import type {
  HashedResumeTokenRecord,
  PersistedExecutionLease,
  PersistedLeaseOwner,
  PersistedRunnerSession,
  ResumePresentedIdentity,
  ResumeTokenBinding,
  RunnerControlStore,
} from "@qualigence/runner-control";
import type { Kysely, UpdateQueryBuilder, UpdateResult } from "kysely";
import type { PostgresDatabase } from "./postgres-database.js";

export class PostgresRunnerControlStore implements RunnerControlStore {
  constructor(
    private readonly db: Kysely<PostgresDatabase>,
    private readonly tenantId: string,
  ) {}

  async saveSession(record: PersistedRunnerSession): Promise<void> {
    await this.db
      .insertInto("runner_sessions")
      .values({ tenant_id: this.tenantId, ...sessionValues(record) })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "session_id"]).doUpdateSet({
          runner_id: record.runnerId,
          certificate_fingerprint: record.certificateFingerprint,
          capabilities_json: JSON.stringify(record.capabilities),
          protocol_major: record.protocolMajor,
          closed_at: null,
        }),
      )
      .execute();
  }

  async closeSession(sessionId: string, closedAt: string): Promise<void> {
    await this.db
      .updateTable("runner_sessions")
      .set({ closed_at: closedAt })
      .where("tenant_id", "=", this.tenantId)
      .where("session_id", "=", sessionId)
      .execute();
  }

  async issueResumeToken(record: HashedResumeTokenRecord): Promise<void> {
    await this.db
      .insertInto("runner_resume_tokens")
      .values({
        tenant_id: this.tenantId,
        token_hash: record.tokenHash,
        runner_id: record.binding.runnerId,
        certificate_fingerprint: record.binding.certificateFingerprint,
        previous_session_id: record.binding.previousSessionId,
        protocol_major: record.binding.protocolMajor,
        expires_at: record.expiresAt,
        consumed_at: null,
      })
      .execute();
  }

  async consumeResumeToken(input: {
    tokenHash: string;
    presented: ResumePresentedIdentity;
    consumedAt: string;
  }): Promise<ResumeTokenBinding | undefined> {
    const row = await this.db
      .updateTable("runner_resume_tokens")
      .set({ consumed_at: input.consumedAt })
      .where("tenant_id", "=", this.tenantId)
      .where("token_hash", "=", input.tokenHash)
      .where("consumed_at", "is", null)
      .returning([
        "runner_id",
        "certificate_fingerprint",
        "previous_session_id",
        "protocol_major",
        "expires_at",
      ])
      .executeTakeFirst();
    return row !== undefined &&
      row.expires_at > input.consumedAt &&
      row.runner_id === input.presented.runnerId &&
      row.certificate_fingerprint === input.presented.certificateFingerprint &&
      row.protocol_major === input.presented.protocolMajor
      ? toBinding(row)
      : undefined;
  }

  async grantLease(input: PersistedExecutionLease): Promise<"granted" | "already_exists"> {
    const inserted = await this.db
      .insertInto("execution_leases")
      .values({ tenant_id: this.tenantId, ...leaseValues(input) })
      .onConflict((oc) => oc.columns(["tenant_id", "run_id"]).doNothing())
      .returning("run_id")
      .executeTakeFirst();
    return inserted === undefined ? "already_exists" : "granted";
  }

  async renewLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    newExpiresAt: string;
  }): Promise<boolean> {
    const result = await constrainLiveLease(
      this.db.updateTable("execution_leases").set({ expires_at: input.newExpiresAt }),
      this.tenantId,
      input,
    ).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async completeLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    completion: ExecutionCompletion;
  }): Promise<"completed" | "duplicate" | "rejected"> {
    const existing = await readCompletion(this.db, this.tenantId, input.runId);
    if (existing !== undefined) {
      return canonicalPayloadHash(existing) === canonicalPayloadHash(input.completion)
        ? "duplicate"
        : "rejected";
    }
    const result = await constrainLiveLease(
      this.db.updateTable("execution_leases").set({ completed_at: input.checkedAt }),
      this.tenantId,
      input,
    ).executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      const raced = await readCompletion(this.db, this.tenantId, input.runId);
      return raced !== undefined &&
        canonicalPayloadHash(raced) === canonicalPayloadHash(input.completion)
        ? "duplicate"
        : "rejected";
    }
    await this.db
      .insertInto("execution_completions")
      .values({
        tenant_id: this.tenantId,
        run_id: input.runId,
        job_id: input.jobId,
        completion_json: JSON.stringify(input.completion),
        completed_at: input.checkedAt,
      })
      .execute();
    return "completed";
  }

  async markLeaseLost(runId: string, lostAt: string): Promise<boolean> {
    const result = await this.db
      .updateTable("execution_leases")
      .set({ lost_at: lostAt })
      .where("tenant_id", "=", this.tenantId)
      .where("run_id", "=", runId)
      .where("lost_at", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async lease(runId: string): Promise<PersistedExecutionLease | undefined> {
    const row = await this.db
      .selectFrom("execution_leases")
      .selectAll()
      .where("tenant_id", "=", this.tenantId)
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return row === undefined ? undefined : toLease(row);
  }

  async completion(runId: string): Promise<ExecutionCompletion | undefined> {
    return readCompletion(this.db, this.tenantId, runId);
  }
}

function sessionValues(record: PersistedRunnerSession) {
  return {
    session_id: record.sessionId,
    runner_id: record.runnerId,
    certificate_fingerprint: record.certificateFingerprint,
    capabilities_json: JSON.stringify(record.capabilities),
    protocol_major: record.protocolMajor,
    created_at: record.createdAt,
    closed_at: null,
  };
}

function leaseValues(input: PersistedExecutionLease) {
  return {
    run_id: input.job.runId,
    job_id: input.job.jobId,
    runner_id: input.owner.runnerId,
    session_id: input.owner.sessionId,
    lease_epoch: input.leaseEpoch,
    job_json: JSON.stringify(input.job),
    lease_token_hash: input.leaseTokenHash,
    expires_at: input.expiresAt,
    lost_at: input.lostAt ?? null,
    completed_at: input.completedAt ?? null,
    recovery_of_run_id: input.recoveryOfRunId ?? null,
  };
}

function constrainLiveLease<
  TUpdate extends UpdateQueryBuilder<
    PostgresDatabase,
    "execution_leases",
    "execution_leases",
    UpdateResult
  >,
>(
  query: TUpdate,
  tenantId: string,
  input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
  },
): TUpdate {
  return query
    .where("tenant_id", "=", tenantId)
    .where("run_id", "=", input.runId)
    .where("job_id", "=", input.jobId)
    .where("runner_id", "=", input.owner.runnerId)
    .where("session_id", "=", input.owner.sessionId)
    .where("lease_epoch", "=", input.leaseEpoch)
    .where("lease_token_hash", "=", input.leaseTokenHash)
    .where("lost_at", "is", null)
    .where("completed_at", "is", null)
    .where("expires_at", ">", input.checkedAt) as TUpdate;
}

async function readCompletion(
  db: Kysely<PostgresDatabase>,
  tenantId: string,
  runId: string,
): Promise<ExecutionCompletion | undefined> {
  const row = await db
    .selectFrom("execution_completions")
    .select("completion_json")
    .where("tenant_id", "=", tenantId)
    .where("run_id", "=", runId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : (JSON.parse(row.completion_json) as ExecutionCompletion);
}

function toBinding(row: {
  runner_id: string;
  certificate_fingerprint: string;
  previous_session_id: string;
  protocol_major: number;
}): ResumeTokenBinding {
  return {
    runnerId: row.runner_id,
    certificateFingerprint: row.certificate_fingerprint,
    previousSessionId: row.previous_session_id,
    protocolMajor: row.protocol_major,
  };
}

function toLease(row: {
  job_json: string;
  runner_id: string;
  session_id: string;
  lease_epoch: number;
  lease_token_hash: string;
  expires_at: string;
  lost_at: string | null;
  completed_at: string | null;
  recovery_of_run_id: string | null;
}): PersistedExecutionLease {
  return {
    job: JSON.parse(row.job_json) as AcceptedExecutionJob,
    owner: { runnerId: row.runner_id, sessionId: row.session_id },
    leaseEpoch: row.lease_epoch,
    leaseTokenHash: row.lease_token_hash,
    expiresAt: row.expires_at,
    ...(row.lost_at === null ? {} : { lostAt: row.lost_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.recovery_of_run_id === null ? {} : { recoveryOfRunId: row.recovery_of_run_id }),
  };
}
