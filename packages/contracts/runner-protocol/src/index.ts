export type ExecutionJobId = string;
export type RunId = string;
export type ObservationGraphId = string;
export type ObservationNodeId = string;
export type FindingId = string;

export interface WebTargetRef {
  readonly kind: "web";
  readonly url: string;
}

export type TargetRef = WebTargetRef;

export interface AcceptedExecutionJob {
  readonly jobId: ExecutionJobId;
  readonly runId: RunId;
  readonly target: TargetRef;
  readonly objective: string;
}

export interface ObservationNode {
  readonly id: ObservationNodeId;
  readonly role: string;
  readonly name?: string;
  readonly confidence: number;
}

export interface ObservationGraph {
  readonly graphId: ObservationGraphId;
  readonly nodes: readonly ObservationNode[];
}

export interface ProposedAction {
  readonly kind: "click";
  readonly target: {
    readonly nodeId: ObservationNodeId;
  };
  readonly reason: string;
}

export interface ResolvedAction {
  readonly kind: "click";
  readonly target: {
    readonly nodeId: ObservationNodeId;
    readonly selector: string;
  };
  readonly graphId: ObservationGraphId;
}

export interface PolicyDecision {
  readonly status: "allowed" | "denied";
  readonly reason: string;
}

export interface ActionOutcome {
  readonly status: "ok" | "failed";
  readonly errorCode?: string;
}

export interface VerificationResult {
  readonly status: "passed" | "failed";
  readonly summary: string;
}

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface FindingEnvelope {
  readonly findingId: FindingId;
  readonly runId: RunId;
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly evidenceRefs: readonly string[];
}

export type TraceStage =
  | "observation"
  | "decision"
  | "action_resolved"
  | "policy_authorized"
  | "policy_denied"
  | "action_executed"
  | "verification"
  | "finding";

export interface TraceEvent {
  readonly runId: RunId;
  readonly sequenceNumber: number;
  readonly stage: TraceStage;
  readonly payloadHash: string;
  readonly payload: unknown;
}

export interface ExecutionCompletion {
  readonly jobId: ExecutionJobId;
  readonly runId: RunId;
  readonly status: "completed" | "blocked";
  readonly finding: FindingEnvelope;
}
