import type { ExecutionJobLease } from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import type { LeaseWindow } from "./lease-window.js";

export interface RenewalDelay {
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

export interface LeaseRenewalControllerDependencies {
  readonly session: RunnerSession;
  readonly initialLease: ExecutionJobLease;
  readonly window: LeaseWindow;
  readonly leaseDurationMs: number;
  readonly executionAbort: AbortController;
  readonly delay?: RenewalDelay;
}

export class LeaseRenewalTimeoutError extends Error {
  readonly code = "LeaseRenewalTimeout";

  constructor(timeoutMs: number) {
    super(`lease renewal timed out after ${timeoutMs}ms`);
    this.name = "LeaseRenewalTimeoutError";
  }
}

const timerDelay: RenewalDelay = {
  wait: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(finish, ms);
      function finish(): void {
        signal.removeEventListener("abort", abort);
        resolve();
      }
      function abort(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      }
      signal.addEventListener("abort", abort, { once: true });
    }),
};

/** Renews one accepted execution lease until the runtime stops. */
export class LeaseRenewalController {
  private lease: ExecutionJobLease;
  private readonly stopController = new AbortController();
  private readonly delay: RenewalDelay;

  constructor(private readonly deps: LeaseRenewalControllerDependencies) {
    this.lease = deps.initialLease;
    this.delay = deps.delay ?? timerDelay;
  }

  currentLease(): ExecutionJobLease {
    return this.lease;
  }

  async run(signal: AbortSignal): Promise<void> {
    const renewalSignal = AbortSignal.any([signal, this.stopController.signal]);
    const intervalMs = Math.max(1, Math.floor(this.deps.leaseDurationMs / 3));

    while (!renewalSignal.aborted) {
      try {
        await this.delay.wait(intervalMs, renewalSignal);
      } catch (error) {
        if (renewalSignal.aborted) return;
        this.fail(error);
      }
      if (renewalSignal.aborted) return;

      const deadlineAbort = new AbortController();
      const renewResult = Promise.resolve()
        .then(() => this.deps.session.renew(this.lease))
        .then(
          (lease) => ({ kind: "renewed" as const, lease }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
      const deadlineResult = this.delay.wait(intervalMs, deadlineAbort.signal).then(
        () => ({ kind: "timeout" as const }),
        () => ({ kind: "deadline-cancelled" as const }),
      );
      const result = await Promise.race([renewResult, deadlineResult]);
      deadlineAbort.abort();

      if (result.kind === "timeout") {
        try {
          await this.deps.session.close();
        } catch {
          // Preserve the authoritative renewal timeout after best-effort transport cancellation.
        }
        this.fail(new LeaseRenewalTimeoutError(intervalMs));
      }
      if (result.kind === "failed") this.fail(result.error);
      if (result.kind === "renewed") {
        this.lease = result.lease;
        this.deps.window.renew(result.lease);
      }
    }
  }

  stop(): void {
    this.stopController.abort();
  }

  private fail(error: unknown): never {
    this.deps.window.close();
    this.deps.executionAbort.abort(error);
    throw error;
  }
}
