import type { IntelligenceJobType } from "@qualigence/intelligence";
import type {
  IntelligenceJobStore,
  IntelligenceResultInbox,
} from "@qualigence/core-application";
import type { JobProcessor } from "./job-processor.js";

/** A monotonic wall clock the loop can drive deterministically in tests. */
export interface Clock {
  now(): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export type WorkerStepOutcome = "processed" | "idle" | "failed";

export interface WorkerLoopConfig {
  readonly store: IntelligenceJobStore;
  readonly inbox: IntelligenceResultInbox;
  readonly processor: JobProcessor;
  readonly workerId: string;
  readonly acceptedTypes: readonly IntelligenceJobType[];
  readonly leaseDurationMs: number;
  readonly idleBackoffMs: number;
  readonly clock?: Clock;
  readonly onError?: (error: unknown) => void;
}

/**
 * The standalone Intelligence Worker loop. Each step leases at most one Job of an
 * accepted type, processes it into a Result, and appends that Result to the
 * durable Inbox under the active lease — the Server (never this loop) later
 * applies it. A processing failure abandons the lease so the Job is re-leased;
 * the loop never applies a Result and never touches an aggregate table.
 */
export class WorkerLoop {
  private readonly clock: Clock;

  constructor(private readonly config: WorkerLoopConfig) {
    this.clock = config.clock ?? systemClock;
  }

  async runOnce(): Promise<WorkerStepOutcome> {
    const leased = await this.config.store.lease({
      workerId: this.config.workerId,
      acceptedTypes: this.config.acceptedTypes,
      now: this.clock.now(),
      leaseDurationMs: this.config.leaseDurationMs,
    });
    if (leased === undefined) {
      return "idle";
    }

    const { job, lease } = leased;
    try {
      const result = await this.config.processor.process(job);
      await this.config.inbox.append({
        tenantId: job.tenantId,
        jobId: job.jobId,
        leaseToken: lease.leaseToken,
        leaseAttempt: lease.attempt,
        workerId: this.config.workerId,
        baseAggregateVersion: job.baseAggregateVersion,
        result,
      });
      return "processed";
    } catch (error) {
      this.config.onError?.(error);
      await this.config.store.abandon(job.jobId);
      return "failed";
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const outcome = await this.runOnce();
      if (signal.aborted) {
        return;
      }
      if (outcome === "idle") {
        await this.clock.sleep(this.config.idleBackoffMs, signal);
      }
    }
  }
}
