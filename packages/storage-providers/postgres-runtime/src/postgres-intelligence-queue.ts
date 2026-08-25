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

export interface AbandonLeaseInput {
  readonly tenantId: string;
  readonly jobId: string;
  readonly leaseToken: string;
  readonly leaseAttempt: number;
  readonly workerId: string;
}

export type AbandonLeaseDisposition = "released" | "not-active";

interface LeaseClaimRow {
  readonly job_json: string;
  readonly attempt: number;
  readonly expires_at: string;
}

interface LeaseRenewRow {
  readonly status: IntelligenceQueueErrorCode | "renewed";
  readonly attempt: number | null;
  readonly expires_at: string | null;
}

interface AppendResultRow {
  readonly status: IntelligenceQueueErrorCode | AppendDisposition;
}

interface AbandonLeaseRow {
  readonly status: AbandonLeaseDisposition;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashResult(result: IntelligenceResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

/**
 * Durable PostgreSQL Intelligence work queue. Leases are committed rows bound to
 * tenant, job, worker, attempt and lease-token hash; the raw token is returned
 * only to the Worker. A Result append revalidates that durable fence in the
 * same transaction that records the Server-consumed inbox row. The Worker role
 * receives no direct aggregate or raw Result-table grants.
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
      const leaseToken = randomUUID();
      const selected = await client.query<LeaseClaimRow>(
        `select job_json, attempt, expires_at
           from worker_claim_intelligence_lease($1::text[], $2::text, $3::text, $4::integer)`,
        [[...input.acceptedTypes], input.workerId, hashToken(leaseToken), input.leaseDurationMs],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        await client.query("commit");
        return undefined;
      }

      const job = JSON.parse(row.job_json) as IntelligenceJob;
      const attempt = row.attempt;
      await client.query("commit");
      return {
        job,
        lease: {
          jobId: job.jobId,
          leaseToken,
          workerId: input.workerId,
          expiresAt: row.expires_at,
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
      const renewed = await client.query<LeaseRenewRow>(
        `select status, attempt, expires_at
           from worker_renew_intelligence_lease($1::text, $2::text, $3::text, $4::integer)`,
        [input.jobId, input.workerId, leaseTokenHash, input.leaseDurationMs],
      );
      const row = renewed.rows[0];
      if (row === undefined || row.status !== "renewed" || row.attempt === null || row.expires_at === null) {
        await client.query("rollback");
        throw new IntelligenceQueueError(
          row?.status === undefined || row?.status === "renewed" ? "LeaseNotActive" : row.status,
          "lease is no longer renewable",
        );
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
    const resultJson = JSON.stringify(input.result);
    try {
      await client.query("begin");
      await this.transactionGuard(client);
      const appended = await client.query<AppendResultRow>(
        `select status
           from worker_append_intelligence_result(
             $1::text, $2::text, $3::text, $4::integer, $5::text,
             $6::integer, $7::text, $8::text, $9::text
           )`,
        [
          input.tenantId,
          input.jobId,
          input.workerId,
          input.leaseAttempt,
          hashToken(input.leaseToken),
          input.baseAggregateVersion,
          input.result.idempotencyKey,
          hashResult(input.result),
          resultJson,
        ],
      );
      const status = appended.rows[0]?.status;
      if (status !== "accepted" && status !== "duplicate") {
        await client.query("rollback");
        throw new IntelligenceQueueError(status ?? "LeaseNotActive", "result append was rejected");
      }
      await client.query("commit");
      return { disposition: status };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async abandon(input: AbandonLeaseInput): Promise<{ readonly disposition: AbandonLeaseDisposition }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.transactionGuard(client);
      const released = await client.query<AbandonLeaseRow>(
        `select status
           from worker_abandon_intelligence_lease($1::text, $2::text, $3::text, $4::integer, $5::text)`,
        [
          input.tenantId,
          input.jobId,
          input.workerId,
          input.leaseAttempt,
          hashToken(input.leaseToken),
        ],
      );
      await client.query("commit");
      return { disposition: released.rows[0]?.status ?? "not-active" };
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

}
