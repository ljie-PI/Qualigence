import type {
  AcceptedExecutionJob,
  ActionOutcomeTracePayload,
  AuthorizedPolicyTracePayload,
  DecisionTracePayload,
  DeniedPolicyTracePayload,
  ExecutionCompletion,
  ExecutionPlanStep,
  FindingEnvelope,
  ObservationGraphV1,
  ResolvedActionTracePayload,
  ResolvedDesktopAction,
  RunId,
  TraceEvent,
  VerificationTracePayload,
} from "@qualigence/runner-protocol";
import {
  requireGraphExtensionMajor,
  validateObservationGraphV1,
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

export class TerminalTracePersistenceError extends Error {
  readonly code = "TerminalTracePersistenceFailed";
  readonly disposition = "terminal_persistence_failed";

  constructor(cause: unknown) {
    super("The terminal Trace event could not be persisted.", { cause });
    this.name = "TerminalTracePersistenceError";
  }
}

export type ExecutionTargetErrorStatus = "blocked" | "error";

/** Adapter-neutral expected target failure that Runtime can terminalize safely. */
export class ExecutionTargetError extends Error {
  constructor(
    readonly errorCode: string,
    readonly completionStatus: ExecutionTargetErrorStatus,
    message?: string,
  ) {
    super(message ?? errorCode);
    this.name = "ExecutionTargetError";
  }
}

export interface Observer {
  capture(job: AcceptedExecutionJob, signal?: AbortSignal): Promise<ObservationGraphV1>;
}

export interface ExecutionDecisionProvider<TKind extends ProposedActionKind = "click"> {
  decide(context: AgentContext): Promise<ProposedAction<TKind>>;
}

export interface AgentContext {
  readonly job: AcceptedExecutionJob;
  readonly observation: ObservationGraphV1;
  readonly step?: ExecutionPlanStep;
  readonly stepIndex?: number;
  readonly budget?: ExecutionBudget;
  readonly signal?: AbortSignal;
}

export interface ActionResolver<TKind extends ProposedActionKind = "click"> {
  resolve(
    action: ProposedAction<TKind>,
    graph: ObservationGraphV1,
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

/** Synchronous authority checked by an executor at the side-effect boundary. */
export interface ActionAuthorizationWindow {
  assertActionAuthorized(): void;
}

export interface ActionDispatchSnapshot {
  readonly crossOriginNavigationCount: number;
}

export interface Verifier {
  verify(context: VerificationContext): Promise<VerificationResult>;
}

export interface VerificationContext {
  readonly job: AcceptedExecutionJob;
  readonly before: ObservationGraphV1;
  readonly after: ObservationGraphV1;
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
  readonly actionAuthorizationWindow?: ActionAuthorizationWindow;
  readonly verifier: Verifier;
  readonly traceRecorder: TraceRecorder;
  readonly budget?: ExecutionBudget;
  readonly objectiveOnlyMaximumWallClockMs?: number;
  readonly objectiveOnlyMaximumModelTokens?: number;
  readonly terminalRecordingTimeoutMs?: number;
}

const executionPermitBrand: unique symbol = Symbol("ExecutionPermit");
const DEFAULT_TERMINAL_RECORDING_TIMEOUT_MS = 5_000;

export class ExecutionPermit {
  readonly [executionPermitBrand] = true;
  private dispatched = false;
  private snapshot: ActionDispatchSnapshot | undefined;

  private constructor(
    readonly reason: string,
    readonly descriptor?: ExecutionPermitDescriptor,
    private readonly authorizationWindow?: ActionAuthorizationWindow,
  ) {}

  static fromAllowedDecision(
    decision: PolicyDecision,
    authorizationWindow?: ActionAuthorizationWindow,
  ): ExecutionPermit {
    if (decision.status !== "allowed") {
      throw new Error("ExecutionPermit requires an allowed policy decision.");
    }

    return new ExecutionPermit(decision.reason, decision.descriptor, authorizationWindow);
  }

  /**
   * Recheck authority synchronously, then mark the exact point after which an
   * executor must invoke its side effect without awaiting anything else.
   */
  assertAuthorizedForDispatch(
    signal?: AbortSignal,
    snapshot?: () => ActionDispatchSnapshot,
  ): void {
    signal?.throwIfAborted();
    this.authorizationWindow?.assertActionAuthorized();
    signal?.throwIfAborted();
    this.snapshot = snapshot === undefined ? undefined : Object.freeze({ ...snapshot() });
    this.dispatched = true;
  }

  get dispatchStarted(): boolean {
    return this.dispatched;
  }

  get dispatchSnapshot(): ActionDispatchSnapshot | undefined {
    return this.snapshot;
  }
}

export class ExecutionRuntime<TKind extends ProposedActionKind = "click"> {
  private readonly budget: ExecutionBudget;
  private readonly terminalRecordingTimeoutMs: number;

  constructor(private readonly dependencies: ExecutionRuntimeDependencies<TKind>) {
    this.terminalRecordingTimeoutMs = dependencies.terminalRecordingTimeoutMs ?? DEFAULT_TERMINAL_RECORDING_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.terminalRecordingTimeoutMs) || this.terminalRecordingTimeoutMs <= 0) {
      throw new Error("terminalRecordingTimeoutMs must be a positive safe integer.");
    }
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

  async run(job: AcceptedExecutionJob, signal?: AbortSignal): Promise<ExecutionCompletion> {
    let budgetStarted = false;
    let currentStepIndex: number | undefined;
    try {
      this.budget.begin(job);
      budgetStarted = true;
      let completion: ExecutionCompletion;
      try {
        completion = await this.runUntilCompletion(job, (stepIndex) => {
          currentStepIndex = stepIndex;
        }, signal);
      } catch (error) {
        const mapped = completionFromError(job, error);
        if (mapped === undefined) throw error;
        completion = mapped;
      }

      try {
        await this.recordTerminal(completion, job.plan === undefined ? undefined : currentStepIndex);
        return completion;
      } catch (cause) {
        if (cause instanceof TerminalTracePersistenceError) throw cause;
        throw new TerminalTracePersistenceError(cause);
      }
    } finally {
      if (budgetStarted) {
        this.budget.finish(job.runId);
      }
    }
  }

  private async runUntilCompletion(
    job: AcceptedExecutionJob,
    setCurrentStep: (stepIndex: number) => void,
    signal?: AbortSignal,
  ): Promise<ExecutionCompletion> {
    if (job.plan === undefined) {
      return this.runObjectiveOnly(job, setCurrentStep, signal);
    }

    let firstObservation: ObservationGraphV1 | undefined;
    let lastAction: ResolvedAction | undefined;
    let lastOutcome: ActionOutcome | undefined;
    let lastStepIndex = 0;
    let hasExplicitVerification = false;

    for (const [ordinal, step] of job.plan.steps.entries()) {
      const stepIndex = step.stepIndex ?? ordinal;
      lastStepIndex = stepIndex;
      setCurrentStep(stepIndex);
      this.budget.beforeStep(job.runId, stepIndex);
      const observation = await this.capture(job, stepIndex, signal);
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
        }, signal);
        if (completion !== undefined) return completion;
        continue;
      }

      const result = await this.executeStep(job, step, stepIndex, observation, signal);
      if ("completion" in result) return result.completion;
      lastAction = result.action;
      lastOutcome = result.outcome;
    }

    if (!hasExplicitVerification) {
      const after = await this.capture(job, lastStepIndex, signal);
      const completion = await this.verify({
        job,
        before: firstObservation ?? after,
        after,
        claimIds: job.plan.expectedClaimIds,
        stepIndex: lastStepIndex,
        ...(lastAction === undefined ? {} : { action: lastAction }),
        ...(lastOutcome === undefined ? {} : { outcome: lastOutcome }),
      }, signal);
      if (completion !== undefined) return completion;
    }

    return this.passedCompletion(job);
  }

  private async runObjectiveOnly(
    job: AcceptedExecutionJob,
    setCurrentStep: (stepIndex: number) => void,
    signal?: AbortSignal,
  ): Promise<ExecutionCompletion> {
    const stepIndex = 0;
    setCurrentStep(stepIndex);
    this.budget.beforeStep(job.runId, stepIndex);
    const before = await this.capture(job, undefined, signal);
    const result = await this.executeStep(job, undefined, stepIndex, before, signal);
    if ("completion" in result) return result.completion;
    const after = await this.capture(job, undefined, signal);
    const completion = await this.verify({
      job,
      before,
      after,
      claimIds: [],
      stepIndex,
      action: result.action,
      outcome: result.outcome,
    }, signal);
    return completion ?? this.passedCompletion(job);
  }

  private async executeStep(
    job: AcceptedExecutionJob,
    step: Exclude<ExecutionPlanStep, { readonly kind: "verify" }> | undefined,
    stepIndex: number,
    observation: ObservationGraphV1,
    signal?: AbortSignal,
  ): Promise<
    | { readonly action: ResolvedAction; readonly outcome: ActionOutcome }
    | { readonly completion: ExecutionCompletion }
  > {
    const traceIndex = job.plan === undefined ? undefined : stepIndex;
    const decision = await this.withinWallClock(job.runId, (operationSignal) =>
      this.dependencies.decisionProvider.decide({
        job,
        observation,
        ...(step === undefined ? {} : { step }),
        stepIndex,
        budget: this.budget,
        signal: operationSignal,
      }), signal);
    if (step !== undefined) assertDecisionMatchesStep(decision, step);
    await this.recordStage(job.runId, traceIndex, "decision", toDecisionTracePayload(decision));

    const action = await this.withinWallClock(job.runId, (operationSignal) =>
      this.dependencies.resolver.resolve(decision, observation, operationSignal), signal);
    await this.recordStage(job.runId, traceIndex, "action_resolved", toResolvedActionTracePayload(action));

    const policyDecision = await this.withinWallClock(job.runId, (operationSignal) =>
      this.dependencies.policyGate.authorize(action, { job, action, signal: operationSignal }), signal);
    if (policyDecision.status === "denied") {
      await this.recordStage(job.runId, traceIndex, "policy_denied", toDeniedPolicyTracePayload(policyDecision));
      return { completion: this.blockedCompletion(job, "PolicyDenied") };
    }

    await this.recordStage(job.runId, traceIndex, "policy_authorized", toAuthorizedPolicyTracePayload(policyDecision));
    this.budget.maximumOutputTokens(job.runId);
    const permit = ExecutionPermit.fromAllowedDecision(
      policyDecision,
      this.dependencies.actionAuthorizationWindow,
    );
    let outcome: ActionOutcome;
    try {
      outcome = await this.withinWallClock(job.runId, (operationSignal) =>
        this.dependencies.actionExecutor.execute(action, permit, operationSignal), signal);
    } catch (error) {
      if (permit.dispatchStarted) throw new ActionOutcomeUnknownError();
      throw error;
    }
    await this.recordStage(job.runId, traceIndex, "action_executed", toActionOutcomeTracePayload(outcome));
    if (outcome.status === "failed") {
      if (permit.dispatchStarted || outcome.errorCode === "ActionOutcomeUnknown") {
        return { completion: this.errorCompletion(job, "ActionOutcomeUnknown") };
      }
      return {
        completion: this.blockedCompletion(job, outcome.errorCode ?? "ActionFailed"),
      };
    }
    return { action, outcome };
  }

  private async capture(
    job: AcceptedExecutionJob,
    stepIndex?: number,
    signal?: AbortSignal,
  ): Promise<ObservationGraphV1> {
    const captured = await this.withinWallClock(job.runId, (operationSignal) =>
      this.dependencies.observer.capture(job, operationSignal), signal);
    const observation = validateLiveObservationGraph(captured);
    await this.recordStage(job.runId, stepIndex, "observation", observation);
    return observation;
  }

  private async verify(
    context: Omit<VerificationContext, "budget" | "signal">,
    signal?: AbortSignal,
  ): Promise<ExecutionCompletion | undefined> {
    const verification = await this.withinWallClock(context.job.runId, (operationSignal) =>
      this.dependencies.verifier.verify({ ...context, budget: this.budget, signal: operationSignal }), signal);
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
    return {
      jobId: context.job.jobId,
      runId: context.job.runId,
      status: "finding",
      finding,
    };
  }

  private passedCompletion(job: AcceptedExecutionJob): ExecutionCompletion {
    return { jobId: job.jobId, runId: job.runId, status: "passed" };
  }

  private blockedCompletion(
    job: AcceptedExecutionJob,
    errorCode: string,
  ): ExecutionCompletion {
    return { jobId: job.jobId, runId: job.runId, status: "blocked", errorCode };
  }

  private errorCompletion(
    job: AcceptedExecutionJob,
    errorCode: string,
  ): ExecutionCompletion {
    return { jobId: job.jobId, runId: job.runId, status: "error", errorCode };
  }

  private async recordTerminal(
    completion: ExecutionCompletion,
    stepIndex?: number,
  ): Promise<void> {
    const input = terminalTraceInput(completion, stepIndex);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("TerminalTracePersistenceFailed")),
        this.terminalRecordingTimeoutMs,
      );
    });
    try {
      await Promise.race([this.dependencies.traceRecorder.append(input), deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
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
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const remainingMs = this.budget.remainingWallClockMs(runId);
    const controller = new AbortController();
    const operationSignal = externalSignal === undefined
      ? controller.signal
      : AbortSignal.any([externalSignal, controller.signal]);
    operationSignal.throwIfAborted();
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
      let rejectAborted: ((reason: unknown) => void) | undefined;
      const abortOperation = (): void => rejectAborted?.(operationSignal.reason);
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = reject;
        operationSignal.addEventListener("abort", abortOperation, { once: true });
      });
      try {
        return await Promise.race([operation(operationSignal), deadline, aborted]);
      } finally {
        operationSignal.removeEventListener("abort", abortOperation);
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

function completionFromError(
  job: AcceptedExecutionJob,
  error: unknown,
): ExecutionCompletion | undefined {
  if (error instanceof ExecutionTargetError) {
    return {
      jobId: job.jobId,
      runId: job.runId,
      status: error.completionStatus,
      errorCode: error.errorCode,
    };
  }
  const errorCode = error instanceof ExecutionBlockedError
    ? error.errorCode
    : error instanceof ExecutionBudgetError
      ? error.code
      : error instanceof ActionOutcomeUnknownError
        ? error.errorCode
        : undefined;
  if (errorCode === undefined) return undefined;
  const status = errorCode === "ModelUsageUnavailable" || errorCode === "ActionOutcomeUnknown"
    ? "error"
    : "blocked";
  return { jobId: job.jobId, runId: job.runId, status, errorCode };
}

function terminalTraceInput(
  completion: ExecutionCompletion,
  stepIndex?: number,
): TraceEventInput {
  const base = {
    runId: completion.runId,
    ...(stepIndex === undefined ? {} : { stepIndex }),
    stage: "run_completed" as const,
  };
  switch (completion.status) {
    case "passed":
      return { ...base, payload: { status: "passed" } };
    case "finding":
      return { ...base, payload: { status: "finding", findingId: completion.finding.findingId } };
    case "blocked":
      return {
        ...base,
        payload: {
          status: "blocked",
          ...(completion.errorCode === undefined ? {} : { errorCode: completion.errorCode }),
        },
      };
    case "error":
      return { ...base, payload: { status: "error", errorCode: completion.errorCode } };
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

function validateLiveObservationGraph(candidate: ObservationGraphV1): ObservationGraphV1 {
  const webQueryKeys = candidate.extensions?.["web/v1"]?.payload.query;
  const allowedWebQueryKeys = webQueryKeys !== undefined &&
    webQueryKeys !== null &&
    typeof webQueryKeys === "object" &&
    !Array.isArray(webQueryKeys)
    ? Object.keys(webQueryKeys)
    : [];
  validateObservationGraphV1(candidate, { allowedWebQueryKeys });
  if (candidate.target.kind === "web") {
    requireGraphExtensionMajor(candidate, "web", 1);
  }
  return candidate;
}

function findingFromVerification(
  runId: RunId,
  verification: Extract<VerificationResult, { status: "failed" }>,
  before: ObservationGraphV1,
  after: ObservationGraphV1,
): FindingEnvelope {
  const claimRefs = verification.claims.flatMap((claim) => [
    `${claim.expected.graphId}:${claim.expected.nodeId}`,
    `${claim.observed.graphId}:${claim.observed.nodeId}`,
  ]);
  const artifactRefs = [
    ...before.evidenceRefs,
    ...after.evidenceRefs,
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
