import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { IntelligenceJob, IntelligenceResult } from "@qualigence/intelligence";
import type { PostgresConnectionConfig } from "./postgres-runtime.js";

const { Pool } = pg;

export type IntelligenceQueueErrorCode =
  | "LeaseNotActive"
  | "LeaseTokenMismatch"
  | "LeaseExpired"
  | "BaseVersionMismatch"
  | "WorkerMismatch"
  | "JobMismatch"
  | "IdempotencyConflict";

export class IntelligenceQueueError extends Error {
  readonly code: IntelligenceQueueErrorCode;

  constructor(code: IntelligenceQueueErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "IntelligenceQueueError";
    this.code = code;
  }
}

export interface IntelligenceJobLease {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly workerId: string;
  readonly expiresAt: string;
  readonly attempt: number;
}

export interface LeaseInput {
  readonly workerId: string;
  readonly acceptedTypes: readonly IntelligenceJob["jobType"][];
  readonly now: string;
  readonly leaseDurationMs: number;
}

export interface RenewInput {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly workerId: string;
  readonly now: string;
  readonly leaseDurationMs: number;
}

export interface AppendResultInput {
  readonly tenantId: string;
  readonly jobId: string;
  readonly leaseToken: string;
  readonly leaseAttempt: number;
  readonly workerId: string;
  readonly baseAggregateVersion: number;
  readonly result: IntelligenceResult;
}

export type AppendDisposition = "accepted" | "duplicate";
export type TransactionGuard = (transaction: pg.PoolClient) => Promise<void>;

interface LeaseRow {
  readonly tenant_id: string;
  readonly job_id: string;
  readonly attempt: number;
  readonly worker_id: string;
  readonly lease_token_hash: string;
  readonly expires_at: string;
  readonly released_at: string | null;
  readonly completed_at: string | null;
}

interface ExistingInboxRow {
  readonly job_id: string;
  readonly worker_id: string;
  readonly lease_attempt: number;
  readonly lease_token_hash: string;
  readonly base_aggregate_version: number;
  readonly result_hash: string;
  readonly result_json: string;
}

interface JobRow {
  readonly job_json: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashResult(result: IntelligenceResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

function expiresAt(now: string, leaseDurationMs: number): string {
  return new Date(Date.parse(now) + leaseDurationMs).toISOString();
}

/**
 * Durable PostgreSQL Intelligence work queue. Leases are committed rows bound to
 * tenant, job, worker, attempt and lease-token hash; the raw token is returned
 * only to the Worker. A Result append revalidates that durable fence in the
 * same transaction that records inbox metadata and the Server-consumed proposal
 * row. The Worker role receives no aggregate-table grants.
 */
export class PostgresIntelligenceQueue {
  private readonly pool: pg.Pool;
  private readonly transactionGuard: TransactionGuard;

  constructor(
    config: PostgresConnectionConfig,
    transactionGuard?: TransactionGuard,
  ) {
    if (transactionGuard === undefined) {
      throw new Error("PostgresIntelligenceQueue requires an explicit transaction guard");
    }
    this.transactionGuard = transactionGuard;
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.max ?? 8,
    });
  }

  async lease(
    input: LeaseInput,
  ): Promise<{ readonly job: IntelligenceJob; readonly lease: IntelligenceJobLease } | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.transactionGuard(client);
      const selected = await client.query<JobRow>(
        "select job_json from worker_lock_intelligence_job($1::text[], $2::text)",
        [[...input.acceptedTypes], input.now],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        await client.query("commit");
        return undefined;
      }

      const job = JSON.parse(row.job_json) as IntelligenceJob;
      await client.query(
        `update intelligence_leases
            set released_at = $1
          where tenant_id = $2
            and job_id = $3
            and released_at is null
            and completed_at is null
            and expires_at <= $1`,
        [input.now, job.tenantId, job.jobId],
      );
      const attempt = await this.nextAttempt(client, job.tenantId, job.jobId);
      const leaseToken = randomUUID();
      const leaseTokenHash = hashToken(leaseToken);
      const leaseExpiresAt = expiresAt(input.now, input.leaseDurationMs);
      await client.query(
        `insert into intelligence_leases
           (tenant_id, job_id, attempt, worker_id, lease_token_hash, lease_started_at,
            expires_at, last_renewed_at, renewal_count, released_at, completed_at)
         values ($1,$2,$3,$4,$5,$6,$7,null,0,null,null)`,
        [
          job.tenantId,
          job.jobId,
          attempt,
          input.workerId,
          leaseTokenHash,
          input.now,
          leaseExpiresAt,
        ],
      );
      await client.query("commit");
      return {
        job,
        lease: {
          jobId: job.jobId,
          leaseToken,
          workerId: input.workerId,
          expiresAt: leaseExpiresAt,
          attempt,
        },
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async renew(input: RenewInput): Promise<IntelligenceJobLease> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.transactionGuard(client);
      const leaseTokenHash = hashToken(input.leaseToken);
      const nextExpiresAt = expiresAt(input.now, input.leaseDurationMs);
      const renewed = await client.query<LeaseRow>(
        `update intelligence_leases
            set expires_at = $1,
                last_renewed_at = $2,
                renewal_count = renewal_count + 1
          where job_id = $3
            and worker_id = $4
            and lease_token_hash = $5
            and released_at is null
            and completed_at is null
            and expires_at > $2
          returning tenant_id, job_id, attempt, worker_id, lease_token_hash, expires_at, released_at, completed_at`,
        [nextExpiresAt, input.now, input.jobId, input.workerId, leaseTokenHash],
      );
      const row = renewed.rows[0];
      if (row === undefined) {
        await client.query("rollback");
        throw await this.classifyLeaseFailure(client, {
          tenantId: undefined,
          jobId: input.jobId,
          workerId: input.workerId,
          leaseAttempt: undefined,
          leaseTokenHash,
          checkedAt: input.now,
        });
      }
      await client.query("commit");
      return {
        jobId: input.jobId,
        leaseToken: input.leaseToken,
        workerId: input.workerId,
        expiresAt: row.expires_at,
        attempt: row.attempt,
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async append(input: AppendResultInput): Promise<{ readonly disposition: AppendDisposition }> {
    if (input.result.jobId !== input.jobId) {
      throw new IntelligenceQueueError("JobMismatch", "result job id does not match append job id");
    }

    const client = await this.pool.connect();
    const leaseTokenHash = hashToken(input.leaseToken);
    const resultJson = JSON.stringify(input.result);
    const resultHash = hashResult(input.result);
    const acceptedAt = new Date().toISOString();
    try {
      await client.query("begin");
      await this.transactionGuard(client);

      const existingDisposition = await this.existingDisposition(client, input, resultHash, resultJson);
      if (existingDisposition !== undefined) {
        await client.query("commit");
        return { disposition: existingDisposition };
      }

      const lease = await this.requireAppendLease(client, {
        tenantId: input.tenantId,
        jobId: input.jobId,
        workerId: input.workerId,
        leaseAttempt: input.leaseAttempt,
        leaseTokenHash,
        baseAggregateVersion: input.baseAggregateVersion,
        checkedAt: acceptedAt,
      });

      const inserted = await client.query<{ idempotency_key: string }>(
        `insert into intelligence_result_inbox
           (tenant_id, idempotency_key, job_id, worker_id, lease_attempt, lease_token_hash,
            lease_expires_at, base_aggregate_version, result_hash, result_json, accepted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (tenant_id, idempotency_key) do nothing
         returning idempotency_key`,
        [
          input.tenantId,
          input.result.idempotencyKey,
          input.jobId,
          input.workerId,
          input.leaseAttempt,
          leaseTokenHash,
          lease.expires_at,
          input.baseAggregateVersion,
          resultHash,
          resultJson,
          acceptedAt,
        ],
      );

      if (inserted.rowCount === 0) {
        const disposition = await this.existingDisposition(client, input, resultHash, resultJson);
        if (disposition === undefined) {
          throw new IntelligenceQueueError("IdempotencyConflict", "idempotency key was claimed concurrently");
        }
        await client.query("commit");
        return { disposition };
      }

      await client.query(
        `insert into intelligence_results
           (tenant_id, idempotency_key, job_id, terminal_status, confidence, result_json, created_at)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, idempotency_key) do nothing`,
        [
          input.tenantId,
          input.result.idempotencyKey,
          input.result.jobId,
          input.result.terminalStatus,
          input.result.confidence,
          resultJson,
          acceptedAt,
        ],
      );

      await client.query(
        `update intelligence_leases
            set completed_at = $1
          where tenant_id = $2
            and job_id = $3
            and attempt = $4
            and completed_at is null`,
        [acceptedAt, input.tenantId, input.jobId, input.leaseAttempt],
      );
      await client.query("commit");
      return { disposition: "accepted" };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async abandon(jobId: string): Promise<void> {
    const client = await this.pool.connect();
    const releasedAt = new Date().toISOString();
    try {
      await client.query("begin");
      await this.transactionGuard(client);
      await client.query(
        `update intelligence_leases
            set released_at = $1
          where job_id = $2
            and released_at is null
            and completed_at is null`,
        [releasedAt, jobId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async nextAttempt(client: pg.PoolClient, tenantId: string, jobId: string): Promise<number> {
    const row = await client.query<{ attempt: number }>(
      `select coalesce(max(attempt), 0)::int + 1 as attempt
         from intelligence_leases
        where tenant_id = $1
          and job_id = $2`,
      [tenantId, jobId],
    );
    return row.rows[0]?.attempt ?? 1;
  }

  private async existingDisposition(
    client: pg.PoolClient,
    input: AppendResultInput,
    resultHash: string,
    resultJson: string,
  ): Promise<AppendDisposition | undefined> {
    const existing = await client.query<ExistingInboxRow>(
      `select job_id, worker_id, lease_attempt, lease_token_hash, base_aggregate_version,
              result_hash, result_json
         from intelligence_result_inbox
        where tenant_id = $1
          and idempotency_key = $2
        limit 1`,
      [input.tenantId, input.result.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      return undefined;
    }
    if (
      row.job_id !== input.jobId ||
      row.worker_id !== input.workerId ||
      row.lease_attempt !== input.leaseAttempt ||
      row.lease_token_hash !== hashToken(input.leaseToken) ||
      row.base_aggregate_version !== input.baseAggregateVersion ||
      row.result_hash !== resultHash ||
      row.result_json !== resultJson
    ) {
      throw new IntelligenceQueueError(
        "IdempotencyConflict",
        "idempotency key already records a different Intelligence Result",
      );
    }
    return "duplicate";
  }

  private async requireAppendLease(
    client: pg.PoolClient,
    input: {
      readonly tenantId: string;
      readonly jobId: string;
      readonly workerId: string;
      readonly leaseAttempt: number;
      readonly leaseTokenHash: string;
      readonly baseAggregateVersion: number;
      readonly checkedAt: string;
    },
  ): Promise<LeaseRow> {
    const job = await client.query<{ base_aggregate_version: number }>(
      `select base_aggregate_version
         from intelligence_jobs
        where tenant_id = $1
          and job_id = $2
        limit 1`,
      [input.tenantId, input.jobId],
    );
    const jobRow = job.rows[0];
    if (jobRow === undefined) {
      throw new IntelligenceQueueError("JobMismatch", "job does not exist for tenant");
    }
    if (jobRow.base_aggregate_version !== input.baseAggregateVersion) {
      throw new IntelligenceQueueError(
        "BaseVersionMismatch",
        "submitted base aggregate version does not match the job",
      );
    }

    const lease = await client.query<LeaseRow>(
      `select tenant_id, job_id, attempt, worker_id, lease_token_hash, expires_at, released_at, completed_at
         from intelligence_leases
        where tenant_id = $1
          and job_id = $2
          and attempt = $3
        for update`,
      [input.tenantId, input.jobId, input.leaseAttempt],
    );
    const row = lease.rows[0];
    if (row === undefined) {
      throw new IntelligenceQueueError("LeaseNotActive", "lease attempt does not exist");
    }
    if (row.worker_id !== input.workerId) {
      throw new IntelligenceQueueError("WorkerMismatch", "worker id does not match the active lease");
    }
    if (row.lease_token_hash !== input.leaseTokenHash) {
      throw new IntelligenceQueueError("LeaseTokenMismatch", "lease token does not match the active lease");
    }
    if (row.released_at !== null || row.completed_at !== null) {
      throw new IntelligenceQueueError("LeaseNotActive", "lease is no longer active");
    }
    if (row.expires_at <= input.checkedAt) {
      throw new IntelligenceQueueError("LeaseExpired", "the lease has expired");
    }
    return row;
  }

  private async classifyLeaseFailure(
    client: pg.PoolClient,
    input: {
      readonly tenantId: string | undefined;
      readonly jobId: string;
      readonly workerId: string;
      readonly leaseAttempt: number | undefined;
      readonly leaseTokenHash: string;
      readonly checkedAt: string;
    },
  ): Promise<IntelligenceQueueError> {
    const parameters: unknown[] = [input.jobId];
    let predicate = "job_id = $1";
    if (input.tenantId !== undefined) {
      parameters.push(input.tenantId);
      predicate += ` and tenant_id = $${parameters.length}`;
    }
    if (input.leaseAttempt !== undefined) {
      parameters.push(input.leaseAttempt);
      predicate += ` and attempt = $${parameters.length}`;
    }
    const lease = await client.query<LeaseRow>(
      `select tenant_id, job_id, attempt, worker_id, lease_token_hash, expires_at, released_at, completed_at
         from intelligence_leases
        where ${predicate}
        order by attempt desc
        limit 1`,
      parameters,
    );
    const row = lease.rows[0];
    if (row === undefined || row.released_at !== null || row.completed_at !== null) {
      return new IntelligenceQueueError("LeaseNotActive", "lease is no longer active");
    }
    if (row.worker_id !== input.workerId) {
      return new IntelligenceQueueError("WorkerMismatch", "worker id does not match the active lease");
    }
    if (row.lease_token_hash !== input.leaseTokenHash) {
      return new IntelligenceQueueError("LeaseTokenMismatch", "lease token does not match the active lease");
    }
    if (row.expires_at <= input.checkedAt) {
      return new IntelligenceQueueError("LeaseExpired", "the lease has expired");
    }
    return new IntelligenceQueueError("LeaseNotActive", "lease is no longer active");
  }
}
