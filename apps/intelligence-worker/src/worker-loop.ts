import type { IntelligenceJobType } from "@qualigence/intelligence";
import type {
  IntelligenceJobLease,
  IntelligenceJobStore,
  IntelligenceResultInbox,
} from "@qualigence/core-application";
import { throwIfJobProcessingAborted, type JobProcessor } from "./job-processor.js";

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

export type WorkerStepOutcome = "processed" | "idle" | "failed" | "aborted";

export interface WorkerLoopReadiness {
  readonly status: "ready" | "not-ready";
  readonly active: boolean;
  readonly aborted: boolean;
  readonly inFlight: boolean;
  readonly lastOutcome?: WorkerStepOutcome;
  readonly consecutiveFailures: number;
  readonly lastProgressAt?: string;
  readonly lastError?: string;
}

const MINIMUM_RENEWAL_DELAY_MS = 1;

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
  private active = false;
  private inFlight = false;
  private lastOutcome: WorkerStepOutcome | undefined;
  private consecutiveFailures = 0;
  private lastProgressAt: string | undefined;
  private lastError: string | undefined;

  constructor(private readonly config: WorkerLoopConfig) {
    this.clock = config.clock ?? systemClock;
  }

  readiness(): WorkerLoopReadiness {
    const aborted = this.active ? false : this.lastOutcome === "aborted";
    const status = this.active && this.lastError === undefined ? "ready" : "not-ready";
    return {
      status,
      active: this.active,
      aborted,
      inFlight: this.inFlight,
      ...(this.lastOutcome === undefined ? {} : { lastOutcome: this.lastOutcome }),
      consecutiveFailures: this.consecutiveFailures,
      ...(this.lastProgressAt === undefined ? {} : { lastProgressAt: this.lastProgressAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  async runOnce(signal?: AbortSignal): Promise<WorkerStepOutcome> {
    if (signal?.aborted === true) {
      this.recordOutcome("aborted");
      return "aborted";
    }
    this.inFlight = true;
    try {
      return await this.runStep(signal);
    } finally {
      this.inFlight = false;
    }
  }

  private async runStep(signal?: AbortSignal): Promise<WorkerStepOutcome> {
    const leased = await this.config.store.lease({
      workerId: this.config.workerId,
      acceptedTypes: this.config.acceptedTypes,
      now: this.clock.now(),
      leaseDurationMs: this.config.leaseDurationMs,
    });
    if (leased === undefined) {
      this.recordOutcome("idle");
      return "idle";
    }

    const { job, lease } = leased;
    const renewals = this.startRenewalLoop(lease);
    try {
      throwIfJobProcessingAborted(signal);
      const result = await this.config.processor.process(job, signal);
      throwIfJobProcessingAborted(signal);
      const currentLease = await renewals.stop();
      throwIfJobProcessingAborted(signal);
      await this.config.inbox.append({
        tenantId: job.tenantId,
        jobId: job.jobId,
        leaseToken: currentLease.leaseToken,
        leaseAttempt: currentLease.attempt,
        workerId: this.config.workerId,
        baseAggregateVersion: job.baseAggregateVersion,
        result,
      });
      this.recordOutcome("processed");
      return "processed";
    } catch (error) {
      const currentLease = await renewals.stop().catch(() => lease);
      await this.config.store.abandon({
        tenantId: job.tenantId,
        jobId: job.jobId,
        leaseToken: currentLease.leaseToken,
        leaseAttempt: currentLease.attempt,
        workerId: this.config.workerId,
      });
      if (Boolean(signal?.aborted)) {
        this.recordOutcome("aborted");
        return "aborted";
      }
      this.lastError = errorMessage(error);
      this.consecutiveFailures += 1;
      this.config.onError?.(error);
      this.recordOutcome("failed", false);
      return "failed";
    }
  }

  private startRenewalLoop(initialLease: IntelligenceJobLease): {
    stop(): Promise<IntelligenceJobLease>;
  } {
    const abort = new AbortController();
    const delayMs = Math.max(
      MINIMUM_RENEWAL_DELAY_MS,
      Math.floor(this.config.leaseDurationMs / 3),
    );
    let currentLease = initialLease;
    let renewalError: unknown;
    const done = (async (): Promise<void> => {
      while (!abort.signal.aborted) {
        await this.clock.sleep(delayMs, abort.signal);
        if (abort.signal.aborted) {
          return;
        }
        try {
          currentLease = await this.config.store.renew({
            jobId: currentLease.jobId,
            leaseToken: currentLease.leaseToken,
            workerId: this.config.workerId,
            now: this.clock.now(),
            leaseDurationMs: this.config.leaseDurationMs,
          });
        } catch (error) {
          renewalError = error;
          return;
        }
      }
    })();

    return {
      stop: async (): Promise<IntelligenceJobLease> => {
        abort.abort();
        await done;
        if (renewalError !== undefined) {
          throw renewalError;
        }
        return currentLease;
      },
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    this.active = true;
    try {
      while (!signal.aborted) {
        const outcome = await this.runOnce(signal);
        if (signal.aborted) {
          this.recordOutcome("aborted");
          return;
        }
        if (outcome === "idle") {
          await this.clock.sleep(this.config.idleBackoffMs, signal);
        }
      }
      this.recordOutcome("aborted");
    } finally {
      this.active = false;
    }
  }

  private recordOutcome(outcome: WorkerStepOutcome, healthy = true): void {
    this.lastOutcome = outcome;
    this.lastProgressAt = this.clock.now();
    if (healthy) {
      this.lastError = undefined;
      this.consecutiveFailures = 0;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
