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

export interface ApprovedExecutionPolicy {
  readonly policyId: string;
  readonly environment: "isolated_test" | "staging" | "production";
  readonly allowedOrigins: readonly string[];
  readonly allowedActionKinds: readonly ("navigate" | "click" | "input" | "select" | "scroll" | "window")[];
  readonly maximumRisk: "Normal" | "ExternalSideEffect" | "Destructive" | "ProductionForbidden";
  readonly explorationAllowed: boolean;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export function validateApprovedExecutionPolicy(
  policy: ApprovedExecutionPolicy,
  maximumWallClockMs: number,
): ApprovedExecutionPolicy {
  const issued = Date.parse(policy.issuedAt);
  const expires = Date.parse(policy.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued >= expires) {
    throw new Error("Execution policy expiry must be after issue time.");
  }
  if (expires > issued + maximumWallClockMs || policy.allowedOrigins.length === 0) {
    throw new Error("Execution policy exceeds the Mission execution budget.");
  }
  for (const origin of policy.allowedOrigins) {
    if (origin.includes("*")) {
      throw new Error("Execution policy origin must not contain a wildcard.");
    }
    const parsed = new URL(origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin || parsed.username !== "" || parsed.password !== "") {
      throw new Error("Execution policy origin must be canonical HTTP(S) without credentials.");
    }
  }
  if (policy.environment === "staging") {
    if (
      policy.allowedActionKinds.length !== 1 || policy.allowedActionKinds[0] !== "click" ||
      policy.maximumRisk !== "Normal" || policy.explorationAllowed
    ) {
      throw new Error("Staging policy must be an explicit bounded click-only declaration.");
    }
  }
  return policy;
}

/** Converts validated exploration limits only when they can narrow approved authority. */
export function narrowApprovedExecutionPolicy(
  approved: ApprovedExecutionPolicy,
  exploration: ExplorationPolicy,
): ApprovedExecutionPolicy {
  validateExplorationPolicy(exploration);
  if (approved.environment === "production" || !approved.explorationAllowed) {
    throw new Error("Exploration is not permitted by the approved execution policy.");
  }
  if (
    exploration.allowedOrigins.some((origin) => !approved.allowedOrigins.includes(origin)) ||
    exploration.allowedActionKinds.some((kind) => !approved.allowedActionKinds.includes(kind as ApprovedExecutionPolicy["allowedActionKinds"][number]))
  ) {
    throw new Error("Exploration policy would expand approved execution authority.");
  }
  const maximumRisk = exactExecutionRiskFor(exploration.riskCeiling);
  if (executionRiskRank(maximumRisk) > executionRiskRank(approved.maximumRisk)) {
    throw new Error("Exploration policy risk ceiling would expand approved execution authority.");
  }
  return {
    ...approved,
    allowedOrigins: [...exploration.allowedOrigins],
    allowedActionKinds: exploration.allowedActionKinds as ApprovedExecutionPolicy["allowedActionKinds"],
    maximumRisk,
  };
}

function exactExecutionRiskFor(ceiling: ExplorationRiskCeiling): ApprovedExecutionPolicy["maximumRisk"] {
  // ReadOnly maps exactly to the Runner's Normal authority. Mutation ceilings
  // have no exact Task 15 snapshot counterpart, so representing either as an
  // ExternalSideEffect grant would widen the approved exploration authority.
  if (ceiling !== "ReadOnly") {
    throw new Error("Exploration policy risk ceiling has no exact execution policy mapping.");
  }
  return "Normal";
}

function executionRiskRank(risk: ApprovedExecutionPolicy["maximumRisk"]): number {
  return ["Normal", "ExternalSideEffect", "Destructive", "ProductionForbidden"].indexOf(risk);
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
