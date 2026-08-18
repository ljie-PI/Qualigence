import { createHash } from "node:crypto";

export * from "./capabilities.js";
export * from "./messages.js";

/**
 * Observation Graph v1 candidate contract (LS-12).
 *
 * The v1 Graph lives in `@qualigence/observation-contracts`, which is the single
 * source of truth. Runner Protocol re-exports it for a compatibility cycle so
 * consumers have one canonical import surface. This is purely additive: the
 * existing pre-v1 {@link ObservationGraph}/{@link ObservationNode} types below
 * are unchanged and remain the shape the live runtime uses until a later PR
 * (LS-13) migrates consumers over.
 */
export type {
  ObservationJsonValue,
  ObservationSchema,
  ObservationTarget,
  ObservationRelationType,
  ObservationRelationV1,
  ObservationNodeSource,
  ObservationBounds,
  ObservationSensitivity,
  VersionedExtension,
  ObservationNodeV1,
  ObservationGraphV1,
  PreV1AssetMetadata,
  ObservationErrorCode,
  ParsedExtensionKey,
} from "@qualigence/observation-contracts";

export {
  OBSERVATION_GRAPH_V1_VERSION,
  OBSERVATION_GRAPH_V1_SCHEMA,
  ObservationError,
  observationError,
  parseExtensionKey,
  requireExtensionMajor,
  findExtensionMajor,
} from "@qualigence/observation-contracts";

/**
 * Desktop / Windows Target action contract additions (LS-13, PR-25).
 *
 * The desktop action union and Companion IPC DTOs live in
 * `@qualigence/desktop-contracts`, which is their single source of truth. Runner
 * Protocol re-exports them additively so consumers keep one canonical import
 * surface — the same pattern used above for the Observation Graph v1 types. This
 * is purely additive: the existing pre-desktop `TraceEvent`/`ObservationGraph`
 * shapes are unchanged, and the branded `ExecutionPermit`/Sensor/Action runtime
 * wiring in `@qualigence/runner-kernel` is untouched by this PR (that is PR-26).
 */
export type {
  AppTarget,
  AppSession,
  DesktopEnvironmentProvider,
  DesktopPlatform,
  UiaPattern,
  UiaPatternDescriptor,
  UiaExtensionV1,
  DesktopActionKind,
  DesktopAdapterCapabilities,
  AdapterSupport,
  LocalActionRisk,
  DesktopActionResolution,
  ResolvedDesktopActionBase,
  ResolvedDesktopAction,
  ResolvedWebAction,
  ResolvedAction,
  LocalPermitAuthorization,
  LocalPermitRequest,
  LocalApprovalStatus,
  LocalApprovalDecision,
  LocalExecutionPermit,
  CompanionRequest,
  CompanionRequestType,
} from "@qualigence/desktop-contracts";

export {
  UIA_EXTENSION_TYPE,
  UIA_EXTENSION_VERSION,
  COMPANION_REQUEST_TYPES,
  parseCompanionRequest,
  parseCompanionDecision,
  parseResolvedDesktopAction,
  classifyLocalAuthorization,
  isLocalPermitExpired,
} from "@qualigence/desktop-contracts";


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

export type ExecutionPolicyEnvironment = "isolated_test" | "staging" | "production";
export type ExecutionPolicyActionKind = "navigate" | "click" | "input" | "select" | "scroll" | "window";
export type ExecutionPolicyRisk = "Normal" | "ExternalSideEffect" | "Destructive" | "ProductionForbidden";

/**
 * Immutable Core-issued authority snapshot for exactly one accepted Job. It is
 * carried losslessly over the Runner Protocol and never inferred by a Runner.
 */
export interface ExecutionPolicySnapshot {
  readonly policyId: string;
  readonly environment: ExecutionPolicyEnvironment;
  readonly allowedOrigins: readonly string[];
  readonly allowedActionKinds: readonly ExecutionPolicyActionKind[];
  readonly maximumRisk: ExecutionPolicyRisk;
  readonly explorationAllowed: boolean;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface AcceptedExecutionJob {
  readonly jobId: ExecutionJobId;
  readonly runId: RunId;
  readonly target: TargetRef;
  readonly objective: string;
  readonly policy: ExecutionPolicySnapshot;
  /**
   * Optional immutable Mission plan snapshot (LS-07). Purely additive: M1
   * objective-only jobs omit it. When present it is a read-only Runner DTO —
   * the Runner never writes it back or mutates the referenced plan.
   */
  readonly plan?: ExecutionJobPlanSnapshot;
}

/** A semantic action target inside a {@link ExecutionPlanStep}; never a selector. */
export interface ExecutionPlanTarget {
  readonly role?: string;
  readonly name?: string;
  readonly purpose: string;
}

/**
 * A single compiled intent step carried in an {@link ExecutionJobPlanSnapshot}.
 * `verify` steps reference concrete claim IDs (already compiled from semantic
 * keys by the Core command handler), never raw semantic keys.
 */
export type ExecutionPlanStep =
  | { readonly kind: "navigate"; readonly path: string }
  | { readonly kind: "click"; readonly target: ExecutionPlanTarget }
  | {
      readonly kind: "input";
      readonly target: ExecutionPlanTarget;
      readonly valueRef: string;
    }
  | {
      readonly kind: "verify";
      readonly claimIds: readonly [string, ...string[]];
    };

/** Per-job execution budget carried alongside the plan snapshot. */
export interface ExecutionPlanBudget {
  readonly maximumStepsPerJob: number;
  readonly maximumWallClockMs: number;
  readonly maximumModelTokens: number;
}

/**
 * An immutable snapshot of the approved Mission plan for a single Test Case.
 * It pins the Mission revision, the compiled steps and the expected claim IDs so
 * a later PRD update never mutates an in-flight Job. It is a Runner DTO only.
 */
export interface ExecutionJobPlanSnapshot {
  readonly missionId: string;
  readonly missionRevision: number;
  readonly testCaseId: string;
  readonly steps: readonly [ExecutionPlanStep, ...ExecutionPlanStep[]];
  readonly expectedClaimIds: readonly [string, ...string[]];
  readonly budget: ExecutionPlanBudget;
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
      readonly severitySuggestion: "low" | "medium" | "high";
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
