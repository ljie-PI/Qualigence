import {
  validateExplorationPolicy,
  type ExplorationBudgetSnapshot,
  type ExplorationPolicy,
  type ExplorationTerminalReason,
} from "@qualigence/mission";

/**
 * A monotonic millisecond clock. Injected so budget wall-clock accounting is
 * deterministic and replayable in tests.
 */
export interface MonotonicClock {
  now(): number;
}

/** The outcome of attempting to consume some budget dimension. */
export type Reservation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ExplorationTerminalReason };

const EXHAUSTED: Reservation = { ok: false, reason: "budget_exhausted" };

/**
 * Deterministic, pure accounting for a single exploration session. Each numeric
 * dimension of the {@link ExplorationPolicy} maps to one remaining counter, and
 * reaching any bound before the next action stops exploration with
 * `budget_exhausted` — never an infinite loop or crash.
 *
 * Model-token accounting reserves an estimate atomically before an invocation
 * and settles the actual usage afterwards, so a session can never silently
 * overrun its token cap between the reservation and the response.
 */
export class ExplorationBudget {
  private constructor(
    private remainingSteps: number,
    private remainingStateVisits: number,
    private remainingModelTokens: number,
    private remainingRecoveries: number,
    private readonly maximumWallClockMs: number,
    private readonly clock: MonotonicClock,
    private readonly startedAtMs: number,
  ) {}

  static from(policy: ExplorationPolicy, clock: MonotonicClock): ExplorationBudget {
    const validated = validateExplorationPolicy(policy);
    return new ExplorationBudget(
      validated.maximumSteps,
      validated.maximumStateVisits,
      validated.maximumModelTokens,
      validated.maximumRecoveries,
      validated.maximumWallClockMs,
      clock,
      clock.now(),
    );
  }

  reserveStep(): Reservation {
    if (this.remainingSteps <= 0) {
      return EXHAUSTED;
    }
    this.remainingSteps -= 1;
    return { ok: true };
  }

  reserveStateVisit(): Reservation {
    if (this.remainingStateVisits <= 0) {
      return EXHAUSTED;
    }
    this.remainingStateVisits -= 1;
    return { ok: true };
  }

  reserveRecovery(): Reservation {
    if (this.remainingRecoveries <= 0) {
      return EXHAUSTED;
    }
    this.remainingRecoveries -= 1;
    return { ok: true };
  }

  /** Atomically reserve an estimated token count before a model invocation. */
  reserveModelTokens(estimate: number): Reservation {
    const amount = normalizeTokens(estimate);
    if (amount > this.remainingModelTokens) {
      return EXHAUSTED;
    }
    this.remainingModelTokens -= amount;
    return { ok: true };
  }

  /** Reconcile a prior reservation against the actual tokens the model used. */
  settleModelTokens(reserved: number, actual: number): void {
    const reservedAmount = normalizeTokens(reserved);
    const actualAmount = normalizeTokens(actual);
    // Return the over-reservation, or charge the shortfall, without underflowing.
    this.remainingModelTokens += reservedAmount - actualAmount;
    if (this.remainingModelTokens < 0) {
      this.remainingModelTokens = 0;
    }
  }

  checkWallClock(): Reservation {
    const elapsed = this.clock.now() - this.startedAtMs;
    if (elapsed >= this.maximumWallClockMs) {
      return EXHAUSTED;
    }
    return { ok: true };
  }

  /** True while at least one more step is possible on every hard dimension. */
  canContinue(): boolean {
    return (
      this.remainingSteps > 0 &&
      this.remainingStateVisits > 0 &&
      this.remainingModelTokens > 0 &&
      this.checkWallClock().ok
    );
  }

  snapshot(): ExplorationBudgetSnapshot {
    const elapsed = this.clock.now() - this.startedAtMs;
    const remainingWallClockMs = Math.max(0, this.maximumWallClockMs - elapsed);
    return {
      remainingSteps: this.remainingSteps,
      remainingWallClockMs,
      remainingModelTokens: this.remainingModelTokens,
      remainingStateVisits: this.remainingStateVisits,
      remainingRecoveries: this.remainingRecoveries,
    };
  }
}

function normalizeTokens(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Model token amounts must be a non-negative finite number.");
  }
  return Math.ceil(value);
}
