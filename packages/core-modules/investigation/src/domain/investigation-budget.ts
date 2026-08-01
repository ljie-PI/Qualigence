/**
 * The investigation budget contract and its deterministic accounting ledger.
 *
 * An {@link InvestigationBudget} declares the hard ceilings a single
 * investigation may consume. The ledger accumulates {@link InvestigationBudgetUsage}
 * as immutable Reproduction Attempts and plan revisions are recorded, and reports
 * clean exhaustion the moment any dimension reaches its ceiling — never an
 * overrun, an infinite loop, or a silent budget leak.
 *
 * Counting is authoritative and derived from the outcome, not trusted from the
 * caller: an `environment_failed` attempt consumes only an environment retry and
 * never an investigative reproduction attempt, matching the design invariant that
 * "environment failure only consumes environment budget".
 */

import type { ReproductionAttempt, ReproductionOutcome } from "./reproduction-attempt.js";

export interface InvestigationBudget {
  readonly maximumReproductionAttempts: number;
  readonly maximumPlanningRevisions: number;
  readonly maximumEnvironmentRetries: number;
  readonly maximumWallClockMs: number;
  readonly maximumModelTokens: number;
  readonly maximumEnvironmentResets: number;
  readonly maximumDestructiveActions: number;
  readonly confirmationConfidenceThreshold: number;
}

export interface InvestigationBudgetUsage {
  readonly reproductionAttempts: number;
  readonly planningRevisions: number;
  readonly environmentRetries: number;
  readonly wallClockMs: number;
  readonly modelTokens: number;
  readonly environmentResets: number;
  readonly destructiveActions: number;
}

export type BudgetDimension =
  | "reproductionAttempts"
  | "planningRevisions"
  | "environmentRetries"
  | "wallClockMs"
  | "modelTokens"
  | "environmentResets"
  | "destructiveActions";

/** The immutable result of consuming from the ledger. */
export interface BudgetConsumeResult {
  readonly usage: InvestigationBudgetUsage;
  readonly exhausted: boolean;
  readonly exhaustedDimensions: readonly BudgetDimension[];
}

const ZERO_USAGE: InvestigationBudgetUsage = {
  reproductionAttempts: 0,
  planningRevisions: 0,
  environmentRetries: 0,
  wallClockMs: 0,
  modelTokens: 0,
  environmentResets: 0,
  destructiveActions: 0,
};

/**
 * Returns whether the given outcome consumes an investigative reproduction
 * attempt. Environment failures are excluded so a flaky environment never
 * silently eats the reproduction budget.
 */
export function outcomeConsumesReproductionAttempt(
  outcome: ReproductionOutcome,
): boolean {
  return outcome !== "environment_failed";
}

/**
 * Deterministic, pure accounting for one investigation. All arithmetic is
 * non-negative and monotonic; every mutation returns a fresh cumulative snapshot
 * plus the dimensions (if any) that have reached their ceiling.
 */
export class InvestigationBudgetLedger {
  private constructor(
    private readonly budget: InvestigationBudget,
    private reproductionAttempts: number,
    private planningRevisions: number,
    private environmentRetries: number,
    private wallClockMs: number,
    private modelTokens: number,
    private environmentResets: number,
    private destructiveActions: number,
  ) {}

  static open(budget: InvestigationBudget): InvestigationBudgetLedger {
    return InvestigationBudgetLedger.restore(budget, ZERO_USAGE);
  }

  /** Rehydrate a ledger from a persisted usage snapshot. */
  static restore(
    budget: InvestigationBudget,
    usage: InvestigationBudgetUsage,
  ): InvestigationBudgetLedger {
    return new InvestigationBudgetLedger(
      budget,
      usage.reproductionAttempts,
      usage.planningRevisions,
      usage.environmentRetries,
      usage.wallClockMs,
      usage.modelTokens,
      usage.environmentResets,
      usage.destructiveActions,
    );
  }

  usage(): InvestigationBudgetUsage {
    return {
      reproductionAttempts: this.reproductionAttempts,
      planningRevisions: this.planningRevisions,
      environmentRetries: this.environmentRetries,
      wallClockMs: this.wallClockMs,
      modelTokens: this.modelTokens,
      environmentResets: this.environmentResets,
      destructiveActions: this.destructiveActions,
    };
  }

  /** The immutable budget limits this ledger accounts against. */
  limits(): InvestigationBudget {
    return this.budget;
  }

  /** Consume a single planning revision (issuing or revising a reproduction plan). */
  consumePlanRevision(): BudgetConsumeResult {
    this.planningRevisions += 1;
    return this.evaluate();
  }

  /**
   * Consume the budget an appended Reproduction Attempt reports. The attempt/
   * environment count dimension is derived authoritatively from the outcome; the
   * resource dimensions are taken from the attempt's self-reported consumption.
   */
  consumeAttempt(attempt: ReproductionAttempt): BudgetConsumeResult {
    if (outcomeConsumesReproductionAttempt(attempt.outcome)) {
      this.reproductionAttempts += 1;
    } else {
      this.environmentRetries += 1;
    }
    const consumed = attempt.budgetConsumed;
    this.wallClockMs += nonNegative(consumed.wallClockMs, "wallClockMs");
    this.modelTokens += nonNegative(consumed.modelTokens, "modelTokens");
    this.environmentResets += nonNegative(
      consumed.environmentResets,
      "environmentResets",
    );
    this.destructiveActions += nonNegative(
      consumed.destructiveActions,
      "destructiveActions",
    );
    return this.evaluate();
  }

  private evaluate(): BudgetConsumeResult {
    const usage = this.usage();
    const exhaustedDimensions: BudgetDimension[] = [];
    if (usage.reproductionAttempts >= this.budget.maximumReproductionAttempts) {
      exhaustedDimensions.push("reproductionAttempts");
    }
    if (usage.planningRevisions >= this.budget.maximumPlanningRevisions) {
      exhaustedDimensions.push("planningRevisions");
    }
    if (usage.environmentRetries >= this.budget.maximumEnvironmentRetries) {
      exhaustedDimensions.push("environmentRetries");
    }
    if (usage.wallClockMs >= this.budget.maximumWallClockMs) {
      exhaustedDimensions.push("wallClockMs");
    }
    if (usage.modelTokens >= this.budget.maximumModelTokens) {
      exhaustedDimensions.push("modelTokens");
    }
    if (usage.environmentResets >= this.budget.maximumEnvironmentResets) {
      exhaustedDimensions.push("environmentResets");
    }
    if (usage.destructiveActions >= this.budget.maximumDestructiveActions) {
      exhaustedDimensions.push("destructiveActions");
    }
    return {
      usage,
      exhausted: exhaustedDimensions.length > 0,
      exhaustedDimensions,
    };
  }
}

function nonNegative(value: number, dimension: BudgetDimension): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Investigation budget dimension ${dimension} must be a non-negative finite number.`,
    );
  }
  return value;
}
