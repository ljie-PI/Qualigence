import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { acquirePostgresOperationLock } from "@qualigence/postgres-runtime";
import type { IntelligenceJob, IntelligenceResult } from "@qualigence/intelligence";
import type {
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
  | "WorkerMismatch";

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

interface ActiveLease {
  readonly client: pg.PoolClient;
  readonly job: IntelligenceJob;
  readonly workerId: string;
  readonly leaseTokenHash: string;
  attempt: number;
  expiresAt: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A PostgreSQL-backed Intelligence work queue that is BOTH the Worker's
 * {@link IntelligenceJobStore} and its {@link IntelligenceResultInbox}. Leasing
 * uses `FOR UPDATE SKIP LOCKED` inside a transaction that is held open for the
 * lease lifetime, so concurrent Workers never lease the same Job and a crash
 * (connection loss) releases the lock for re-lease. Only jobs of an accepted
 * type with no committed Result are visible. The append validates the active
 * lease (token, worker, attempt, expiry and base aggregate version) and inserts
 * the Result idempotently; it never touches an aggregate table.
 *
 * The Worker connects as the least-privilege Worker role: RLS + table grants
 * mean any read of an aggregate/run/evidence table fails closed with SQLSTATE
 * 42501 before it can leak another tenant's data.
 */
export class PostgresIntelligenceQueue implements IntelligenceJobStore, IntelligenceResultInbox {
  private readonly pool: pg.Pool;
  private readonly leases = new Map<string, ActiveLease>();

  constructor(config: PostgresIntelligenceQueueConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.max ?? 8,
    });
    // A held lease is a long-lived transaction; when the pool is torn down (a
    // simulated Worker crash) idle clients emit an async error. Swallow it so a
    // recovery never surfaces as an unhandled rejection.
    this.pool.on("error", () => {
      /* connection dropped while idle — the lock is released for re-lease */
    });
  }

  async lease(
    input: LeaseInput,
  ): Promise<{ readonly job: IntelligenceJob; readonly lease: IntelligenceJobLease } | undefined> {
    const client = await this.pool.connect();
    // A held-lease client lives across the whole lease; if its socket drops
    // (simulated crash / pool teardown) pg emits an async 'error'. Swallow it so
    // recovery never surfaces as an unhandled rejection.
    client.on("error", () => {
      /* connection lost — the held row lock is released for re-lease */
    });
    let keepClient = false;
    try {
      await client.query("begin");
      await acquirePostgresOperationLock(client);
      const result = await client.query(
        `select j.job_json
           from intelligence_jobs j
          where j.job_type = any($1::text[])
            and not exists (
              select 1 from intelligence_results r where r.job_id = j.job_id
            )
          order by j.created_at asc
          for update skip locked
          limit 1`,
        [[...input.acceptedTypes]],
      );
      const row = result.rows[0] as { job_json: string } | undefined;
      if (row === undefined) {
        await client.query("rollback");
        return undefined;
      }
      const job = JSON.parse(row.job_json) as IntelligenceJob;
      const leaseToken = randomUUID();
      const expiresAt = new Date(Date.parse(input.now) + input.leaseDurationMs).toISOString();
      this.leases.set(job.jobId, {
        client,
        job,
        workerId: input.workerId,
        leaseTokenHash: hashToken(leaseToken),
        attempt: 1,
        expiresAt,
      });
      keepClient = true;
      return {
        job,
        lease: { jobId: job.jobId, leaseToken, workerId: input.workerId, expiresAt, attempt: 1 },
      };
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // ignore
      }
      throw error;
    } finally {
      if (!keepClient) {
        client.release();
      }
    }
  }

  async renew(input: RenewInput): Promise<IntelligenceJobLease> {
    const active = this.requireActiveLease(input.jobId, input.leaseToken, input.workerId);
    active.expiresAt = new Date(Date.parse(input.now) + input.leaseDurationMs).toISOString();
    return {
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      workerId: input.workerId,
      expiresAt: active.expiresAt,
      attempt: active.attempt,
    };
  }

  async append(input: AppendResultInput): Promise<{ readonly disposition: AppendDisposition }> {
    const active = this.leases.get(input.jobId);
    if (active === undefined) {
      // No active lease: the only legitimate case is a replay of an already
      // committed Result, which we report as duplicate. Anything else is a
      // forged/expired token and is rejected.
      const disposition = await this.dispositionForExistingResult(input.result);
      if (disposition === "duplicate") {
        return { disposition };
      }
      throw new IntelligenceQueueError("LeaseNotActive", `no active lease for job ${input.jobId}`);
    }

    if (active.leaseTokenHash !== hashToken(input.leaseToken)) {
      throw new IntelligenceQueueError("LeaseTokenMismatch", "lease token does not match the active lease");
    }
    if (active.workerId !== input.workerId) {
      throw new IntelligenceQueueError("WorkerMismatch", "worker id does not match the active lease");
    }
    if (active.attempt !== input.leaseAttempt) {
      throw new IntelligenceQueueError("LeaseTokenMismatch", "lease attempt does not match the active lease");
    }
    if (Date.parse(active.expiresAt) < Date.now()) {
      await this.abandon(input.jobId);
      throw new IntelligenceQueueError("LeaseExpired", "the lease has expired");
    }
    if (active.job.baseAggregateVersion !== input.baseAggregateVersion) {
      throw new IntelligenceQueueError(
        "BaseVersionMismatch",
        "submitted base aggregate version does not match the job",
      );
    }

    const { client } = active;
    try {
      const inserted = await client.query(
        `insert into intelligence_results
           (tenant_id, idempotency_key, job_id, terminal_status, confidence, result_json, created_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id, idempotency_key) do nothing
         returning idempotency_key`,
        [
          input.tenantId,
          input.result.idempotencyKey,
          input.result.jobId,
          input.result.terminalStatus,
          input.result.confidence,
          JSON.stringify(input.result),
          new Date().toISOString(),
        ],
      );
      await client.query("commit");
      const disposition: AppendDisposition = inserted.rowCount === 1 ? "accepted" : "duplicate";
      return { disposition };
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // ignore
      }
      throw error;
    } finally {
      client.release();
      this.leases.delete(input.jobId);
    }
  }

  /** Release a held lease without appending (e.g. after processing failure). */
  async abandon(jobId: string): Promise<void> {
    const active = this.leases.get(jobId);
    if (active === undefined) {
      return;
    }
    this.leases.delete(jobId);
    try {
      await active.client.query("rollback");
    } catch {
      // ignore
    } finally {
      active.client.release();
    }
  }

  async close(): Promise<void> {
    for (const jobId of [...this.leases.keys()]) {
      await this.abandon(jobId);
    }
    await this.pool.end();
  }

  private requireActiveLease(jobId: string, leaseToken: string, workerId: string): ActiveLease {
    const active = this.leases.get(jobId);
    if (active === undefined) {
      throw new IntelligenceQueueError("LeaseNotActive", `no active lease for job ${jobId}`);
    }
    if (active.leaseTokenHash !== hashToken(leaseToken)) {
      throw new IntelligenceQueueError("LeaseTokenMismatch", "lease token does not match the active lease");
    }
    if (active.workerId !== workerId) {
      throw new IntelligenceQueueError("WorkerMismatch", "worker id does not match the active lease");
    }
    return active;
  }

  private async dispositionForExistingResult(
    result: IntelligenceResult,
  ): Promise<AppendDisposition | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await acquirePostgresOperationLock(client);
      const existing = await client.query(
        `select 1 from intelligence_results where idempotency_key = $1 and job_id = $2 limit 1`,
        [result.idempotencyKey, result.jobId],
      );
      await client.query("commit");
      return existing.rowCount === 1 ? "duplicate" : undefined;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
