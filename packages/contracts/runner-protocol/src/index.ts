import { createHash } from "node:crypto";

export type ExecutionJobId = string;
export type RunId = string;
export type ObservationGraphId = string;
export type ObservationNodeId = string;
export type FindingId = string;
export type MessageId = string;
export type IdempotencyKey = string;
export type RunnerProtocolVersion = "runner-protocol/v1";
export type TraceEventSchemaVersion = "trace-event/v1";

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
  readonly text?: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly confidence: number;
}

export interface ObservationGraph {
  readonly graphId: ObservationGraphId;
  readonly url?: string;
  readonly title?: string;
  readonly capturedAt?: string;
  readonly artifactRefs?: readonly string[];
  readonly nodes: readonly ObservationNode[];
}

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface FindingEnvelope {
  readonly findingId: FindingId;
  readonly runId: RunId;
  readonly title: string;
  readonly summary: string;
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
  | "finding"
  | "run_completed";

interface TraceEventEnvelope<TStage extends TraceStage, TPayload> {
  readonly protocolVersion: RunnerProtocolVersion;
  readonly schemaVersion: TraceEventSchemaVersion;
  readonly messageId: MessageId;
  readonly idempotencyKey: IdempotencyKey;
  readonly runId: RunId;
  readonly sequenceNumber: number;
  readonly stage: TStage;
  readonly occurredAt: string;
  readonly payloadHash: string;
  readonly payload: TPayload;
}

export interface DecisionTracePayload {
  readonly kind: "click";
  readonly target: {
    readonly nodeId: ObservationNodeId;
  };
  readonly reason: string;
}

export interface ResolvedActionTracePayload {
  readonly kind: "click";
  readonly target: {
    readonly nodeId: ObservationNodeId;
    readonly selector: string;
  };
  readonly graphId: ObservationGraphId;
}

export interface AuthorizedPolicyTracePayload {
  readonly status: "allowed";
  readonly reason: string;
}

export interface DeniedPolicyTracePayload {
  readonly status: "denied";
  readonly reason: string;
}

export interface ActionOutcomeTracePayload {
  readonly status: "ok" | "failed";
  readonly errorCode?: string;
}

export interface VerificationEvidenceValue {
  readonly graphId: ObservationGraphId;
  readonly nodeId: ObservationNodeId;
  readonly text: string;
}

export interface VerificationClaim {
  readonly expected: VerificationEvidenceValue;
  readonly observed: VerificationEvidenceValue;
}

export type VerificationTracePayload =
  | {
      readonly status: "passed";
      readonly summary: string;
      readonly claims: readonly [];
    }
  | {
      readonly status: "failed";
      readonly summary: string;
      readonly severitySuggestion: Exclude<FindingSeverity, "info">;
      readonly claims: readonly [VerificationClaim, ...VerificationClaim[]];
    };

export type RunCompletedTracePayload =
  | {
      readonly status: "passed";
    }
  | {
      readonly status: "finding";
      readonly findingId: FindingId;
    }
  | {
      readonly status: "blocked";
      readonly errorCode?: string;
    }
  | {
      readonly status: "error";
      readonly errorCode: string;
    };

export type TraceEvent =
  | TraceEventEnvelope<"observation", ObservationGraph>
  | TraceEventEnvelope<"decision", DecisionTracePayload>
  | TraceEventEnvelope<"action_resolved", ResolvedActionTracePayload>
  | TraceEventEnvelope<"policy_authorized", AuthorizedPolicyTracePayload>
  | TraceEventEnvelope<"policy_denied", DeniedPolicyTracePayload>
  | TraceEventEnvelope<"action_executed", ActionOutcomeTracePayload>
  | TraceEventEnvelope<"verification", VerificationTracePayload>
  | TraceEventEnvelope<"finding", FindingEnvelope>
  | TraceEventEnvelope<"run_completed", RunCompletedTracePayload>;

export type TraceEventHashInput = TraceEvent extends infer TEvent
  ? TEvent extends TraceEvent
    ? Omit<TEvent, "payloadHash">
    : never
  : never;

export type TraceEventSubmission = TraceEvent;

export type ExecutionCompletion =
  | {
      readonly jobId: ExecutionJobId;
      readonly runId: RunId;
      readonly status: "passed";
    }
  | {
      readonly jobId: ExecutionJobId;
      readonly runId: RunId;
      readonly status: "finding";
      readonly finding: FindingEnvelope;
    }
  | {
      readonly jobId: ExecutionJobId;
      readonly runId: RunId;
      readonly status: "blocked";
      readonly errorCode?: string;
    }
  | {
      readonly jobId: ExecutionJobId;
      readonly runId: RunId;
      readonly status: "error";
      readonly errorCode: string;
    };

export function canonicalPayloadHash(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex");
}

export function canonicalTraceEventHash(event: TraceEventHashInput): string {
  return canonicalPayloadHash(event);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);

  return `{${entries.join(",")}}`;
}
