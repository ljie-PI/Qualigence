import type {
  AcceptedExecutionJob,
  ActionOutcomeTracePayload,
  AuthorizedPolicyTracePayload,
  DecisionTracePayload,
  DeniedPolicyTracePayload,
  ExecutionCompletion,
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
export type ResolvedAction = ResolvedWebAction | LegacyResolvedWebClick | ResolvedDesktopAction;
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

export interface Observer {
  capture(job: AcceptedExecutionJob, signal?: AbortSignal): Promise<ObservationGraph>;
}

export interface ExecutionDecisionProvider {
  decide(context: AgentContext): Promise<ProposedAction>;
}

export interface AgentContext {
  readonly job: AcceptedExecutionJob;
  readonly observation: ObservationGraph;
  readonly budget?: ExecutionBudget;
  readonly signal?: AbortSignal;
}

export interface ActionResolver {
  resolve(
    action: ProposedAction,
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
  readonly action: ResolvedAction;
  readonly outcome: ActionOutcome;
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

export interface ExecutionRuntimeDependencies {
  readonly observer: Observer;
  readonly decisionProvider: ExecutionDecisionProvider;
  readonly resolver: ActionResolver;
  readonly policyGate: RunnerPolicyGate;
  readonly actionExecutor: ActionExecutor;
  readonly verifier: Verifier;
  readonly traceRecorder: TraceRecorder;
  readonly budget?: ExecutionBudget;
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

export class ExecutionRuntime {
  private readonly budget: ExecutionBudget;

  constructor(private readonly dependencies: ExecutionRuntimeDependencies) {
    this.budget = dependencies.budget ?? new DeterministicExecutionBudget();
  }

  async run(job: AcceptedExecutionJob): Promise<ExecutionCompletion> {
    let budgetStarted = false;
    try {
      this.budget.begin(job);
      budgetStarted = true;
      return await this.runUntilCompletion(job);
    } catch (error) {
      const errorCode = error instanceof ExecutionBlockedError
        ? error.errorCode
        : error instanceof ExecutionBudgetError
          ? error.code
          : undefined;
      if (errorCode === undefined) {
        throw error;
      }

      const status = errorCode === "ModelUsageUnavailable" ? "error" : "blocked";
      await this.record({
        runId: job.runId,
        stage: "run_completed",
        payload: {
          status,
          errorCode,
        },
      });

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

  private async runUntilCompletion(job: AcceptedExecutionJob): Promise<ExecutionCompletion> {
    // Ticket 19 replaces this compatibility pipeline with the bounded indexed
    // loop. Until then, only the current first action can own recorded stages.
    const stepIndex = job.plan?.steps[0]?.stepIndex;
    this.budget.beforeStep(job.runId, stepIndex ?? 0);
    const observation = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.observer.capture(job, signal));
    await this.record({
      runId: job.runId,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      stage: "observation",
      payload: observation,
    });

    const decision = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.decisionProvider.decide({
        job,
        observation,
        budget: this.budget,
        signal,
      }));
    await this.record({
      runId: job.runId,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      stage: "decision",
      payload: toDecisionTracePayload(decision),
    });

    const action = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.resolver.resolve(decision, observation, signal));
    await this.record({
      runId: job.runId,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      stage: "action_resolved",
      payload: toResolvedActionTracePayload(action),
    });

    const policyDecision = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.policyGate.authorize(action, {
        job,
        action,
        signal,
      }));

    if (policyDecision.status === "denied") {
      await this.record({
        runId: job.runId,
        ...(stepIndex === undefined ? {} : { stepIndex }),
        stage: "policy_denied",
        payload: toDeniedPolicyTracePayload(policyDecision),
      });
      await this.record({
        runId: job.runId,
        stage: "run_completed",
        payload: {
          status: "blocked",
          errorCode: "PolicyDenied",
        },
      });

      return {
        jobId: job.jobId,
        runId: job.runId,
        status: "blocked",
        errorCode: "PolicyDenied",
      };
    }

    await this.record({
      runId: job.runId,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      stage: "policy_authorized",
      payload: toAuthorizedPolicyTracePayload(policyDecision),
    });

    this.budget.maximumOutputTokens(job.runId);
    const permit = ExecutionPermit.fromAllowedDecision(policyDecision);
    const outcome = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.actionExecutor.execute(action, permit, signal));
    await this.record({
      runId: job.runId,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      stage: "action_executed",
      payload: toActionOutcomeTracePayload(outcome),
    });

    if (outcome.status === "failed") {
      const errorCode = outcome.errorCode ?? "ActionFailed";
      await this.record({
        runId: job.runId,
        stage: "run_completed",
        payload: {
          status: "blocked",
          errorCode,
        },
      });

      return {
        jobId: job.jobId,
        runId: job.runId,
        status: "blocked",
        errorCode,
      };
    }

    const after = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.observer.capture(job, signal));
    await this.record({
      runId: job.runId,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      stage: "observation",
      payload: after,
    });

    const verification = await this.withinWallClock(job.runId, (signal) =>
      this.dependencies.verifier.verify({
        job,
        before: observation,
        after,
        action,
        outcome,
        budget: this.budget,
        signal,
      }));
    await this.record({
      runId: job.runId,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      stage: "verification",
      payload: toVerificationTracePayload(verification),
    });

    if (verification.status === "passed") {
      await this.record({
        runId: job.runId,
        stage: "run_completed",
        payload: { status: "passed" },
      });

      return {
        jobId: job.jobId,
        runId: job.runId,
        status: "passed",
      };
    }

    const finding = findingFromVerification(job.runId, verification, observation, after);
    await this.record({
      runId: job.runId,
      ...(stepIndex === undefined ? {} : { stepIndex }),
      stage: "finding",
      payload: finding,
    });
    await this.record({
      runId: job.runId,
      stage: "run_completed",
      payload: {
        status: "finding",
        findingId: finding.findingId,
      },
    });

    return {
      jobId: job.jobId,
      runId: job.runId,
      status: "finding",
      finding,
    };
  }

  private async record(input: TraceEventInput): Promise<void> {
    await this.dependencies.traceRecorder.append(input);
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
