import type { InvestigationBudgetUsage } from "./investigation-budget.js";

/**
 * The deterministic outcome of a single reproduction attempt. `environment_failed`
 * denotes an infrastructure fault (the reproduction never truly ran) and is the
 * only outcome that consumes environment — not reproduction — budget.
 */
export type ReproductionOutcome =
  | "reproduced"
  | "not_reproduced"
  | "diverged"
  | "environment_failed"
  | "blocked";

/**
 * An immutable, append-only record of one attempt to reproduce a Finding under a
 * specific plan revision and environment. Attempts are never mutated or removed;
 * a new attempt is always appended with the next ordinal.
 */
export interface ReproductionAttempt {
  readonly attemptId: string;
  readonly caseId: string;
  readonly ordinal: number;
  readonly planRevision: number;
  readonly environmentRef: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: ReproductionOutcome;
  readonly divergenceStepId?: string;
  readonly evidenceRefs: readonly string[];
  readonly budgetConsumed: InvestigationBudgetUsage;
}

/**
 * The caller-supplied portion of an attempt. The aggregate stamps `caseId`,
 * `ordinal` and `planRevision` so those cannot be forged or reordered by a
 * Runner/Worker submission.
 */
export interface ReproductionAttemptDraft {
  readonly attemptId: string;
  readonly environmentRef: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: ReproductionOutcome;
  readonly divergenceStepId?: string;
  readonly evidenceRefs: readonly string[];
  readonly budgetConsumed: InvestigationBudgetUsage;
}
