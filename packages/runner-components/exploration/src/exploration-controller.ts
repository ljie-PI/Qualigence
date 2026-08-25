import {
  isWithinRiskCeiling,
  type ActionRiskLevel,
  type ExplorationAttemptProgress,
  type ExplorationBudgetSnapshot,
  type ExplorationCheckpoint,
  type ExplorationDecision,
  type ExplorationInFlightAction,
  type ExplorationPolicy,
  type ExplorationSeedCursor,
  type ExplorationTerminalReason,
  type ProposedExplorationAction,
} from "@qualigence/mission";
import {
  ObservationError,
  canonicalPayloadHash,
  type ObservationGraphV1,
  type ObservationNodeV1,
} from "@qualigence/runner-protocol";
import { ExplorationBudget, type MonotonicClock } from "./exploration-budget.js";
import { StateVisitTracker } from "./state-visit-tracker.js";
import { requireWebV1Semantics, validateConsumerObservationGraph, webV1LocationHref } from "./observation-v1-consumer.js";
import type { RegressionJobResult, RegressionSeed } from "./regression-job.js";

/** The immutable input to one exploration session. */
export interface ExplorationJob {
  readonly runId: string;
  readonly policy: ExplorationPolicy;
  readonly environment: "test" | "production";
  /** Stable attempt identity for durable resume. */
  readonly attemptId: string;
  /** Stable source binding supplied by the benchmark/run manifest. */
  readonly sourceBindingHash: string;
  /** Verified Skill seeds configured by policy.seedSkillBundleIds. */
  readonly seedSkills?: readonly RegressionSeed[];
}

/** The deterministic outcome of an exploration session. */
export interface ExplorationResult {
  readonly terminalReason: ExplorationTerminalReason;
  readonly errorCode?: string;
  readonly checkpoints: readonly ExplorationCheckpoint[];
  readonly stepsExecuted: number;
  readonly seedReplays: readonly RegressionJobResult[];
}

/** The read-only view of the world the model receives. It is never trusted for safety. */
export interface ExplorationContext {
  readonly runId: string;
  readonly graph: ObservationGraphV1;
  readonly visitedFingerprints: readonly string[];
  readonly allowedActionKinds: readonly string[];
  readonly riskCeiling: ExplorationPolicy["riskCeiling"];
  readonly remainingBudget: ExplorationBudgetSnapshot;
}

/** A model proposal plus the tokens it actually consumed, used to settle the budget. */
export interface ExplorationProposal {
  readonly decision: ExplorationDecision;
  readonly tokensUsed?: number;
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
  readonly node?: ObservationNodeV1;
  readonly path?: string;
  readonly valueRef?: string;
}

/** The live Target under exploration. */
export interface ExplorationTarget {
  capture(): Promise<ObservationGraphV1>;
  execute(action: GroundedExplorationAction): Promise<void>;
  /** Deterministic environment reset/recovery. It is never used for unknown action outcomes. */
  recover?(): Promise<void>;
}

/** Deterministic risk classification of a candidate action; the model never sets risk. */
export interface ExplorationActionClassifier {
  classify(
    action: ProposedExplorationAction,
    graph: ObservationGraphV1,
    node: ObservationNodeV1 | undefined,
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

export interface ExplorationSeedReplayPort {
  replay(seed: RegressionSeed): Promise<RegressionJobResult>;
}

export interface ExplorationProgressUpdate {
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly phase: ExplorationAttemptProgress["phase"];
  readonly seedCursor: ExplorationSeedCursor;
  readonly lastSafeStep: number;
  readonly lastSafeGraphFingerprint?: string | undefined;
  readonly remaining: ExplorationBudgetSnapshot;
  readonly inFlightAction?: ExplorationInFlightAction | undefined;
  readonly terminalReason?: ExplorationTerminalReason | undefined;
  readonly checkpoint?: ExplorationCheckpoint | undefined;
}

export type ExplorationProgressUpdateResult =
  | { readonly status: "updated"; readonly progress: ExplorationAttemptProgress }
  | { readonly status: "conflict"; readonly current?: ExplorationAttemptProgress | undefined };

export interface NewExplorationAttemptProgress {
  readonly attemptId: string;
  readonly runId: string;
  readonly sourceBindingHash: string;
  readonly policyBindingHash: string;
  readonly seedBindingHash: string;
  readonly phase: ExplorationAttemptProgress["phase"];
  readonly seedCursor: ExplorationSeedCursor;
  readonly lastSafeStep: number;
  readonly lastSafeGraphFingerprint?: string | undefined;
  readonly remaining: ExplorationBudgetSnapshot;
  readonly inFlightAction?: ExplorationInFlightAction | undefined;
  readonly terminalReason?: ExplorationTerminalReason | undefined;
}

export interface ExplorationProgressStore {
  loadAttemptProgress(attemptId: string): Promise<ExplorationAttemptProgress | undefined>;
  initializeAttemptProgress(progress: NewExplorationAttemptProgress): Promise<ExplorationAttemptProgress>;
  compareAndSetAttemptProgress(update: ExplorationProgressUpdate): Promise<ExplorationProgressUpdateResult>;
  liveCheckpointsForAttempt(attemptId: string): Promise<readonly ExplorationCheckpoint[]>;
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
  readonly seedReplay?: ExplorationSeedReplayPort;
  readonly progressStore: ExplorationProgressStore;
  /** Estimated model tokens reserved before each invocation; settled with actuals afterwards. */
  readonly tokenReservationEstimate?: number;
}

interface AttemptBindings {
  readonly attemptId: string;
  readonly runId: string;
  readonly sourceBindingHash: string;
  readonly policyBindingHash: string;
  readonly seedBindingHash: string;
}

interface RunState {
  progress: ExplorationAttemptProgress;
  budget: ExplorationBudget;
  tracker: StateVisitTracker;
  checkpoints: ExplorationCheckpoint[];
  seedReplays: RegressionJobResult[];
  seedCursor: ExplorationSeedCursor;
  stepsExecuted: number;
}

const DEFAULT_TOKEN_ESTIMATE = 1_000;

/**
 * The deterministic Exploration Controller. It owns every safety, budget, state
 * and persistence decision; the model only proposes a candidate action.
 *
 * Each iteration: enforce the budget, observe, refuse a revisited state, invoke
 * the model within budget, ground and risk-check the proposal against the live
 * graph, re-authorize via the Policy Gate, persist `action_in_flight`, then
 * execute and checkpoint only after a known-safe outcome. Reaching any bound
 * stops cleanly — never an infinite loop or crash. Production exploration is
 * refused outright.
 */
export class ExplorationController {
  private readonly classifier: ExplorationActionClassifier;
  private readonly policyGate: ExplorationPolicyGate;
  private readonly tokenEstimate: number;

  constructor(private readonly deps: ExplorationControllerDependencies) {
    if (deps.progressStore === undefined) {
      throw new Error("ExplorationProgressStoreRequired");
    }
    this.classifier = deps.classifier ?? new DefaultExplorationActionClassifier();
    this.policyGate = deps.policyGate ?? new AllowAllExplorationPolicyGate();
    this.tokenEstimate = deps.tokenReservationEstimate ?? DEFAULT_TOKEN_ESTIMATE;
  }

  async run(job: ExplorationJob): Promise<ExplorationResult> {
    if (job.environment === "production") {
      // Production exploration is denied outright — the model is never consulted.
      return terminal("policy_denied", [], 0, [], "ExplorationNotAllowed");
    }

    const attemptBindingValidation = validateAttemptBinding(job);
    if (!attemptBindingValidation.ok) {
      throw new Error(attemptBindingValidation.errorCode);
    }

    const seedValidation = validateSeeds(job);
    if (!seedValidation.ok) {
      return terminal(seedValidation.reason, [], 0, [], seedValidation.errorCode);
    }

    const bindings = attemptBindings(job);
    const loaded = await this.loadOrInitializeState(job, bindings);
    if (loaded.status === "terminal") return loaded.result;
    if (loaded.status === "error") return loaded.result;

    const state = loaded.state;
    const seedResult = await this.replaySeeds(job, state);
    if (seedResult !== undefined) return seedResult;

    if (state.progress.phase === "seed_replay") {
      const advanced = await this.updateProgress(state, {
        phase: "exploring",
        seedCursor: state.seedCursor,
        lastSafeStep: state.stepsExecuted,
        lastSafeGraphFingerprint: lastSafeFingerprint(state),
        remaining: state.budget.snapshot(),
      });
      if (advanced.status !== "updated") {
        return terminal("error", state.checkpoints, state.stepsExecuted, state.seedReplays, "ExplorationProgressConflict");
      }
    }

    for (;;) {
      const wall = state.budget.checkWallClock();
      if (!wall.ok) {
        return this.finish(state, "budget_exhausted", "ExplorationBudgetExceeded");
      }

      const capture = await this.captureWithRecovery(state);
      if (!capture.ok) return capture.result;

      const validation = validateLiveGraph(capture.graph);
      if (!validation.ok) {
        return this.finish(state, "error", validation.errorCode);
      }

      const graph = validation.graph;
      const fingerprint = state.tracker.fingerprintOf(graph);
      if (!isGraphOriginAllowed(graph, job.policy)) {
        appendTerminalCheckpoint(state, fingerprint, "policy_denied");
        return this.finish(state, "policy_denied", "OriginViolation");
      }
      const visit = state.tracker.record(fingerprint);
      if (visit.status === "repeated") {
        const repeated = checkpoint(state.checkpoints.length + 1, fingerprint, state.budget.snapshot(), "state_repeated");
        state.checkpoints.push(repeated);
        return this.finish(state, "state_repeated", "RepeatedState");
      }
      const stateVisit = state.budget.reserveStateVisit();
      if (!stateVisit.ok) {
        appendTerminalCheckpoint(state, fingerprint, "budget_exhausted");
        return this.finish(state, "budget_exhausted", "ExplorationBudgetExceeded");
      }

      const step = state.budget.reserveStep();
      if (!step.ok) {
        appendTerminalCheckpoint(state, fingerprint, "budget_exhausted");
        return this.finish(state, "budget_exhausted", "ExplorationBudgetExceeded");
      }

      const tokenReservation = state.budget.reserveModelTokens(this.tokenEstimate);
      if (!tokenReservation.ok) {
        appendTerminalCheckpoint(state, fingerprint, "budget_exhausted");
        return this.finish(state, "budget_exhausted", "ExplorationBudgetExceeded");
      }

      const context: ExplorationContext = {
        runId: job.runId,
        graph,
        visitedFingerprints: [fingerprint],
        allowedActionKinds: job.policy.allowedActionKinds,
        riskCeiling: job.policy.riskCeiling,
        remainingBudget: state.budget.snapshot(),
      };

      let proposal: ExplorationProposal;
      try {
        proposal = await this.deps.agent.nextAction(context);
      } catch {
        appendTerminalCheckpoint(state, fingerprint, "error");
        return this.finish(state, "error", "ExplorationModelUnavailable");
      }
      if (proposal.tokensUsed === undefined) {
        appendTerminalCheckpoint(state, fingerprint, "error");
        return this.finish(state, "error", "ModelUsageUnavailable");
      }
      const tokenSettlement = state.budget.settleModelTokens(this.tokenEstimate, proposal.tokensUsed);
      if (!tokenSettlement.ok) {
        appendTerminalCheckpoint(state, fingerprint, "budget_exhausted");
        return this.finish(state, "budget_exhausted", "ExplorationBudgetExceeded");
      }

      const decision = proposal.decision;
      if (decision.status === "stop") {
        const satisfied = checkpoint(state.checkpoints.length + 1, fingerprint, state.budget.snapshot(), "objective_satisfied");
        state.checkpoints.push(satisfied);
        return this.finish(state, "objective_satisfied");
      }

      const validated = validateProposal(decision.action, graph, job.policy, this.classifier);
      if (!validated.ok) {
        const rejected = checkpoint(state.checkpoints.length + 1, fingerprint, state.budget.snapshot(), validated.reason);
        state.checkpoints.push(rejected);
        return this.finish(state, validated.reason, validated.errorCode);
      }

      const authorization = await this.policyGate.authorize(validated.action, { job });
      if (authorization.status === "denied") {
        const denied = checkpoint(state.checkpoints.length + 1, fingerprint, state.budget.snapshot(), "policy_denied");
        state.checkpoints.push(denied);
        return this.finish(state, "policy_denied", "PolicyDenied");
      }

      const actionStep = state.stepsExecuted + 1;
      const inFlightAction = inFlight(actionStep, validated.action);
      const inFlightUpdate = await this.updateProgress(state, {
        phase: "action_in_flight",
        seedCursor: state.seedCursor,
        lastSafeStep: state.stepsExecuted,
        lastSafeGraphFingerprint: lastSafeFingerprint(state),
        remaining: state.budget.snapshot(),
        inFlightAction,
      });
      if (inFlightUpdate.status !== "updated") {
        return terminal("error", state.checkpoints, state.stepsExecuted, state.seedReplays, "ExplorationProgressConflict");
      }

      try {
        await this.deps.target.execute(validated.action);
      } catch {
        return this.finish(state, "error", "ActionOutcomeUnknown");
      }

      state.stepsExecuted = actionStep;
      const safe = checkpoint(actionStep, fingerprint, state.budget.snapshot());
      state.checkpoints.push(safe);
      const checkpointUpdate = await this.updateProgress(state, {
        phase: "exploring",
        seedCursor: state.seedCursor,
        lastSafeStep: state.stepsExecuted,
        lastSafeGraphFingerprint: fingerprint,
        remaining: state.budget.snapshot(),
        checkpoint: safe,
      });
      if (checkpointUpdate.status !== "updated") {
        return terminal("error", state.checkpoints, state.stepsExecuted, state.seedReplays, "ExplorationCheckpointPersistenceFailed");
      }
    }
  }

  private async loadOrInitializeState(
    job: ExplorationJob,
    bindings: AttemptBindings,
  ): Promise<
    | { readonly status: "running"; readonly state: RunState }
    | { readonly status: "terminal"; readonly result: ExplorationResult }
    | { readonly status: "error"; readonly result: ExplorationResult }
  > {
    const store = this.deps.progressStore;
    const initialBudget = ExplorationBudget.from(job.policy, this.deps.clock);
    const initial = await store.initializeAttemptProgress({
      ...bindings,
      phase: "seed_replay",
      seedCursor: emptySeedCursor(),
      lastSafeStep: 0,
      remaining: initialBudget.snapshot(),
    });

    if (!bindingsMatch(initial, bindings)) {
      return {
        status: "error",
        result: terminal("error", [], 0, [], "ExplorationProgressBindingConflict"),
      };
    }

    if (initial.phase === "action_in_flight") {
      const marked = await store.compareAndSetAttemptProgress({
        attemptId: initial.attemptId,
        expectedVersion: initial.version,
        phase: "terminal",
        seedCursor: initial.seedCursor,
        lastSafeStep: initial.lastSafeStep,
        lastSafeGraphFingerprint: initial.lastSafeGraphFingerprint,
        remaining: initial.remaining,
        inFlightAction: initial.inFlightAction,
        terminalReason: "error",
      });
      if (marked.status !== "updated") {
        return {
          status: "error",
          result: terminal("error", await store.liveCheckpointsForAttempt(bindings.attemptId), initial.lastSafeStep, [], "ExplorationProgressConflict"),
        };
      }
      return {
        status: "terminal",
        result: terminal("error", await store.liveCheckpointsForAttempt(bindings.attemptId), marked.progress.lastSafeStep, [], "ActionOutcomeUnknown"),
      };
    }

    const checkpoints = [...await store.liveCheckpointsForAttempt(initial.attemptId)];
    if (initial.phase === "terminal") {
      return {
        status: "terminal",
        result: terminal(initial.terminalReason ?? "error", checkpoints, initial.lastSafeStep, []),
      };
    }

    const tracker = new StateVisitTracker(Math.max(1, job.policy.maximumStateVisits));
    const restoredFingerprints = new Set<string>();
    for (const existing of checkpoints) {
      tracker.restore(existing.graphFingerprint);
      restoredFingerprints.add(existing.graphFingerprint);
    }
    if (
      initial.lastSafeGraphFingerprint !== undefined &&
      !restoredFingerprints.has(initial.lastSafeGraphFingerprint)
    ) {
      tracker.restore(initial.lastSafeGraphFingerprint);
    }

    return {
      status: "running",
      state: {
        progress: initial,
        budget: ExplorationBudget.resumeFromSnapshot(initial.remaining, this.deps.clock),
        tracker,
        checkpoints,
        seedReplays: [],
        seedCursor: initial.seedCursor,
        stepsExecuted: initial.lastSafeStep,
      },
    };
  }

  private async replaySeeds(
    job: ExplorationJob,
    state: RunState,
  ): Promise<ExplorationResult | undefined> {
    const seeds = job.seedSkills ?? [];
    if (seeds.length === 0) return undefined;
    if (state.seedCursor.inFlightSeedSkillBundleId !== undefined) {
      return this.finish(state, "error", "SeedReplayOutcomeUnknown");
    }
    const replay = this.deps.seedReplay;
    if (replay === undefined) {
      return this.finish(state, "no_safe_action", "MissingSeedReplayPort");
    }

    for (let index = state.seedCursor.nextSeedIndex; index < seeds.length; index += 1) {
      const seed = seeds[index];
      if (seed === undefined) return this.finish(state, "no_safe_action", "SeedBindingConflict");
      const inFlightSeedCursor = {
        nextSeedIndex: state.seedCursor.nextSeedIndex,
        completedSeedSkillBundleIds: state.seedCursor.completedSeedSkillBundleIds,
        inFlightSeedSkillBundleId: seed.plan.skillBundleId,
      };
      const inFlightUpdate = await this.updateProgress(state, {
        phase: "seed_replay",
        seedCursor: inFlightSeedCursor,
        lastSafeStep: state.stepsExecuted,
        lastSafeGraphFingerprint: lastSafeFingerprint(state),
        remaining: state.budget.snapshot(),
      });
      if (inFlightUpdate.status !== "updated") {
        return terminal("error", state.checkpoints, state.stepsExecuted, state.seedReplays, "ExplorationProgressConflict");
      }
      state.seedCursor = inFlightSeedCursor;
      const result = await replay.replay(seed);
      state.seedReplays.push(result);
      if (result.status !== "passed") {
        return this.finish(state, "plan_diverged", "SeedReplayFailed");
      }
      const nextSeedCursor = {
        nextSeedIndex: index + 1,
        completedSeedSkillBundleIds: [...state.seedCursor.completedSeedSkillBundleIds, seed.plan.skillBundleId],
      };
      const update = await this.updateProgress(state, {
        phase: index + 1 === seeds.length ? "exploring" : "seed_replay",
        seedCursor: nextSeedCursor,
        lastSafeStep: state.stepsExecuted,
        lastSafeGraphFingerprint: lastSafeFingerprint(state),
        remaining: state.budget.snapshot(),
      });
      if (update.status !== "updated") {
        return terminal("error", state.checkpoints, state.stepsExecuted, state.seedReplays, "ExplorationProgressConflict");
      }
      state.seedCursor = nextSeedCursor;
    }
    return undefined;
  }

  private async captureWithRecovery(
    state: RunState,
  ): Promise<{ readonly ok: true; readonly graph: ObservationGraphV1 } | { readonly ok: false; readonly result: ExplorationResult }> {
    try {
      return { ok: true, graph: await this.deps.target.capture() };
    } catch {
      if (this.deps.target.recover === undefined) {
        return { ok: false, result: await this.finish(state, "error", "EnvironmentRecoveryUnavailable") };
      }
      const recovery = state.budget.reserveRecovery();
      if (!recovery.ok) {
        return { ok: false, result: await this.finish(state, "budget_exhausted", "ExplorationBudgetExceeded") };
      }
      try {
        await this.deps.target.recover();
        return { ok: true, graph: await this.deps.target.capture() };
      } catch {
        return { ok: false, result: await this.finish(state, "error", "EnvironmentRecoveryFailed") };
      }
    }
  }

  private async finish(
    state: RunState,
    reason: ExplorationTerminalReason,
    errorCode?: string,
  ): Promise<ExplorationResult> {
    if (state.progress.phase !== "terminal") {
      const terminalCheckpoint = state.checkpoints.at(-1);
      const update = await this.updateProgress(state, {
        phase: "terminal",
        seedCursor: state.seedCursor,
        lastSafeStep: state.stepsExecuted,
        lastSafeGraphFingerprint: lastSafeFingerprint(state),
        remaining: state.budget.snapshot(),
        inFlightAction: state.progress.inFlightAction,
        terminalReason: reason,
        ...(terminalCheckpoint?.terminalReason === reason ? { checkpoint: terminalCheckpoint } : {}),
      });
      if (update.status !== "updated") {
        return terminal("error", state.checkpoints, state.stepsExecuted, state.seedReplays, "ExplorationTerminalPersistenceFailed");
      }
    }
    return terminal(reason, state.checkpoints, state.stepsExecuted, state.seedReplays, errorCode);
  }

  private async updateProgress(
    state: RunState,
    update: Omit<ExplorationProgressUpdate, "attemptId" | "expectedVersion">,
  ): Promise<ExplorationProgressUpdateResult> {
    const progress = state.progress;
    const result = await this.deps.progressStore.compareAndSetAttemptProgress({
      attemptId: progress.attemptId,
      expectedVersion: progress.version,
      ...update,
    });
    if (result.status === "updated") {
      state.progress = result.progress;
    }
    return result;
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
  graph: ObservationGraphV1,
  policy: ExplorationPolicy,
  classifier: ExplorationActionClassifier,
): ValidationResult {
  if (action === undefined) {
    return { ok: false, reason: "no_safe_action", errorCode: "MalformedProposal" };
  }
  if (!policy.allowedActionKinds.includes(action.kind)) {
    return { ok: false, reason: "no_safe_action", errorCode: "UnsafeExplorationAction" };
  }
  if (!isGraphOriginAllowed(graph, policy)) {
    return { ok: false, reason: "policy_denied", errorCode: "OriginViolation" };
  }
  if (action.kind === "navigate" && !isNavigationTargetAllowed(action, graph, policy)) {
    return { ok: false, reason: "policy_denied", errorCode: "OriginViolation" };
  }

  let node: ObservationNodeV1 | undefined;
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

function isGraphOriginAllowed(graph: ObservationGraphV1, policy: ExplorationPolicy): boolean {
  return policy.allowedOrigins.includes(requireWebV1Semantics(graph).origin);
}

function isNavigationTargetAllowed(
  action: ProposedExplorationAction,
  graph: ObservationGraphV1,
  policy: ExplorationPolicy,
): boolean {
  if (action.path === undefined) return false;
  try {
    return isUrlOriginAllowed(new URL(action.path, webV1LocationHref(graph)).href, policy);
  } catch {
    return false;
  }
}

type LiveGraphValidation =
  | { readonly ok: true; readonly graph: ObservationGraphV1 }
  | { readonly ok: false; readonly errorCode: string };

function validateLiveGraph(graph: ObservationGraphV1): LiveGraphValidation {
  try {
    const validated = validateConsumerObservationGraph(graph);
    requireWebV1Semantics(validated);
    return { ok: true, graph: validated };
  } catch (error) {
    if (error instanceof ObservationError) {
      return { ok: false, errorCode: error.code };
    }
    return { ok: false, errorCode: "ObservationSchemaInvalid" };
  }
}

function isUrlOriginAllowed(url: string, policy: ExplorationPolicy): boolean {
  try {
    return policy.allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function appendTerminalCheckpoint(
  state: RunState,
  graphFingerprint: string,
  terminalReason: ExplorationTerminalReason,
): void {
  state.checkpoints.push(checkpoint(
    state.checkpoints.length + 1,
    graphFingerprint,
    state.budget.snapshot(),
    terminalReason,
  ));
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
  seedReplays: readonly RegressionJobResult[],
  errorCode?: string,
): ExplorationResult {
  return {
    terminalReason: reason,
    checkpoints,
    stepsExecuted,
    seedReplays,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function inFlight(step: number, action: GroundedExplorationAction): ExplorationInFlightAction {
  const actionJson = JSON.stringify(action);
  return {
    step,
    actionDigest: canonicalPayloadHash({ step, action }),
    actionJson,
  };
}

function emptySeedCursor(): ExplorationSeedCursor {
  return { nextSeedIndex: 0, completedSeedSkillBundleIds: [] };
}

function attemptBindings(job: ExplorationJob): AttemptBindings {
  return {
    attemptId: job.attemptId,
    runId: job.runId,
    sourceBindingHash: job.sourceBindingHash,
    policyBindingHash: canonicalPayloadHash(job.policy),
    seedBindingHash: canonicalPayloadHash({
      policySeedSkillBundleIds: job.policy.seedSkillBundleIds,
      seeds: (job.seedSkills ?? []).map((seed) => ({
        skillBundleId: seed.plan.skillBundleId,
        bundleId: seed.bundle.manifest.bundleId,
        contentSha256: seed.bundle.manifest.contentSha256,
      })),
    }),
  };
}

function validateAttemptBinding(job: ExplorationJob): { readonly ok: true } | { readonly ok: false; readonly errorCode: string } {
  if (job.attemptId.trim().length === 0 || job.sourceBindingHash.trim().length === 0) {
    return { ok: false, errorCode: "ExplorationAttemptBindingRequired" };
  }
  return { ok: true };
}

function bindingsMatch(progress: ExplorationAttemptProgress, bindings: AttemptBindings): boolean {
  return progress.runId === bindings.runId &&
    progress.sourceBindingHash === bindings.sourceBindingHash &&
    progress.policyBindingHash === bindings.policyBindingHash &&
    progress.seedBindingHash === bindings.seedBindingHash;
}

function lastSafeFingerprint(state: RunState): string | undefined {
  return state.checkpoints.findLast((candidate) => candidate.terminalReason === undefined)?.graphFingerprint ??
    state.progress.lastSafeGraphFingerprint;
}

type SeedValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ExplorationTerminalReason; readonly errorCode: string };

function validateSeeds(job: ExplorationJob): SeedValidation {
  const seeds = job.seedSkills ?? [];
  if (job.policy.seedSkillBundleIds.length !== seeds.length) {
    return { ok: false, reason: "no_safe_action", errorCode: "MissingSeedSkill" };
  }
  const seedIds = seeds.map((seed) => seed.plan.skillBundleId);
  if (!sameOrder(job.policy.seedSkillBundleIds, seedIds)) {
    return { ok: false, reason: "no_safe_action", errorCode: "SeedBindingConflict" };
  }
  if (seeds.some((seed) => seed.plan.skillBundleId !== seed.bundle.manifest.bundleId)) {
    return { ok: false, reason: "no_safe_action", errorCode: "SeedBindingConflict" };
  }
  if (seeds.some((seed) => seed.bundle.payload.state !== "verified")) {
    return { ok: false, reason: "no_safe_action", errorCode: "SeedSkillNotVerified" };
  }
  return { ok: true };
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
