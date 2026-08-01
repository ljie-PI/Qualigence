import type { ExecutionJobLease } from "@qualigence/runner-protocol";

export interface LeaseWindowClocks {
  /** A strictly monotonic millisecond clock (never affected by wall-clock changes). */
  readonly monotonicNow: () => number;
  /** Wall-clock milliseconds, used only to detect a suspicious backward jump. */
  readonly wallNow: () => number;
}

export interface LeaseWindowOptions {
  readonly leaseDurationMs: number;
  readonly actionDeadlineSafetyMarginMs: number;
}

/**
 * The Runner's conservative, defense-in-depth action window for a Lease (LS-05
 * design §5). The deadline is derived from a monotonic clock at Lease receipt and
 * pulled in by a safety margin; the wall-clock `expiresAt` is used only for
 * audit. A monotonic deadline overrun, a backward wall-clock jump (clock reset or
 * process pause/resume), or an explicit abort all close the window. A later
 * wall-clock reading is never converted back into permission to act.
 */
export class LeaseWindow {
  private readonly clocks: LeaseWindowClocks;
  private readonly options: LeaseWindowOptions;
  private deadlineMonotonic: number;
  private baselineWall: number;
  private closed = false;

  constructor(_lease: ExecutionJobLease, clocks: LeaseWindowClocks, options: LeaseWindowOptions) {
    this.clocks = clocks;
    this.options = options;
    this.deadlineMonotonic = this.computeDeadline();
    this.baselineWall = clocks.wallNow();
  }

  /** Reset the window from the current monotonic clock after a successful renew. */
  renew(_lease: ExecutionJobLease): void {
    this.deadlineMonotonic = this.computeDeadline();
    this.baselineWall = this.clocks.wallNow();
  }

  /** Permanently close the window (cancel, revoke or unrecoverable clock anomaly). */
  close(): void {
    this.closed = true;
  }

  /** True only while it is safe to begin a new action under this Lease. */
  mayStartAction(): boolean {
    if (this.closed) {
      return false;
    }
    if (this.clocks.monotonicNow() >= this.deadlineMonotonic) {
      return false;
    }
    // A backward wall-clock jump means we can no longer trust our timing basis.
    if (this.clocks.wallNow() < this.baselineWall) {
      return false;
    }
    return true;
  }

  private computeDeadline(): number {
    return (
      this.clocks.monotonicNow() +
      this.options.leaseDurationMs -
      this.options.actionDeadlineSafetyMarginMs
    );
  }
}
