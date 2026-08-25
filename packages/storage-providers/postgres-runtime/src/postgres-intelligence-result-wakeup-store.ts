import pg from "pg";
import type { PostgresConnectionConfig } from "./postgres-runtime.js";
import type { TransactionGuard } from "./postgres-intelligence-queue.js";

const { Pool } = pg;

export interface IntelligenceResultWakeupClaim {
  readonly tenantId: string;
  readonly generation: number;
  readonly consumerId: string;
  readonly leaseExpiresAt: string;
}

export interface ClaimIntelligenceResultWakeupsInput {
  readonly consumerId: string;
  readonly leaseDurationMs: number;
  readonly batchSize: number;
}

export interface CompleteIntelligenceResultWakeupInput {
  readonly tenantId: string;
  readonly generation: number;
  readonly consumerId: string;
}

export interface RetryIntelligenceResultWakeupInput extends CompleteIntelligenceResultWakeupInput {
  readonly retryAfterMs: number;
  readonly error: string;
}

export type CompleteIntelligenceResultWakeupDisposition = "completed" | "stale" | "stale-generation";
export type RetryIntelligenceResultWakeupDisposition = "scheduled" | "stale" | "stale-generation";

export interface IntelligenceResultWakeupStore {
  claimDueTenants(input: ClaimIntelligenceResultWakeupsInput): Promise<readonly IntelligenceResultWakeupClaim[]>;
  complete(input: CompleteIntelligenceResultWakeupInput): Promise<CompleteIntelligenceResultWakeupDisposition>;
  retry(input: RetryIntelligenceResultWakeupInput): Promise<RetryIntelligenceResultWakeupDisposition>;
}

interface ClaimRow {
  readonly tenant_id: string;
  readonly generation: number;
  readonly lease_expires_at: string;
}

interface StatusRow<T extends string> {
  readonly status: T;
}

function boundedPositive(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function boundedNonNegative(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a non-negative safe integer no greater than ${maximum}`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

/**
 * Server-side tenant wakeup adapter. It deliberately exposes only payload-free
 * scheduling operations: the cross-tenant claim function returns tenant ids and
 * fencing metadata, while each Result is still read and applied later through a
 * tenant-scoped transaction.
 */
export class PostgresIntelligenceResultWakeupStore implements IntelligenceResultWakeupStore {
  private readonly pool: pg.Pool;
  private readonly transactionGuard: TransactionGuard;

  constructor(
    config: PostgresConnectionConfig,
    transactionGuard?: TransactionGuard,
  ) {
    if (transactionGuard === undefined) {
      throw new Error("PostgresIntelligenceResultWakeupStore requires an explicit transaction guard");
    }
    this.transactionGuard = transactionGuard;
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.max ?? 4,
    });
  }

  async claimDueTenants(
    input: ClaimIntelligenceResultWakeupsInput,
  ): Promise<readonly IntelligenceResultWakeupClaim[]> {
    const consumerId = nonEmpty(input.consumerId, "consumerId");
    const leaseDurationMs = boundedPositive(input.leaseDurationMs, "leaseDurationMs", 300_000);
    const batchSize = boundedPositive(input.batchSize, "batchSize", 256);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.transactionGuard(client);
      const claimed = await client.query<ClaimRow>(
        `select tenant_id, generation, lease_expires_at
           from server_claim_intelligence_result_wakeups($1::text, $2::integer, $3::integer)`,
        [consumerId, leaseDurationMs, batchSize],
      );
      await client.query("commit");
      return claimed.rows.map((row) => ({
        tenantId: row.tenant_id,
        generation: row.generation,
        consumerId,
        leaseExpiresAt: row.lease_expires_at,
      }));
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(
    input: CompleteIntelligenceResultWakeupInput,
  ): Promise<CompleteIntelligenceResultWakeupDisposition> {
    return this.finish<CompleteIntelligenceResultWakeupDisposition>(
      `select status
         from server_complete_intelligence_result_wakeup($1::text, $2::integer, $3::text)`,
      [nonEmpty(input.tenantId, "tenantId"), input.generation, nonEmpty(input.consumerId, "consumerId")],
      "stale",
    );
  }

  async retry(
    input: RetryIntelligenceResultWakeupInput,
  ): Promise<RetryIntelligenceResultWakeupDisposition> {
    const retryAfterMs = boundedNonNegative(input.retryAfterMs, "retryAfterMs", 300_000);
    return this.finish<RetryIntelligenceResultWakeupDisposition>(
      `select status
         from server_retry_intelligence_result_wakeup($1::text, $2::integer, $3::text, $4::integer, $5::text)`,
      [
        nonEmpty(input.tenantId, "tenantId"),
        input.generation,
        nonEmpty(input.consumerId, "consumerId"),
        retryAfterMs,
        input.error,
      ],
      "stale",
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async finish<T extends string>(query: string, values: readonly unknown[], fallback: T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.transactionGuard(client);
      const result = await client.query<StatusRow<T>>(query, [...values]);
      await client.query("commit");
      return result.rows[0]?.status ?? fallback;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
