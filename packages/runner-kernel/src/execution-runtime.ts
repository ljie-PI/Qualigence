import { createHash } from "node:crypto";
import type {
  AcceptedExecutionJob,
  ActionOutcome,
  ExecutionCompletion,
  FindingEnvelope,
  ObservationGraph,
  PolicyDecision,
  ProposedAction,
  ResolvedAction,
  RunId,
  TraceEvent,
  TraceStage,
  VerificationResult,
} from "../../contracts/runner-protocol/src/index.js";

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
  readonly action: ResolvedAction;
  readonly outcome: ActionOutcome;
}

export interface TraceRecorder {
  append(event: TraceEventInput): Promise<TraceEvent>;
}

export type TraceEventInput = Omit<TraceEvent, "sequenceNumber" | "payloadHash"> & {
  readonly payloadHash?: string;
};

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
    await this.record(job.runId, "observation", observation);

    const decision = await this.dependencies.decisionProvider.decide({
      job,
      observation,
    });
    await this.record(job.runId, "decision", decision);

    const action = await this.dependencies.resolver.resolve(decision, observation);
    await this.record(job.runId, "action_resolved", action);

    const policyDecision = await this.dependencies.policyGate.authorize(action, {
      job,
      action,
    });

    if (policyDecision.status === "denied") {
      await this.record(job.runId, "policy_denied", policyDecision);
      return {
        jobId: job.jobId,
        runId: job.runId,
        status: "blocked",
        finding: {
          findingId: `${job.runId}:policy-denied`,
          runId: job.runId,
          title: "M1 policy denied action",
          severity: "medium",
          evidenceRefs: [],
        },
      };
    }

    await this.record(job.runId, "policy_authorized", policyDecision);

    const permit = ExecutionPermit.fromAllowedDecision(policyDecision);
    const outcome = await this.dependencies.actionExecutor.execute(action, permit);
    await this.record(job.runId, "action_executed", outcome);

    const verification = await this.dependencies.verifier.verify({
      job,
      before: observation,
      action,
      outcome,
    });
    await this.record(job.runId, "verification", verification);

    const finding = findingFromVerification(job.runId, verification);
    await this.record(job.runId, "finding", finding);

    return {
      jobId: job.jobId,
      runId: job.runId,
      status: verification.status === "passed" ? "completed" : "blocked",
      finding,
    };
  }

  private async record(
    runId: RunId,
    stage: TraceStage,
    payload: unknown,
  ): Promise<void> {
    await this.dependencies.traceRecorder.append({
      runId,
      stage,
      payload,
    });
  }
}

export class ScriptedDecisionProvider implements ExecutionDecisionProvider {
  constructor(private readonly action: ProposedAction) {}

  async decide(): Promise<ProposedAction> {
    return this.action;
  }
}

export class AllowAllRunnerPolicyGate implements RunnerPolicyGate {
  async authorize(): Promise<PolicyDecision> {
    return { status: "allowed", reason: "allowed by test policy" };
  }
}

export class InMemoryTraceRecorder implements TraceRecorder {
  private readonly eventsByRun = new Map<RunId, TraceEvent[]>();

  async append(input: TraceEventInput): Promise<TraceEvent> {
    const events = this.eventsByRun.get(input.runId) ?? [];
    const event: TraceEvent = {
      runId: input.runId,
      sequenceNumber: events.length + 1,
      stage: input.stage,
      payloadHash: input.payloadHash ?? hashPayload(input.payload),
      payload: input.payload,
    };

    events.push(event);
    this.eventsByRun.set(input.runId, events);
    return event;
  }

  eventsFor(runId: RunId): readonly TraceEvent[] {
    return [...(this.eventsByRun.get(runId) ?? [])];
  }
}

function findingFromVerification(
  runId: RunId,
  verification: VerificationResult,
): FindingEnvelope {
  return {
    findingId: `${runId}:verification`,
    runId,
    title:
      verification.status === "passed"
        ? "M1 verification passed"
        : "M1 verification failed",
    severity: verification.status === "passed" ? "info" : "medium",
    evidenceRefs: [],
  };
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
