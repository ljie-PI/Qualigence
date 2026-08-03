/**
 * Frozen contracts for LS-09 bounded exploration and Verified-Skill regression.
 *
 * These are pure domain values: no infrastructure, no model SDK, no runner
 * dependency. The deterministic Exploration Controller (a runner component) and
 * the model-facing Exploration Agent both import these shapes from Core so that
 * neither layer redefines the safety, budget or terminal-reason vocabulary.
 *
 * The model only ever emits an {@link ExplorationDecision}; every budget, risk,
 * grounding and persistence decision is owned by deterministic code.
 */

/** A single regression pass over one Verified Skill Bundle. */
export interface RegressionJobPlan {
  readonly skillBundleId: string;
  readonly targetVersion: string;
  readonly repetitions: number;
  readonly stopOnFirstFailure: boolean;
}

/**
 * The risk classification of a concrete action, ordered from safest to most
 * dangerous. Exploration in M2 may never exceed `RecoverableMutation`; anything
 * at or above `Destructive` is always rejected during unsupervised exploration.
 */
export type ActionRiskLevel =
  | "ReadOnly"
  | "LocalMutation"
  | "RecoverableMutation"
  | "Destructive"
  | "ExternalSideEffect"
  | "ProductionForbidden";

/** The bounded risk ceiling an exploration policy may authorise. */
export type ExplorationRiskCeiling = "ReadOnly" | "LocalMutation" | "RecoverableMutation";

const RISK_ORDER: readonly ActionRiskLevel[] = [
  "ReadOnly",
  "LocalMutation",
  "RecoverableMutation",
  "Destructive",
  "ExternalSideEffect",
  "ProductionForbidden",
];

/** Numeric rank of a risk level; higher is more dangerous. */
export function riskRank(level: ActionRiskLevel): number {
  const index = RISK_ORDER.indexOf(level);
  if (index < 0) {
    throw new Error(`Unknown action risk level: ${String(level)}`);
  }
  return index;
}

/** True only when `level` is at or below the policy `ceiling`. */
export function isWithinRiskCeiling(
  level: ActionRiskLevel,
  ceiling: ExplorationRiskCeiling,
): boolean {
  return riskRank(level) <= riskRank(ceiling);
}

/**
 * A deterministic, bounded exploration policy. Every numeric field is an upper
 * bound; reaching any of them stops exploration before the next action.
 */
export interface ExplorationPolicy {
  readonly seedSkillBundleIds: readonly string[];
  readonly allowedActionKinds: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly maximumSteps: number;
  readonly maximumWallClockMs: number;
  readonly maximumModelTokens: number;
  readonly maximumStateVisits: number;
  readonly maximumRecoveries: number;
  readonly riskCeiling: ExplorationRiskCeiling;
}

/** A kind of action the model may propose. */
export type ExplorationActionKind = "navigate" | "click" | "input";

/**
 * A model-proposed candidate action. It references Target semantics only by a
 * `nodeId` drawn from the current Observation Graph (validated by the
 * controller) — never a selector, coordinate or script.
 */
export interface ProposedExplorationAction {
  readonly kind: ExplorationActionKind;
  readonly nodeId?: string;
  readonly path?: string;
  readonly valueRef?: string;
  readonly reason: string;
}

/** The model's proposal for a single exploration step. */
export interface ExplorationDecision {
  readonly status: "act" | "stop";
  readonly action?: ProposedExplorationAction;
  readonly reason: string;
  readonly expectedNovelty?: string;
}

/** Remaining headroom across every budget dimension. */
export interface ExplorationBudgetSnapshot {
  readonly remainingSteps: number;
  readonly remainingWallClockMs: number;
  readonly remainingModelTokens: number;
  readonly remainingStateVisits: number;
  readonly remainingRecoveries: number;
}

/** The frozen set of reasons an exploration session terminates. */
export type ExplorationTerminalReason =
  | "objective_satisfied"
  | "no_safe_action"
  | "state_repeated"
  | "budget_exhausted"
  | "policy_denied"
  | "plan_diverged"
  | "finding_created"
  | "error";

/** An immutable per-step record saved atomically with budget consumption. */
export interface ExplorationCheckpoint {
  readonly step: number;
  readonly graphFingerprint: string;
  readonly remaining: ExplorationBudgetSnapshot;
  readonly terminalReason?: ExplorationTerminalReason;
}

/**
 * Validates and normalizes an exploration policy. Rejects negative bounds and an
 * out-of-range risk ceiling so that neither the budget nor the controller has to
 * defend against malformed input mid-session.
 */
export function validateExplorationPolicy(policy: ExplorationPolicy): ExplorationPolicy {
  const bounds: readonly [keyof ExplorationPolicy, number][] = [
    ["maximumSteps", policy.maximumSteps],
    ["maximumWallClockMs", policy.maximumWallClockMs],
    ["maximumModelTokens", policy.maximumModelTokens],
    ["maximumStateVisits", policy.maximumStateVisits],
    ["maximumRecoveries", policy.maximumRecoveries],
  ];
  for (const [name, value] of bounds) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Exploration policy ${String(name)} must not be negative.`);
    }
  }
  if (!isExplorationRiskCeiling(policy.riskCeiling)) {
    throw new Error(`Exploration policy riskCeiling ${String(policy.riskCeiling)} is out of range.`);
  }
  return policy;
}

function isExplorationRiskCeiling(value: string): value is ExplorationRiskCeiling {
  return value === "ReadOnly" || value === "LocalMutation" || value === "RecoverableMutation";
}
