import {
  isWithinRiskCeiling,
  type ActionRiskLevel,
  type ExplorationBudgetSnapshot,
  type ExplorationCheckpoint,
  type ExplorationDecision,
  type ExplorationPolicy,
  type ExplorationTerminalReason,
  type ProposedExplorationAction,
} from "@qualigence/mission";
import type { ObservationGraph, ObservationNode } from "@qualigence/runner-protocol";
import { ExplorationBudget, type MonotonicClock } from "./exploration-budget.js";
import { StateVisitTracker } from "./state-visit-tracker.js";

/** The immutable input to one exploration session. */
export interface ExplorationJob {
  readonly runId: string;
  readonly policy: ExplorationPolicy;
  readonly environment: "test" | "production";
}

/** The deterministic outcome of an exploration session. */
export interface ExplorationResult {
  readonly terminalReason: ExplorationTerminalReason;
  readonly errorCode?: string;
  readonly checkpoints: readonly ExplorationCheckpoint[];
  readonly stepsExecuted: number;
}

/** The read-only view of the world the model receives. It is never trusted for safety. */
export interface ExplorationContext {
  readonly runId: string;
  readonly graph: ObservationGraph;
  readonly visitedFingerprints: readonly string[];
  readonly allowedActionKinds: readonly string[];
  readonly riskCeiling: ExplorationPolicy["riskCeiling"];
  readonly remainingBudget: ExplorationBudgetSnapshot;
}

/** A model proposal plus the tokens it actually consumed, used to settle the budget. */
export interface ExplorationProposal {
  readonly decision: ExplorationDecision;
  readonly tokensUsed: number;
}

/** The model-facing port. It only ever proposes; it decides nothing. */
export interface ExplorationAgentPort {
  nextAction(context: ExplorationContext): Promise<ExplorationProposal>;
}

/** A grounded, risk-classified action the controller has authorized for execution. */
export interface GroundedExplorationAction {
  readonly kind: ProposedExplorationAction["kind"];
  readonly reason: string;
  readonly risk: ActionRiskLevel;
  readonly node?: ObservationNode;
  readonly path?: string;
  readonly valueRef?: string;
}

/** The live Target under exploration. */
export interface ExplorationTarget {
  capture(): Promise<ObservationGraph>;
  execute(action: GroundedExplorationAction): Promise<void>;
}

/** Deterministic risk classification of a candidate action; the model never sets risk. */
export interface ExplorationActionClassifier {
  classify(
    action: ProposedExplorationAction,
    graph: ObservationGraph,
    node: ObservationNode | undefined,
  ): ActionRiskLevel;
}

export type ExplorationPolicyDecision =
  | { readonly status: "allowed"; readonly reason: string }
  | { readonly status: "denied"; readonly reason: string };

/** The Runner Policy Gate, re-authorizing every action; its verdict is never overridable by the model. */
export interface ExplorationPolicyGate {
  authorize(
    action: GroundedExplorationAction,
    context: { readonly job: ExplorationJob },
  ): Promise<ExplorationPolicyDecision>;
}

/**
 * A conservative default classifier: navigation is read-only, clicks and inputs
 * are (at most) recoverable local mutations. Real adapters may override this with
 * Target-specific knowledge, but the ceiling check is always applied afterwards.
 */
export class DefaultExplorationActionClassifier implements ExplorationActionClassifier {
  classify(action: ProposedExplorationAction): ActionRiskLevel {
    switch (action.kind) {
      case "navigate":
        return "ReadOnly";
      case "click":
        return "LocalMutation";
      case "input":
        return "RecoverableMutation";
    }
  }
}

/** A gate that authorizes everything, for environments with no additional policy. */
export class AllowAllExplorationPolicyGate implements ExplorationPolicyGate {
  async authorize(): Promise<ExplorationPolicyDecision> {
    return { status: "allowed", reason: "no additional runner policy" };
  }
}

export interface ExplorationControllerDependencies {
  readonly target: ExplorationTarget;
  readonly agent: ExplorationAgentPort;
  readonly clock: MonotonicClock;
  readonly classifier?: ExplorationActionClassifier;
  readonly policyGate?: ExplorationPolicyGate;
  /** Estimated model tokens reserved before each invocation; settled with actuals afterwards. */
  readonly tokenReservationEstimate?: number;
}

const DEFAULT_TOKEN_ESTIMATE = 1_000;

/**
 * The deterministic Exploration Controller. It owns every safety, budget, state
 * and persistence decision; the model only proposes a candidate action.
 *
 * Each iteration: enforce the budget, observe, refuse a revisited state, invoke
 * the model within budget, ground and risk-check the proposal against the live
 * graph, re-authorize via the Policy Gate, then execute and checkpoint. Reaching
 * any bound stops cleanly — never an infinite loop or crash. Production
 * exploration is refused outright.
 */
export class ExplorationController {
  private readonly classifier: ExplorationActionClassifier;
  private readonly policyGate: ExplorationPolicyGate;
  private readonly tokenEstimate: number;

  constructor(private readonly deps: ExplorationControllerDependencies) {
    this.classifier = deps.classifier ?? new DefaultExplorationActionClassifier();
    this.policyGate = deps.policyGate ?? new AllowAllExplorationPolicyGate();
    this.tokenEstimate = deps.tokenReservationEstimate ?? DEFAULT_TOKEN_ESTIMATE;
  }

  async run(job: ExplorationJob): Promise<ExplorationResult> {
    if (job.environment === "production") {
      // Production exploration is denied outright — the model is never consulted.
      return terminal("policy_denied", [], 0, "ExplorationNotAllowed");
    }

    const budget = ExplorationBudget.from(job.policy, this.deps.clock);
    // Fixed revisit cap of 1: a fingerprinted state is never re-explored in a session.
    const tracker = new StateVisitTracker(1);
    const checkpoints: ExplorationCheckpoint[] = [];
    let stepsExecuted = 0;

    for (;;) {
      const step = budget.reserveStep();
      if (!step.ok) {
        return terminal("budget_exhausted", checkpoints, stepsExecuted, "ExplorationBudgetExceeded");
      }
      const wall = budget.checkWallClock();
      if (!wall.ok) {
        return terminal("budget_exhausted", checkpoints, stepsExecuted, "ExplorationBudgetExceeded");
      }

      const graph = await this.deps.target.capture();
      const fingerprint = tracker.fingerprintOf(graph);
      const visit = tracker.record(fingerprint);
      if (visit.status === "repeated") {
        checkpoints.push(checkpoint(checkpoints.length + 1, fingerprint, budget.snapshot(), "state_repeated"));
        return terminal("state_repeated", checkpoints, stepsExecuted, "RepeatedState");
      }

      const stateVisit = budget.reserveStateVisit();
      if (!stateVisit.ok) {
        return terminal("budget_exhausted", checkpoints, stepsExecuted, "ExplorationBudgetExceeded");
      }

      const tokenReservation = budget.reserveModelTokens(this.tokenEstimate);
      if (!tokenReservation.ok) {
        return terminal("budget_exhausted", checkpoints, stepsExecuted, "ExplorationBudgetExceeded");
      }

      const context: ExplorationContext = {
        runId: job.runId,
        graph,
        visitedFingerprints: [fingerprint],
        allowedActionKinds: job.policy.allowedActionKinds,
        riskCeiling: job.policy.riskCeiling,
        remainingBudget: budget.snapshot(),
      };

      const proposal = await this.deps.agent.nextAction(context);
      budget.settleModelTokens(this.tokenEstimate, proposal.tokensUsed);

      const decision = proposal.decision;
      if (decision.status === "stop") {
        checkpoints.push(checkpoint(checkpoints.length + 1, fingerprint, budget.snapshot(), "objective_satisfied"));
        return terminal("objective_satisfied", checkpoints, stepsExecuted);
      }

      const validated = validateProposal(decision.action, graph, job.policy, this.classifier);
      if (!validated.ok) {
        checkpoints.push(checkpoint(checkpoints.length + 1, fingerprint, budget.snapshot(), validated.reason));
        return terminal(validated.reason, checkpoints, stepsExecuted, validated.errorCode);
      }

      const authorization = await this.policyGate.authorize(validated.action, { job });
      if (authorization.status === "denied") {
        checkpoints.push(checkpoint(checkpoints.length + 1, fingerprint, budget.snapshot(), "policy_denied"));
        return terminal("policy_denied", checkpoints, stepsExecuted, "PolicyDenied");
      }

      await this.deps.target.execute(validated.action);
      stepsExecuted += 1;
      checkpoints.push(checkpoint(checkpoints.length + 1, fingerprint, budget.snapshot()));
    }
  }
}

type ValidationResult =
  | { readonly ok: true; readonly action: GroundedExplorationAction }
  | {
      readonly ok: false;
      readonly reason: ExplorationTerminalReason;
      readonly errorCode: string;
    };

/**
 * Grounds a model proposal against the live graph and rejects anything unsafe
 * before it can be executed: a missing/unknown/stale node, a disallowed action
 * kind, or a risk above the policy ceiling. This mirrors LS-08's induction
 * grounding — the model never gets to reference a node the runner cannot see.
 */
function validateProposal(
  action: ProposedExplorationAction | undefined,
  graph: ObservationGraph,
  policy: ExplorationPolicy,
  classifier: ExplorationActionClassifier,
): ValidationResult {
  if (action === undefined) {
    return { ok: false, reason: "no_safe_action", errorCode: "MalformedProposal" };
  }
  if (!policy.allowedActionKinds.includes(action.kind)) {
    return { ok: false, reason: "no_safe_action", errorCode: "UnsafeExplorationAction" };
  }

  let node: ObservationNode | undefined;
  if (action.kind === "click" || action.kind === "input") {
    if (action.nodeId === undefined) {
      return { ok: false, reason: "no_safe_action", errorCode: "UnknownNode" };
    }
    node = graph.nodes.find((candidate) => candidate.id === action.nodeId);
    if (node === undefined) {
      // Unknown or stale nodeId — grounding failure.
      return { ok: false, reason: "no_safe_action", errorCode: "UnknownNode" };
    }
    if (action.kind === "input" && action.valueRef === undefined) {
      return { ok: false, reason: "no_safe_action", errorCode: "MalformedProposal" };
    }
  } else if (action.path === undefined) {
    return { ok: false, reason: "no_safe_action", errorCode: "MalformedProposal" };
  }

  const risk = classifier.classify(action, graph, node);
  if (!isWithinRiskCeiling(risk, policy.riskCeiling)) {
    // Destructive / ExternalSideEffect / ProductionForbidden actions never auto-execute.
    return { ok: false, reason: "no_safe_action", errorCode: "UnsafeExplorationAction" };
  }

  return {
    ok: true,
    action: {
      kind: action.kind,
      reason: action.reason,
      risk,
      ...(node === undefined ? {} : { node }),
      ...(action.path === undefined ? {} : { path: action.path }),
      ...(action.valueRef === undefined ? {} : { valueRef: action.valueRef }),
    },
  };
}

function checkpoint(
  step: number,
  graphFingerprint: string,
  remaining: ExplorationBudgetSnapshot,
  terminalReason?: ExplorationTerminalReason,
): ExplorationCheckpoint {
  return {
    step,
    graphFingerprint,
    remaining,
    ...(terminalReason === undefined ? {} : { terminalReason }),
  };
}

function terminal(
  reason: ExplorationTerminalReason,
  checkpoints: readonly ExplorationCheckpoint[],
  stepsExecuted: number,
  errorCode?: string,
): ExplorationResult {
  return {
    terminalReason: reason,
    checkpoints,
    stepsExecuted,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}
