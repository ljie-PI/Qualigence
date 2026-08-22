import type {
  AcceptedExecutionJob,
  ActionOutcomeTracePayload,
  AuthorizedPolicyTracePayload,
  DecisionTracePayload,
  DeniedPolicyTracePayload,
  ExecutionCompletion,
  ExecutionPlanStep,
  FindingEnvelope,
  ObservationGraph,
  ResolvedActionTracePayload,
  ResolvedDesktopAction,
  RunId,
  TraceEvent,
  VerificationTracePayload,
} from "@qualigence/runner-protocol";
import {
  DeterministicExecutionBudget,
  ExecutionBudgetError,
  type ExecutionBudget,
} from "./execution-budget.js";

export type { ResolvedDesktopAction } from "@qualigence/runner-protocol";

type ProposedActionUnion =
  | { readonly kind: "navigate"; readonly path: string; readonly reason: string }
  | { readonly kind: "click"; readonly target: { readonly nodeId: string }; readonly reason: string }
  | { readonly kind: "input"; readonly target: { readonly nodeId: string }; readonly valueRef: string; readonly reason: string }
  | { readonly kind: "select"; readonly target: { readonly nodeId: string }; readonly valueRef: string; readonly reason: string }
  | { readonly kind: "scroll"; readonly target?: { readonly nodeId: string }; readonly direction: "up" | "down" | "left" | "right"; readonly amount: "small" | "page"; readonly reason: string }
  | { readonly kind: "window"; readonly target: { readonly nodeId: string }; readonly operation: "focus" | "minimize" | "restore" | "close"; readonly reason: string };

export type ProposedActionKind = ProposedActionUnion["kind"];
export type ProposedAction<TKind extends ProposedActionKind = "click"> = Extract<ProposedActionUnion, { readonly kind: TKind }>;
export type AnyProposedAction = ProposedAction<ProposedActionKind>;

/**
 * A resolved Web action. `targetKind` is the discriminator introduced by LS-13
 * so the same Runner Kernel can drive Web and Desktop targets. It is optional
 * here purely for backward compatibility: every M1 Web resolver historically
 * emitted this shape without a `targetKind`, and those resolvers/tests must keep
 * compiling unchanged. The Playwright adapter now emits `targetKind: "web"`
 * explicitly, and an absent `targetKind` is treated as Web.
 */
interface ResolvedWebElementAction {
  readonly targetKind: "web";
  readonly target: {
    readonly nodeId: string;
    readonly selector: string;
  };
  readonly graphId: string;
}

type ResolvedWebActionUnion =
  | { readonly targetKind: "web"; readonly kind: "navigate"; readonly url: string }
  | (ResolvedWebElementAction & { readonly kind: "click" })
  | (ResolvedWebElementAction & { readonly kind: "input"; readonly valueRef: string })
  | (ResolvedWebElementAction & { readonly kind: "select"; readonly valueRef: string })
  | ({ readonly targetKind: "web"; readonly kind: "scroll"; readonly graphId: string; readonly target?: { readonly nodeId: string; readonly selector: string }; readonly direction: "up" | "down" | "left" | "right"; readonly amount: "small" | "page" });

export type ResolvedWebActionKind = ResolvedWebActionUnion["kind"];
export type ResolvedWebAction<TKind extends ResolvedWebActionKind = "click"> = Extract<ResolvedWebActionUnion, { readonly kind: TKind }>;
export type AnyResolvedWebAction = ResolvedWebAction<ResolvedWebActionKind>;

interface LegacyResolvedWebClick {
  readonly targetKind?: never;
  readonly kind: "click";
  readonly target: { readonly nodeId: string; readonly selector: string };
  readonly graphId: string;
}

/**
 * The cross-platform resolved-action union. A consumer MUST branch on
 * `targetKind` before `kind` so a Web click can never be handed to a UIA
 * executor (and vice versa). `ResolvedDesktopAction` is the frozen Desktop union
 * owned by `@qualigence/desktop-contracts` and re-exported through Runner
 * Protocol.
 */
export type ResolvedAction = AnyResolvedWebAction | LegacyResolvedWebClick | ResolvedDesktopAction;
export type AnyResolvedAction = AnyResolvedWebAction | LegacyResolvedWebClick | ResolvedDesktopAction;

/** True when a resolved action targets a Windows Desktop app via UIA. */
export function isDesktopAction(
  action: AnyResolvedAction,
): action is ResolvedDesktopAction {
  return action.targetKind === "desktop";
}

/** True when a resolved action targets a Web page (explicit or legacy). */
export function isWebAction(action: AnyResolvedAction): action is AnyResolvedWebAction | LegacyResolvedWebClick {
  return action.targetKind !== "desktop";
}

/** The observation node id a resolved action targets, regardless of platform. */
export function resolvedActionNodeId(action: AnyResolvedAction): string | undefined {
  if (isDesktopAction(action)) return action.nodeId;
  return action.kind === "navigate" ? undefined : action.target?.nodeId;
}

/**
 * The action risk classification the Runner policy gate applies before it may
 * mint an {@link ExecutionPermitDescriptor}. This mirrors LS-09's
 * `ActionRiskLevel` intent for Desktop actions: read-only-ish interactions are
 * `Normal` (auto-issuable inside an active session), state-changing input is an
 * `ExternalSideEffect`, and a destructive window close is `Destructive`. A
 * `ProductionForbidden` classification is never derived from the action kind
 * alone — it is imposed by explicit policy — so it is never returned here.
 */
export type ExecutionRisk =
  | "Normal"
  | "ExternalSideEffect"
  | "Destructive"
  | "ProductionForbidden";

/** Conservative default risk classification for a resolved Desktop action. */
export function classifyDesktopActionRisk(
  action: ResolvedDesktopAction,
): Exclude<ExecutionRisk, "ProductionForbidden"> {
  switch (action.kind) {
    case "click":
    case "scroll":
      return "Normal";
    case "input":
    case "select":
      return "ExternalSideEffect";
    case "window":
      return action.windowOperation === "close" ? "Destructive" : "Normal";
  }
}

/**
 * The policy-bound descriptor a branded {@link ExecutionPermit} carries. Only an
 * allowed policy decision may construct it; it freezes the RFC 8785 action
 * digest, the risk class, the policy/decision identity and the permit TTL so the
 * Desktop Companion can re-verify the exact same binding before it consumes its
 * one-time local Permit. This is structurally equal to the desktop-contracts
 * `LocalPermitAuthorization` IPC DTO, which the Windows adapter maps it to.
 */
export interface ExecutionPermitDescriptor {
  readonly decisionId: string;
  readonly policyId: string;
  readonly actionDigestSha256: string;
  readonly risk: ExecutionRisk;
  readonly expiresAt: string;
}

export type PolicyDecision =
  | {
      readonly status: "allowed";
      readonly reason: string;
      /**
       * Present for Desktop actions (LS-13): the policy gate computed this
       * descriptor from the resolved action so the branded permit can bind it.
       * Absent for the M1 Web path, which does not broker through the Companion.
       */
      readonly descriptor?: ExecutionPermitDescriptor;
    }
  | {
      readonly status: "denied";
      readonly reason: string;
    };

export interface ActionOutcome {
  readonly status: "ok" | "failed";
  readonly errorCode?: string;
}

export type VerificationResult = VerificationTracePayload;

export class ExecutionBlockedError extends Error {
  constructor(readonly errorCode: string) {
    super(`Execution blocked: ${errorCode}`);
    this.name = "ExecutionBlockedError";
  }
}

export class ActionOutcomeUnknownError extends Error {
  readonly errorCode = "ActionOutcomeUnknown";

  constructor() {
    super("The action outcome could not be determined.");
    this.name = "ActionOutcomeUnknownError";
  }
}

export interface Observer {
  capture(job: AcceptedExecutionJob, signal?: AbortSignal): Promise<ObservationGraph>;
}

export interface ExecutionDecisionProvider<TKind extends ProposedActionKind = "click"> {
  decide(context: AgentContext): Promise<ProposedAction<TKind>>;
}

export interface AgentContext {
  readonly job: AcceptedExecutionJob;
  readonly observation: ObservationGraph;
  readonly step?: ExecutionPlanStep;
  readonly stepIndex?: number;
  readonly budget?: ExecutionBudget;
  readonly signal?: AbortSignal;
}

export interface ActionResolver<TKind extends ProposedActionKind = "click"> {
  resolve(
    action: ProposedAction<TKind>,
    graph: ObservationGraph,
    signal?: AbortSignal,
  ): Promise<ResolvedAction>;
}

export interface RunnerPolicyContext {
  readonly job: AcceptedExecutionJob;
  readonly action: ResolvedAction;
  readonly signal?: AbortSignal;
}

export interface RunnerPolicyGate {
  authorize(
    action: ResolvedAction,
    context: RunnerPolicyContext,
  ): Promise<PolicyDecision>;
}

export interface ActionExecutor {
  execute(action: ResolvedAction, permit: ExecutionPermit, signal?: AbortSignal): Promise<ActionOutcome>;
}

export interface Verifier {
  verify(context: VerificationContext): Promise<VerificationResult>;
}

export interface VerificationContext {
  readonly job: AcceptedExecutionJob;
  readonly before: ObservationGraph;
  readonly after: ObservationGraph;
  readonly claimIds?: readonly string[];
  readonly stepIndex?: number;
  readonly action?: ResolvedAction;
  readonly outcome?: ActionOutcome;
  readonly budget?: ExecutionBudget;
  readonly signal?: AbortSignal;
}

export interface TraceRecorder {
  append(event: TraceEventInput): Promise<TraceEvent>;
}

export type TraceEventInput = TraceEvent extends infer TEvent
  ? TEvent extends TraceEvent
    ? Pick<TEvent, "runId" | "stage" | "payload"> & Pick<Partial<TEvent>, "stepIndex">
    : never
  : never;

export interface ExecutionRuntimeDependencies<TKind extends ProposedActionKind = "click"> {
  readonly observer: Observer;
  readonly decisionProvider: ExecutionDecisionProvider<TKind>;
  readonly resolver: ActionResolver<TKind>;
  readonly policyGate: RunnerPolicyGate;
  readonly actionExecutor: ActionExecutor;
  readonly verifier: Verifier;
  readonly traceRecorder: TraceRecorder;
  readonly budget?: ExecutionBudget;
  readonly objectiveOnlyMaximumWallClockMs?: number;
  readonly objectiveOnlyMaximumModelTokens?: number;
}

const executionPermitBrand: unique symbol = Symbol("ExecutionPermit");

export class ExecutionPermit {
  readonly [executionPermitBrand] = true;

  private constructor(
    readonly reason: string,
    readonly descriptor?: ExecutionPermitDescriptor,
  ) {}

  static fromAllowedDecision(decision: PolicyDecision): ExecutionPermit {
    if (decision.status !== "allowed") {
      throw new Error("ExecutionPermit requires an allowed policy decision.");
    }

    return new ExecutionPermit(decision.reason, decision.descriptor);
  }
}

export class ExecutionRuntime<TKind extends ProposedActionKind = "click"> {
  private readonly budget: ExecutionBudget;

  constructor(private readonly dependencies: ExecutionRuntimeDependencies<TKind>) {
    if (dependencies.budget !== undefined) {
      this.budget = dependencies.budget;
      return;
    }
    this.budget = new DeterministicExecutionBudget({
      ...(dependencies.objectiveOnlyMaximumWallClockMs === undefined
        ? {}
        : { objectiveOnlyMaximumWallClockMs: dependencies.objectiveOnlyMaximumWallClockMs }),
      ...(dependencies.objectiveOnlyMaximumModelTokens === undefined
        ? {}
        : { objectiveOnlyMaximumModelTokens: dependencies.objectiveOnlyMaximumModelTokens }),
    });
  }

  async run(job: AcceptedExecutionJob): Promise<ExecutionCompletion> {
    let budgetStarted = false;
    let currentStepIndex: number | undefined;
    try {
      this.budget.begin(job);
      budgetStarted = true;
      return await this.runUntilCompletion(job, (stepIndex) => {
        currentStepIndex = stepIndex;
      });
    } catch (error) {
      const errorCode =
        error instanceof ExecutionBlockedError
          ? error.errorCode
          : error instanceof ExecutionBudgetError
            ? error.code
            : error instanceof ActionOutcomeUnknownError
              ? error.errorCode
              : undefined;
      if (errorCode === undefined) {
        throw error;
      }

      const status = errorCode === "ModelUsageUnavailable" || errorCode === "ActionOutcomeUnknown"
        ? "error"
        : "blocked";
      try {
        if (!budgetStarted) {
          throw error;
        }
        await this.record({
          runId: job.runId,
          ...(job.plan === undefined || currentStepIndex === undefined
            ? {}
            : { stepIndex: currentStepIndex }),
          stage: "run_completed",
          payload: {
            status,
            errorCode,
          },
        });
      } catch (recordError) {
        if (
          !(recordError instanceof ExecutionBudgetError) ||
          recordError.code !== "WallClockBudgetExceeded"
        ) {
          throw recordError;
        }
      }

      return {
        jobId: job.jobId,
        runId: job.runId,
        status,
        errorCode,
      };
    } finally {
      if (budgetStarted) {
        this.budget.finish(job.runId);
      }
    }
  }

  private async runUntilCompletion(
    job: AcceptedExecutionJob,
    setCurrentStep: (stepIndex: number) => void,
  ): Promise<ExecutionCompletion> {
    if (job.plan === undefined) {
      return this.runObjectiveOnly(job, setCurrentStep);
    }

    let firstObservation: ObservationGraph | undefined;
    let lastAction: ResolvedAction | undefined;
    let lastOutcome: ActionOutcome | undefined;
    let lastStepIndex = 0;
    let hasExplicitVerification = false;

    for (const [ordinal, step] of job.plan.steps.entries()) {
      const stepIndex = step.stepIndex ?? ordinal;
      lastStepIndex = stepIndex;
      setCurrentStep(stepIndex);
      this.budget.beforeStep(job.runId, stepIndex);
      const observation = await this.capture(job, stepIndex);
      firstObservation ??= observation;

      if (step.kind === "verify") {
        hasExplicitVerification = true;
        const completion = await this.verify({
          job,
          before: firstObservation,
          after: observation,
          claimIds: step.claimIds,
          stepIndex,
          ...(lastAction === undefined ? {} : { action: lastAction }),
          ...(lastOutcome === undefined ? {} : { outcome: lastOutcome }),
        });
        if (completion !== undefined) return completion;
        continue;
      }

      const result = await this.executeStep(job, step, stepIndex, observation);
      if ("completion" in result) return result.completion;
      lastAction = result.action;
      lastOutcome = result.outcome;
    }

    if (!hasExplicitVerification) {
      const after = await this.capture(job, lastStepIndex);
      const completion = await this.verify({
        job,
        before: firstObservation ?? after,
        after,
        claimIds: job.plan.expectedClaimIds,
        stepIndex: lastStepIndex,
        ...(lastAction === undefined ? {} : { action: lastAction }),
        ...(lastOutcome === undefined ? {} : { outcome: lastOutcome }),
      });
      if (completion !== undefined) return completion;
    }

    return this.completePassed(job, lastStepIndex);
  }

  private async runObjectiveOnly(
    job: AcceptedExecutionJob,
    setCurrentStep: (stepIndex: number) => void,
  ): Promise<ExecutionCompletion> {
    const stepIndex = 0;
    setCurrentStep(stepIndex);
    this.budget.beforeStep(job.runId, stepIndex);
    const before = await this.capture(job);
    const result = await this.executeStep(job, undefined, stepIndex, before);
    if ("completion" in result) return result.completion;
    const after = await this.capture(job);
    const completion = await this.verify({
      job,
      before,
      after,
      claimIds: [],
      stepIndex,
      action: result.action,
      outcome: result.outcome,
    });
    return completion ?? this.completePassed(job);
  }

  private async executeStep(
    job: AcceptedExecutionJob,
    step: Exclude<ExecutionPlanStep, { readonly kind: "verify" }> | undefined,
    stepIndex: number,
    observation: ObservationGraph,
  ): Promise<
    | { readonly action: ResolvedAction; readonly outcome: ActionOutcome }
    | { readonly completion: ExecutionCompletion }
  > {
    const traceIndex = job.plan === undefined ? undefined : stepIndex;
    const decision = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.decisionProvider.decide({
        job,
        observation,
        ...(step === undefined ? {} : { step }),
        stepIndex,
        budget: this.budget,
        signal,
      }));
    if (step !== undefined) assertDecisionMatchesStep(decision, step);
    await this.recordStage(job.runId, traceIndex, "decision", toDecisionTracePayload(decision));

    const action = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.resolver.resolve(decision, observation, signal));
    await this.recordStage(job.runId, traceIndex, "action_resolved", toResolvedActionTracePayload(action));

    const policyDecision = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.policyGate.authorize(action, { job, action, signal }));
    if (policyDecision.status === "denied") {
      await this.recordStage(job.runId, traceIndex, "policy_denied", toDeniedPolicyTracePayload(policyDecision));
      return { completion: await this.completeBlocked(job, "PolicyDenied", traceIndex) };
    }

    await this.recordStage(job.runId, traceIndex, "policy_authorized", toAuthorizedPolicyTracePayload(policyDecision));
    this.budget.maximumOutputTokens(job.runId);
    const permit = ExecutionPermit.fromAllowedDecision(policyDecision);
    let outcome: ActionOutcome;
    try {
      outcome = await this.withinWallClock(job.runId, (signal) =>
        this.dependencies.actionExecutor.execute(action, permit, signal));
    } catch (error) {
      if (error instanceof ExecutionBlockedError || error instanceof ExecutionBudgetError) throw error;
      throw new ActionOutcomeUnknownError();
    }
    await this.recordStage(job.runId, traceIndex, "action_executed", toActionOutcomeTracePayload(outcome));
    if (outcome.status === "failed") {
      return {
        completion: await this.completeBlocked(job, outcome.errorCode ?? "ActionFailed", traceIndex),
      };
    }
    return { action, outcome };
  }

  private async capture(job: AcceptedExecutionJob, stepIndex?: number): Promise<ObservationGraph> {
    const observation = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.observer.capture(job, signal));
    await this.recordStage(job.runId, stepIndex, "observation", observation);
    return observation;
  }

  private async verify(context: Omit<VerificationContext, "budget" | "signal">): Promise<ExecutionCompletion | undefined> {
    const verification = await this.withinWallClock(context.job.runId, (signal) =>
      this.dependencies.verifier.verify({ ...context, budget: this.budget, signal }));
    await this.recordStage(
      context.job.runId,
      context.job.plan === undefined ? undefined : context.stepIndex,
      "verification",
      toVerificationTracePayload(verification),
    );
    if (verification.status === "passed") return undefined;

    const finding = findingFromVerification(
      context.job.runId,
      verification,
      context.before,
      context.after,
    );
    const traceIndex = context.job.plan === undefined ? undefined : context.stepIndex;
    await this.recordStage(context.job.runId, traceIndex, "finding", finding);
    await this.recordStage(context.job.runId, traceIndex, "run_completed", {
      status: "finding",
      findingId: finding.findingId,
    });
    return {
      jobId: context.job.jobId,
      runId: context.job.runId,
      status: "finding",
      finding,
    };
  }

  private async completePassed(job: AcceptedExecutionJob, stepIndex?: number): Promise<ExecutionCompletion> {
    await this.recordStage(job.runId, stepIndex, "run_completed", { status: "passed" });
    return { jobId: job.jobId, runId: job.runId, status: "passed" };
  }

  private async completeBlocked(
    job: AcceptedExecutionJob,
    errorCode: string,
    stepIndex?: number,
  ): Promise<ExecutionCompletion> {
    await this.recordStage(job.runId, stepIndex, "run_completed", { status: "blocked", errorCode });
    return { jobId: job.jobId, runId: job.runId, status: "blocked", errorCode };
  }

  private async recordStage<TStage extends TraceEventInput["stage"]>(
    runId: string,
    stepIndex: number | undefined,
    stage: TStage,
    payload: Extract<TraceEventInput, { readonly stage: TStage }>["payload"],
  ): Promise<void> {
    await this.record({
      runId,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      stage,
      payload,
    } as TraceEventInput);
  }

  private async record(input: TraceEventInput): Promise<void> {
    await this.withinWallClock(input.runId, () =>
      this.dependencies.traceRecorder.append(input));
  }

  private async withinWallClock<T>(
    runId: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const remainingMs = this.budget.remainingWallClockMs(runId);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      const checkDeadline = () => {
        try {
          const remaining = this.budget.remainingWallClockMs(runId);
          timeout = setTimeout(checkDeadline, Math.min(remaining, 2_147_483_647));
        } catch (error) {
          controller.abort(error);
          timeout = setTimeout(() => reject(error), 0);
        }
      };
      timeout = setTimeout(checkDeadline, Math.min(remainingMs, 2_147_483_647));
    });
    try {
      return await Promise.race([operation(controller.signal), deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

export function toDecisionTracePayload(action: AnyProposedAction): DecisionTracePayload {
  return action;
}

export function toResolvedActionTracePayload(
  action: AnyResolvedAction,
): ResolvedActionTracePayload {
  if (isDesktopAction(action)) {
    return action;
  }
  return action;
}

function toAuthorizedPolicyTracePayload(
  decision: Extract<PolicyDecision, { status: "allowed" }>,
): AuthorizedPolicyTracePayload {
  return decision;
}

function toDeniedPolicyTracePayload(
  decision: Extract<PolicyDecision, { status: "denied" }>,
): DeniedPolicyTracePayload {
  return decision;
}

function toActionOutcomeTracePayload(
  outcome: ActionOutcome,
): ActionOutcomeTracePayload {
  return outcome;
}

function toVerificationTracePayload(
  verification: VerificationResult,
): VerificationTracePayload {
  return verification;
}

function assertDecisionMatchesStep(
  decision: AnyProposedAction,
  step: Exclude<ExecutionPlanStep, { readonly kind: "verify" }>,
): void {
  if (decision.kind !== step.kind) throw new ExecutionBlockedError("PlanStepMismatch");
  if (step.kind === "navigate" && decision.kind === "navigate" && decision.path !== step.path) {
    throw new ExecutionBlockedError("PlanStepMismatch");
  }
  if (
    (step.kind === "input" || step.kind === "select") &&
    (decision.kind === "input" || decision.kind === "select") &&
    decision.valueRef !== step.valueRef
  ) {
    throw new ExecutionBlockedError("PlanStepMismatch");
  }
  if (
    step.kind === "scroll" &&
    decision.kind === "scroll" &&
    (decision.direction !== step.direction || decision.amount !== step.amount)
  ) {
    throw new ExecutionBlockedError("PlanStepMismatch");
  }
}

function findingFromVerification(
  runId: RunId,
  verification: Extract<VerificationResult, { status: "failed" }>,
  before: ObservationGraph,
  after: ObservationGraph,
): FindingEnvelope {
  const claimRefs = verification.claims.flatMap((claim) => [
    `${claim.expected.graphId}:${claim.expected.nodeId}`,
    `${claim.observed.graphId}:${claim.observed.nodeId}`,
  ]);
  const artifactRefs = [
    ...(before.artifactRefs ?? []),
    ...(after.artifactRefs ?? []),
  ];
  return {
    findingId: `${runId}:verification`,
    runId,
    title: "M1 verification failed",
    summary: verification.summary,
    severity: verification.severitySuggestion,
    evidenceRefs: [...new Set([...claimRefs, ...artifactRefs])],
  };
}
