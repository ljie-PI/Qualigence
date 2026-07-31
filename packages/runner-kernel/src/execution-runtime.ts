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
  RunId,
  TraceEvent,
  VerificationTracePayload,
} from "@qualigence/runner-protocol";

export interface ProposedAction {
  readonly kind: "click";
  readonly target: {
    readonly nodeId: string;
  };
  readonly reason: string;
}

export interface ResolvedAction {
  readonly kind: "click";
  readonly target: {
    readonly nodeId: string;
    readonly selector: string;
  };
  readonly graphId: string;
}

export type PolicyDecision =
  | {
      readonly status: "allowed";
      readonly reason: string;
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

export interface Observer {
  capture(job: AcceptedExecutionJob): Promise<ObservationGraph>;
}

export interface ExecutionDecisionProvider {
  decide(context: AgentContext): Promise<ProposedAction>;
}

export interface AgentContext {
  readonly job: AcceptedExecutionJob;
  readonly observation: ObservationGraph;
}

export interface ActionResolver {
  resolve(
    action: ProposedAction,
    graph: ObservationGraph,
  ): Promise<ResolvedAction>;
}

export interface RunnerPolicyContext {
  readonly job: AcceptedExecutionJob;
  readonly action: ResolvedAction;
}

export interface RunnerPolicyGate {
  authorize(
    action: ResolvedAction,
    context: RunnerPolicyContext,
  ): Promise<PolicyDecision>;
}

export interface ActionExecutor {
  execute(action: ResolvedAction, permit: ExecutionPermit): Promise<ActionOutcome>;
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
}

export interface TraceRecorder {
  append(event: TraceEventInput): Promise<TraceEvent>;
}

export type TraceEventInput = TraceEvent extends infer TEvent
  ? TEvent extends TraceEvent
    ? Pick<TEvent, "runId" | "stage" | "payload">
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
}

const executionPermitBrand: unique symbol = Symbol("ExecutionPermit");

export class ExecutionPermit {
  readonly [executionPermitBrand] = true;

  private constructor(readonly reason: string) {}

  static fromAllowedDecision(decision: PolicyDecision): ExecutionPermit {
    if (decision.status !== "allowed") {
      throw new Error("ExecutionPermit requires an allowed policy decision.");
    }

    return new ExecutionPermit(decision.reason);
  }
}

export class ExecutionRuntime {
  constructor(private readonly dependencies: ExecutionRuntimeDependencies) {}

  async run(job: AcceptedExecutionJob): Promise<ExecutionCompletion> {
    const observation = await this.dependencies.observer.capture(job);
    await this.record({
      runId: job.runId,
      stage: "observation",
      payload: observation,
    });

    const decision = await this.dependencies.decisionProvider.decide({
      job,
      observation,
    });
    await this.record({
      runId: job.runId,
      stage: "decision",
      payload: toDecisionTracePayload(decision),
    });

    const action = await this.dependencies.resolver.resolve(decision, observation);
    await this.record({
      runId: job.runId,
      stage: "action_resolved",
      payload: toResolvedActionTracePayload(action),
    });

    const policyDecision = await this.dependencies.policyGate.authorize(action, {
      job,
      action,
    });

    if (policyDecision.status === "denied") {
      await this.record({
        runId: job.runId,
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
      stage: "policy_authorized",
      payload: toAuthorizedPolicyTracePayload(policyDecision),
    });

    const permit = ExecutionPermit.fromAllowedDecision(policyDecision);
    const outcome = await this.dependencies.actionExecutor.execute(action, permit);
    await this.record({
      runId: job.runId,
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

    const after = await this.dependencies.observer.capture(job);
    await this.record({
      runId: job.runId,
      stage: "observation",
      payload: after,
    });

    const verification = await this.dependencies.verifier.verify({
      job,
      before: observation,
      after,
      action,
      outcome,
    });
    await this.record({
      runId: job.runId,
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

    const finding = findingFromVerification(job.runId, verification);
    await this.record({
      runId: job.runId,
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
}

function toDecisionTracePayload(action: ProposedAction): DecisionTracePayload {
  return action;
}

function toResolvedActionTracePayload(
  action: ResolvedAction,
): ResolvedActionTracePayload {
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
): FindingEnvelope {
  return {
    findingId: `${runId}:verification`,
    runId,
    title: "M1 verification failed",
    summary: verification.summary,
    severity: verification.severitySuggestion,
    evidenceRefs: [...new Set(
      verification.claims.flatMap((claim) => [
        `${claim.expected.graphId}:${claim.expected.nodeId}`,
        `${claim.observed.graphId}:${claim.observed.nodeId}`,
      ]),
    )],
  };
}
