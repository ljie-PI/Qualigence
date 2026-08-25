import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { IntelligenceJob, IntelligenceResult } from "@qualigence/intelligence";
import type {
  AbandonLeaseDisposition,
  AbandonLeaseInput,
  AppendResultInput,
  AppendDisposition,
  IntelligenceJobLease,
  IntelligenceJobStore,
  IntelligenceResultInbox,
  LeaseInput,
  RenewInput,
} from "./intelligence-queue-contracts.js";

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

export interface PostgresIntelligenceQueueConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** The dedicated, least-privilege Worker role. */
  readonly user: string;
  readonly password: string;
  readonly max?: number;
}

export type TransactionGuard = (transaction: pg.PoolClient) => Promise<void>;

interface LeaseClaimRow {
  readonly job_json: string;
  readonly attempt: number;
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

function expiresAt(now: string, leaseDurationMs: number): string {
  return new Date(Date.parse(now) + leaseDurationMs).toISOString();
}

/**
 * PostgreSQL-backed Intelligence work queue for the Worker-facing ports. The
 * Worker role executes constrained SECURITY DEFINER queue functions: it can
 * claim/renew/abandon a fenced lease and append a proposal Result to
 * `intelligence_result_inbox`, but it cannot insert raw rows into the legacy
 * `intelligence_results` table consumed by no Server code.
 */
export class PostgresIntelligenceQueue implements IntelligenceJobStore, IntelligenceResultInbox {
  private readonly pool: pg.Pool;
  private readonly transactionGuard: TransactionGuard;

  constructor(
    config: PostgresIntelligenceQueueConfig,
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
      const leaseExpiresAt = expiresAt(input.now, input.leaseDurationMs);
      const selected = await client.query<LeaseClaimRow>(
        `select job_json, attempt
           from worker_claim_intelligence_lease($1::text[], $2::text, $3::text, $4::text, $5::text)`,
        [[...input.acceptedTypes], input.now, input.workerId, hashToken(leaseToken), leaseExpiresAt],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        await client.query("commit");
        return undefined;
      }

      const job = JSON.parse(row.job_json) as IntelligenceJob;
      await client.query("commit");
      return {
        job,
        lease: {
          jobId: job.jobId,
          leaseToken,
          workerId: input.workerId,
          expiresAt: leaseExpiresAt,
          attempt: row.attempt,
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
      const nextExpiresAt = expiresAt(input.now, input.leaseDurationMs);
      const renewed = await client.query<LeaseRenewRow>(
        `select status, attempt, expires_at
           from worker_renew_intelligence_lease($1::text, $2::text, $3::text, $4::text, $5::text)`,
        [input.jobId, input.workerId, hashToken(input.leaseToken), input.now, nextExpiresAt],
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
    const acceptedAt = new Date().toISOString();
    try {
      await client.query("begin");
      await this.transactionGuard(client);
      const appended = await client.query<AppendResultRow>(
        `select status
           from worker_append_intelligence_result(
             $1::text, $2::text, $3::text, $4::integer, $5::text,
             $6::integer, $7::text, $8::text, $9::text, $10::text
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
          acceptedAt,
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
           from worker_abandon_intelligence_lease($1::text, $2::text, $3::text, $4::integer, $5::text, $6::text)`,
        [
          input.tenantId,
          input.jobId,
          input.workerId,
          input.leaseAttempt,
          hashToken(input.leaseToken),
          new Date().toISOString(),
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
