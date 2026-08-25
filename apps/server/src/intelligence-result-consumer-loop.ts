import type { ConsumeSummary } from "@qualigence/core-application";
import type {
  IntelligenceResultWakeupClaim,
  IntelligenceResultWakeupStore,
} from "@qualigence/postgres-runtime";

export interface IntelligenceResultConsumer {
  consumeForTenant(tenantId: string, options?: { readonly batchSize?: number }): Promise<ConsumeSummary>;
}

export interface IntelligenceResultConsumerLoopOptions {
  readonly consumerId: string;
  readonly wakeups: IntelligenceResultWakeupStore;
  readonly consumer: IntelligenceResultConsumer;
  readonly signal?: AbortSignal;
  readonly tenantBatchSize?: number;
  readonly resultBatchSize?: number;
  readonly leaseDurationMs?: number;
  readonly idleBackoffMs?: number;
  readonly errorBackoffMs?: number;
  readonly maximumBackoffMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly onError?: (error: unknown) => void;
}

export interface IntelligenceResultConsumerCycleResult {
  readonly claimed: number;
  readonly processed: number;
  readonly applied: number;
  readonly duplicate: number;
  readonly recompute: number;
  readonly rejected: number;
  readonly retried: number;
  readonly completed: number;
  readonly stale: number;
}

type MutableCycleResult = {
  -readonly [K in keyof IntelligenceResultConsumerCycleResult]: IntelligenceResultConsumerCycleResult[K];
};

const DEFAULT_TENANT_BATCH_SIZE = 16;
const DEFAULT_RESULT_BATCH_SIZE = 32;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_IDLE_BACKOFF_MS = 1_000;
const DEFAULT_ERROR_BACKOFF_MS = 1_000;
const DEFAULT_MAXIMUM_BACKOFF_MS = 30_000;

/**
 * Bounded Server loop that discovers payload-free tenant wakeups, claims each
 * wakeup with generation fencing, and consumes only a bounded per-tenant Result
 * batch through the deterministic application consumer.
 */
export class IntelligenceResultConsumerLoop {
  private readonly consumerId: string;
  private readonly wakeups: IntelligenceResultWakeupStore;
  private readonly consumer: IntelligenceResultConsumer;
  private readonly signal: AbortSignal | undefined;
  private readonly tenantBatchSize: number;
  private readonly resultBatchSize: number;
  private readonly leaseDurationMs: number;
  private readonly idleBackoffMs: number;
  private readonly errorBackoffMs: number;
  private readonly maximumBackoffMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onError: (error: unknown) => void;
  private timer: unknown;
  private active = false;
  private inFlight: Promise<void> = Promise.resolve();
  private consecutiveFailures = 0;

  constructor(options: IntelligenceResultConsumerLoopOptions) {
    this.consumerId = nonEmpty(options.consumerId, "consumerId");
    this.wakeups = options.wakeups;
    this.consumer = options.consumer;
    this.signal = options.signal;
    this.tenantBatchSize = boundedPositive(options.tenantBatchSize ?? DEFAULT_TENANT_BATCH_SIZE, "tenantBatchSize", 256);
    this.resultBatchSize = boundedPositive(options.resultBatchSize ?? DEFAULT_RESULT_BATCH_SIZE, "resultBatchSize", 256);
    this.leaseDurationMs = boundedPositive(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS, "leaseDurationMs", 300_000);
    this.idleBackoffMs = boundedPositive(options.idleBackoffMs ?? DEFAULT_IDLE_BACKOFF_MS, "idleBackoffMs", 60_000);
    this.errorBackoffMs = boundedPositive(options.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS, "errorBackoffMs", 60_000);
    this.maximumBackoffMs = boundedPositive(options.maximumBackoffMs ?? DEFAULT_MAXIMUM_BACKOFF_MS, "maximumBackoffMs", 300_000);
    if (this.errorBackoffMs > this.maximumBackoffMs) {
      throw new Error("errorBackoffMs must be less than or equal to maximumBackoffMs");
    }
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onError = options.onError ?? (() => undefined);
    this.signal?.addEventListener("abort", () => {
      void this.stop();
    }, { once: true });
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  async runOnce(): Promise<IntelligenceResultConsumerCycleResult> {
    const empty = (): MutableCycleResult => ({
      claimed: 0,
      processed: 0,
      applied: 0,
      duplicate: 0,
      recompute: 0,
      rejected: 0,
      retried: 0,
      completed: 0,
      stale: 0,
    });
    if (this.isAborted()) return empty();

    const claims = await this.wakeups.claimDueTenants({
      consumerId: this.consumerId,
      leaseDurationMs: this.leaseDurationMs,
      batchSize: this.tenantBatchSize,
    });
    const totals = empty();
    for (const claim of claims) {
      totals.claimed += 1;
      if (this.isAborted()) break;
      await this.consumeClaim(claim, totals);
    }
    this.consecutiveFailures = totals.retried === 0 ? 0 : this.consecutiveFailures + totals.retried;
    return totals;
  }

  private schedule(delayMs: number): void {
    if (!this.active || this.timer !== undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.inFlight = this.runOnce()
        .then((summary) => {
          const delay = summary.claimed === 0 ? this.idleBackoffMs : 0;
          this.schedule(delay);
        })
        .catch((error) => {
          this.onError(error);
          this.consecutiveFailures += 1;
          this.schedule(this.currentBackoffMs());
        });
    }, delayMs);
  }

  private async consumeClaim(
    claim: IntelligenceResultWakeupClaim,
    totals: MutableCycleResult,
  ): Promise<void> {
    try {
      const summary = await this.consumer.consumeForTenant(claim.tenantId, { batchSize: this.resultBatchSize });
      totals.processed += summary.processed;
      totals.applied += summary.applied;
      totals.duplicate += summary.duplicate;
      totals.recompute += summary.recompute;
      totals.rejected += summary.rejected;
      if (summary.hasMore) {
        const disposition = await this.wakeups.retry({
          tenantId: claim.tenantId,
          generation: claim.generation,
          consumerId: claim.consumerId,
          retryAfterMs: 0,
          error: "bounded-batch-remaining",
        });
        if (disposition === "scheduled") totals.retried += 1;
        else totals.stale += 1;
        return;
      }
      const disposition = await this.wakeups.complete(claim);
      if (disposition === "completed") totals.completed += 1;
      else totals.stale += 1;
    } catch (error) {
      this.onError(error);
      const disposition = await this.wakeups.retry({
        tenantId: claim.tenantId,
        generation: claim.generation,
        consumerId: claim.consumerId,
        retryAfterMs: this.currentBackoffMs(),
        error: errorMessage(error),
      });
      if (disposition === "scheduled") totals.retried += 1;
      else totals.stale += 1;
    }
  }

  private currentBackoffMs(): number {
    return Math.min(this.errorBackoffMs * 2 ** this.consecutiveFailures, this.maximumBackoffMs);
  }

  private isAborted(): boolean {
    return this.signal?.aborted === true;
  }
}

function boundedPositive(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
