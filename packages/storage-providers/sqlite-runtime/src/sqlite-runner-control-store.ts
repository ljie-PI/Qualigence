import {
  RunnerControlStoreError,
} from "@qualigence/runner-control";
import { canonicalPayloadHash, parseExecutionJob } from "@qualigence/runner-protocol";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
} from "@qualigence/runner-protocol";
import type {
  CompleteLeaseResult,
  HashedResumeTokenRecord,
  PersistedExecutionLease,
  PersistedLeaseOwner,
  PersistedRunnerSession,
  ResumePresentedIdentity,
  ResumeTokenBinding,
  RotateResumeTokenInput,
  RotateResumeTokenResult,
  RunnerControlStore,
  RunnerCompletionRecord,
} from "@qualigence/runner-control";
import { leaseBindingMatches, observedCompletionResult } from "@qualigence/runner-control";
import type { Kysely, Transaction, UpdateQueryBuilder, UpdateResult } from "kysely";
import type { SqliteRuntime } from "./database.js";
import { isSqliteBusyError, mapBusyError } from "./errors.js";
import type { Database } from "./schema.js";

type RunnerControlDb = Kysely<Database> | Transaction<Database>;

export class SqliteRunnerControlStore implements RunnerControlStore {
  constructor(private readonly runtime: SqliteRuntime) {}

  async saveSession(record: PersistedRunnerSession): Promise<void> {
    await this.runtime.db
      .insertInto("runner_sessions")
      .values(sessionValues(record))
      .onConflict((oc) =>
        oc.column("session_id").doUpdateSet({
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
    await this.runtime.db
      .updateTable("runner_sessions")
      .set({ closed_at: closedAt })
      .where("session_id", "=", sessionId)
      .execute();
  }

  async issueResumeToken(record: HashedResumeTokenRecord): Promise<void> {
    await this.runtime.db
      .insertInto("runner_resume_tokens")
      .values({
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
    // Consumption is the atomic gate, so the presented identity must already
    // match the bound runner and expiry before the token row is consumed: a
    // mismatched or expired presentation never destroys the credential.
    return this.withWriteTransaction(async (db) => {
      const row = await db
        .updateTable("runner_resume_tokens")
        .set({ consumed_at: input.consumedAt })
        .where("token_hash", "=", input.tokenHash)
        .where("consumed_at", "is", null)
        .where("runner_id", "=", input.presented.runnerId)
        .where("certificate_fingerprint", "=", input.presented.certificateFingerprint)
        .where("protocol_major", "=", input.presented.protocolMajor)
        .where("expires_at", ">", input.consumedAt)
        .returning([
          "runner_id",
          "certificate_fingerprint",
          "previous_session_id",
          "protocol_major",
          "expires_at",
        ])
        .executeTakeFirst();
      return row === undefined ? undefined : toBinding(row);
    });
  }

  async rotateResumeToken(input: RotateResumeTokenInput): Promise<RotateResumeTokenResult | undefined> {
    return this.withWriteTransaction(async (db) => {
      const row = await db
        .selectFrom("runner_resume_tokens")
        .selectAll()
        .where("token_hash", "=", input.presentedTokenHash)
        .executeTakeFirst();
      if (
        row === undefined ||
        row.runner_id !== input.presented.runnerId ||
        row.certificate_fingerprint !== input.presented.certificateFingerprint ||
        row.protocol_major !== input.presented.protocolMajor
      ) {
        return undefined;
      }
      if (row.expires_at <= input.rotatedAt) {
        // The crash-replay window has closed: burn the credential.
        await db
          .updateTable("runner_resume_tokens")
          .set({ consumed_at: input.rotatedAt })
          .where("token_hash", "=", input.presentedTokenHash)
          .execute();
        return undefined;
      }
      if (row.consumed_at !== null) {
        const replacement = await db
          .selectFrom("runner_resume_tokens")
          .select("token_hash")
          .where("token_hash", "=", input.replacementTokenHash)
          .executeTakeFirst();
        return replacement === undefined
          ? undefined
          : { outcome: "idempotent_retry", binding: toBinding(row) };
      }
      await db
        .insertInto("runner_resume_tokens")
        .values({
          token_hash: input.replacementTokenHash,
          runner_id: row.runner_id,
          certificate_fingerprint: row.certificate_fingerprint,
          previous_session_id: row.previous_session_id,
          protocol_major: row.protocol_major,
          expires_at: input.replacementExpiresAt,
          consumed_at: null,
        })
        .onConflict((oc) => oc.column("token_hash").doNothing())
        .execute();
      const consumed = await db
        .updateTable("runner_resume_tokens")
        .set({ consumed_at: input.rotatedAt })
        .where("token_hash", "=", input.presentedTokenHash)
        .where("consumed_at", "is", null)
        .executeTakeFirst();
      if (consumed.numUpdatedRows === 0n) {
        return { outcome: "idempotent_retry", binding: toBinding(row) };
      }
      return { outcome: "rotated", binding: toBinding(row) };
    });
  }

  async grantLease(input: PersistedExecutionLease): Promise<"granted" | "already_exists"> {
    return this.withWriteTransaction(async (db) => {
      const inserted = await db
        .insertInto("execution_leases")
        .values(leaseValues(input))
        .onConflict((oc) => oc.column("run_id").doNothing())
        .returning("run_id")
        .executeTakeFirst();
      return inserted === undefined ? "already_exists" : "granted";
    });
  }

  async renewLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    newExpiresAt: string;
  }): Promise<"renewed" | "rejected"> {
    return this.withWriteTransaction(async (db) => {
      const row = await db
        .selectFrom("execution_leases")
        .select(["job_json"])
        .where("run_id", "=", input.runId)
        .executeTakeFirst();
      if (row !== undefined) parseJob(row.job_json);
      const result = await constrainLiveLease(
        db.updateTable("execution_leases").set({ expires_at: input.newExpiresAt }),
        input,
      ).executeTakeFirst();
      return result.numUpdatedRows > 0n ? "renewed" : "rejected";
    });
  }

  async completeLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    completion: ExecutionCompletion;
  }): Promise<CompleteLeaseResult> {
    return this.withWriteTransaction(async (db) => {
      const record = await db
        .selectFrom("execution_leases")
        .selectAll()
        .where("run_id", "=", input.runId)
        .executeTakeFirst();
      if (record === undefined) {
        return { outcome: "rejected" };
      }
      const bound = leaseBindingMatches(toLease(record), input);
      if (!bound) {
        return { outcome: "rejected" };
      }
      const existing = await readCompletion(db, input.runId);
      const observed = observedCompletionResult(existing, input.completion);
      if (observed !== undefined) {
        return observed;
      }
      if (!bound || record.expires_at <= input.checkedAt || record.completed_at !== null) {
        return { outcome: "rejected" };
      }
      const result = await constrainLiveLease(
        db.updateTable("execution_leases").set({ completed_at: input.checkedAt }),
        input,
      ).executeTakeFirst();
      if (result.numUpdatedRows === 0n) {
        const raced = await readCompletion(db, input.runId);
        return observedCompletionResult(raced, input.completion) ?? { outcome: "rejected" };
      }
      await db
        .insertInto("execution_completions")
        .values({
          run_id: input.runId,
          job_id: input.jobId,
          completion_json: JSON.stringify(input.completion),
          completed_at: input.checkedAt,
        })
        .execute();
      return { outcome: "completed" };
    });
  }

  async markLeaseLost(runId: string, lostAt: string): Promise<boolean> {
    const result = await this.runtime.db
      .updateTable("execution_leases")
      .set({ lost_at: lostAt })
      .where("run_id", "=", runId)
      .where("lost_at", "is", null)
      .where("completed_at", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async lease(runId: string): Promise<PersistedExecutionLease | undefined> {
    const row = await this.runtime.db
      .selectFrom("execution_leases")
      .selectAll()
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return row === undefined ? undefined : toLease(row);
  }

  async completion(runId: string): Promise<ExecutionCompletion | undefined> {
    return readCompletion(this.runtime.db, runId);
  }

  async completionRecord(runId: string): Promise<RunnerCompletionRecord | undefined> {
    const row = await this.runtime.db.selectFrom("execution_completions")
      .innerJoin("execution_leases", "execution_leases.run_id", "execution_completions.run_id")
      .select(["execution_completions.run_id", "execution_completions.job_id", "completion_json", "execution_completions.completed_at", "job_json"])
      .where("execution_completions.run_id", "=", runId).executeTakeFirst();
    if (row === undefined) return undefined;
    const job = parseJob(row.job_json);
    const completion = JSON.parse(row.completion_json) as ExecutionCompletion;
    if (job.runId !== row.run_id || job.jobId !== row.job_id || completion.runId !== row.run_id || completion.jobId !== row.job_id) throw new RunnerControlStoreError("persisted completion identity is inconsistent");
    return { runId: row.run_id, jobId: row.job_id, jobSha256: canonicalPayloadHash(job), completion, completedAt: row.completed_at };
  }

  private async withWriteTransaction<TResult>(
    operation: (db: Transaction<Database>) => Promise<TResult>,
  ): Promise<TResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.runtime.db.transaction().execute(operation);
      } catch (error) {
        if (!isSqliteBusyError(error) || attempt === 7) {
          throw isSqliteBusyError(error) ? mapBusyError(error) : error;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    throw new Error("Unreachable SQLite runner-control transaction retry state.");
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

function constrainLiveLease<TUpdate extends UpdateQueryBuilder<Database, "execution_leases", "execution_leases", UpdateResult>>(
  query: TUpdate,
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
  db: RunnerControlDb,
  runId: string,
): Promise<ExecutionCompletion | undefined> {
  const row = await db
    .selectFrom("execution_completions")
    .select("completion_json")
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
    job: parseJob(row.job_json),
    owner: { runnerId: row.runner_id, sessionId: row.session_id },
    leaseEpoch: row.lease_epoch,
    leaseTokenHash: row.lease_token_hash,
    expiresAt: row.expires_at,
    ...(row.lost_at === null ? {} : { lostAt: row.lost_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.recovery_of_run_id === null ? {} : { recoveryOfRunId: row.recovery_of_run_id }),
  };
}

function parseJob(jobJson: string): AcceptedExecutionJob {
  try {
    return parseExecutionJob(JSON.parse(jobJson));
  } catch {
    throw new RunnerControlStoreError();
  }
}
