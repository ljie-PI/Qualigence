import { createHash } from "node:crypto";

export * from "./capabilities.js";
export * from "./messages.js";

/**
 * Observation Graph v1 candidate contract (LS-12).
 *
 * The v1 Graph lives in `@qualigence/observation-contracts`, which is the single
 * source of truth. Runner Protocol re-exports it for a compatibility cycle so
 * consumers have one canonical import surface. Live Web producers now emit this
 * candidate v1 shape while the existing pre-v1 {@link ObservationGraph}/
 * {@link ObservationNode} types below are kept as historical asset DTOs for the
 * later inventory/contraction tickets.
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
  WebViewportV1,
  WebExtensionV1Payload,
  WebExtensionV1,
  ObservationNodeV1,
  ObservationGraphV1,
  PreV1AssetMetadata,
  ObservationErrorCode,
  ParsedExtensionKey,
} from "@qualigence/observation-contracts";

export {
  OBSERVATION_GRAPH_V1_VERSION,
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_TYPE,
  WEB_EXTENSION_V1_REDACTION_MARKER,
  ObservationError,
  observationError,
  parseExtensionKey,
  requireExtensionMajor,
  requireGraphExtensionMajor,
  findExtensionMajor,
  findGraphExtensionMajor,
  validateObservationGraphV1,
  observationGraphHash,
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

export class ExecutionPolicySnapshotError extends Error {
  constructor() {
    super("execution policy snapshot is missing or malformed");
    this.name = "ExecutionPolicySnapshotError";
  }
}

export class ExecutionPlanPolicyError extends ExecutionPolicySnapshotError {
  constructor() {
    super();
    this.name = "ExecutionPlanPolicyError";
  }
}

const POLICY_ENVIRONMENTS = ["isolated_test", "staging", "production"] as const;
const POLICY_ACTION_KINDS = ["navigate", "click", "input", "select", "scroll", "window"] as const;
const POLICY_RISKS = ["Normal", "ExternalSideEffect", "Destructive", "ProductionForbidden"] as const;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Strict transport-safe parser shared by wire, persistence, and Runner admission. */
export function parseExecutionPolicySnapshot(value: unknown): ExecutionPolicySnapshot {
  const policy = record(value);
  const policyId = nonEmptyString(policy.policyId);
  const environment = enumValue(policy.environment, POLICY_ENVIRONMENTS);
  const allowedOrigins = stringArray(policy.allowedOrigins).map(parseOrigin);
  const allowedActionKinds = enumArray(policy.allowedActionKinds, POLICY_ACTION_KINDS);
  const maximumRisk = enumValue(policy.maximumRisk, POLICY_RISKS);
  if (typeof policy.explorationAllowed !== "boolean") throw new ExecutionPolicySnapshotError();
  const issuedAt = isoInstant(policy.issuedAt);
  const expiresAt = isoInstant(policy.expiresAt);
  if (Date.parse(issuedAt) >= Date.parse(expiresAt)) throw new ExecutionPolicySnapshotError();
  if (new Set(allowedOrigins).size !== allowedOrigins.length || new Set(allowedActionKinds).size !== allowedActionKinds.length) {
    throw new ExecutionPolicySnapshotError();
  }
  if (environment === "staging" && (allowedActionKinds.length !== 1 || allowedActionKinds[0] !== "click" || maximumRisk !== "Normal" || policy.explorationAllowed)) {
    throw new ExecutionPolicySnapshotError();
  }
  return { policyId, environment, allowedOrigins, allowedActionKinds, maximumRisk, explorationAllowed: policy.explorationAllowed, issuedAt, expiresAt };
}

export function parseExecutionJob(value: unknown): AcceptedExecutionJob {
  const raw = record(value);
  const identity = parseExecutionJobIdentity(raw);
  const policy = parseExecutionPolicySnapshot(raw.policy);
  const plan = raw.plan === undefined ? undefined : parseExecutionJobPlanSnapshot(raw.plan);
  if (plan?.steps.some((step) =>
    step.stepIndex !== undefined && step.kind !== "verify" && !policy.allowedActionKinds.includes(step.kind)
  )) {
    throw new ExecutionPlanPolicyError();
  }
  return plan === undefined ? { ...identity, policy } : { ...identity, policy, plan };
}

function parseExecutionJobPlanSnapshot(value: unknown): ExecutionJobPlanSnapshot {
  const plan = record(value);
  exactKeys(plan, ["missionId", "missionRevision", "testCaseId", "steps", "expectedClaimIds", "budget"]);
  const steps = array(plan.steps).map(parseExecutionPlanStep);
  validateStepIndices(steps);
  const expectedClaimIds = stringTuple(plan.expectedClaimIds);
  const [firstStep, ...remainingSteps] = steps;
  if (firstStep === undefined) throw new ExecutionPolicySnapshotError();
  const budget = record(plan.budget);
  exactKeys(budget, ["maximumStepsPerJob", "maximumWallClockMs", "maximumModelTokens"]);
  const maximumStepsPerJob = positiveSafeInteger(budget.maximumStepsPerJob);
  if (steps.length > maximumStepsPerJob) throw new ExecutionPolicySnapshotError();
  return {
    missionId: nonEmptyString(plan.missionId),
    missionRevision: positiveSafeInteger(plan.missionRevision),
    testCaseId: nonEmptyString(plan.testCaseId),
    steps: [firstStep, ...remainingSteps],
    expectedClaimIds,
    budget: {
      maximumStepsPerJob,
      maximumWallClockMs: positiveSafeInteger(budget.maximumWallClockMs),
      maximumModelTokens: positiveSafeInteger(budget.maximumModelTokens),
    },
  };
}

function parseExecutionPlanStep(value: unknown): ExecutionPlanStep {
  const step = record(value);
  const stepIndex = step.stepIndex === undefined ? undefined : nonNegativeSafeInteger(step.stepIndex);
  const indexed = stepIndex === undefined ? {} : { stepIndex };
  switch (step.kind) {
    case "navigate":
      exactKeys(step, stepIndex === undefined ? ["kind", "path"] : ["stepIndex", "kind", "path"]);
      return { ...indexed, kind: "navigate", path: nonEmptyString(step.path) };
    case "click":
      exactKeys(step, stepIndex === undefined ? ["kind", "target"] : ["stepIndex", "kind", "target"]);
      return { ...indexed, kind: "click", target: parseExecutionPlanTarget(step.target) };
    case "input": {
      exactKeys(step, stepIndex === undefined ? ["kind", "target", "valueRef"] : ["stepIndex", "kind", "target", "valueRef"]);
      return { ...indexed, kind: "input", target: parseExecutionPlanTarget(step.target), valueRef: nonEmptyString(step.valueRef) };
    }
    case "select":
      exactKeys(step, ["stepIndex", "kind", "target", "valueRef"]);
      return {
        stepIndex: nonNegativeSafeInteger(step.stepIndex),
        kind: "select",
        target: parseExecutionPlanTarget(step.target),
        valueRef: nonEmptyString(step.valueRef),
      };
    case "scroll": {
      exactKeys(step, step.target === undefined
        ? ["stepIndex", "kind", "direction", "amount"]
        : ["stepIndex", "kind", "target", "direction", "amount"]);
      const target = step.target === undefined ? undefined : parseExecutionPlanTarget(step.target);
      return {
        stepIndex: nonNegativeSafeInteger(step.stepIndex),
        kind: "scroll",
        ...(target === undefined ? {} : { target }),
        direction: enumValue(step.direction, ["up", "down", "left", "right"] as const),
        amount: enumValue(step.amount, ["small", "page"] as const),
      };
    }
    case "verify":
      exactKeys(step, stepIndex === undefined ? ["kind", "claimIds"] : ["stepIndex", "kind", "claimIds"]);
      return { ...indexed, kind: "verify", claimIds: stringTuple(step.claimIds) };
    default:
      throw new ExecutionPolicySnapshotError();
  }
}

function validateStepIndices(steps: readonly ExecutionPlanStep[]): void {
  const indexed = steps.some((step) => step.stepIndex !== undefined);
  if (!indexed) return;
  if (steps.some((step, index) => step.stepIndex !== index)) throw new ExecutionPolicySnapshotError();
}

function parseExecutionPlanTarget(value: unknown): ExecutionPlanTarget {
  const target = record(value);
  exactKeys(target, ["role", "name", "purpose"]);
  const role = target.role === undefined ? undefined : nonEmptyString(target.role);
  const name = target.name === undefined ? undefined : nonEmptyString(target.name);
  const base = { purpose: nonEmptyString(target.purpose) };
  return role === undefined && name === undefined
    ? base
    : { ...base, ...(role === undefined ? {} : { role }), ...(name === undefined ? {} : { name }) };
}

function parseExecutionJobIdentity(value: unknown): Omit<AcceptedExecutionJob, "policy" | "plan"> {
  const job = record(value);
  const target = record(job.target);
  if (target.kind !== "web") throw new ExecutionPolicySnapshotError();
  return {
    jobId: nonEmptyString(job.jobId),
    runId: nonEmptyString(job.runId),
    projectId: nonEmptyString(job.projectId),
    target: { kind: "web", url: parseTargetUrl(target.url) },
    objective: nonEmptyString(job.objective),
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ExecutionPolicySnapshotError();
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new ExecutionPolicySnapshotError();
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ExecutionPolicySnapshotError();
  return value;
}

function positiveSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ExecutionPolicySnapshotError();
  return value;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ExecutionPolicySnapshotError();
  return value;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new ExecutionPolicySnapshotError();
  return value;
}

function stringTuple(value: unknown): readonly [string, ...string[]] {
  const items = array(value).map(nonEmptyString);
  const [first, ...rest] = items;
  if (first === undefined) throw new ExecutionPolicySnapshotError();
  return [first, ...rest];
}

function isoInstant(value: unknown): string {
  const instant = nonEmptyString(value);
  if (!ISO_INSTANT.test(instant) || !Number.isFinite(Date.parse(instant)) || new Date(instant).toISOString() !== instant) throw new ExecutionPolicySnapshotError();
  return instant;
}

function parseOrigin(value: string): string {
  if (value.includes("*")) throw new ExecutionPolicySnapshotError();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ExecutionPolicySnapshotError(); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "" || parsed.origin !== value) throw new ExecutionPolicySnapshotError();
  return value;
}

function parseTargetUrl(value: unknown): string {
  const url = nonEmptyString(value);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ExecutionPolicySnapshotError(); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") throw new ExecutionPolicySnapshotError();
  return url;
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new ExecutionPolicySnapshotError();
  return value as T[number];
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ExecutionPolicySnapshotError();
  return value.map(nonEmptyString);
}

function enumArray<T extends readonly string[]>(value: unknown, allowed: T): readonly T[number][] {
  if (!Array.isArray(value) || value.length === 0) throw new ExecutionPolicySnapshotError();
  return value.map((item) => enumValue(item, allowed));
}

export interface AcceptedExecutionJob {
  readonly jobId: ExecutionJobId;
  readonly runId: RunId;
  readonly projectId: string;
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
export type LegacyExecutionPlanStep =
  | { readonly stepIndex?: never; readonly kind: "navigate"; readonly path: string }
  | { readonly stepIndex?: never; readonly kind: "click"; readonly target: ExecutionPlanTarget }
  | {
      readonly stepIndex?: never;
      readonly kind: "input";
      readonly target: ExecutionPlanTarget;
      readonly valueRef: string;
    }
  | {
      readonly stepIndex?: never;
      readonly kind: "verify";
      readonly claimIds: readonly [string, ...string[]];
    };

export type IndexedExecutionPlanStep =
  | { readonly stepIndex: number; readonly kind: "navigate"; readonly path: string }
  | { readonly stepIndex: number; readonly kind: "click"; readonly target: ExecutionPlanTarget }
  | {
      readonly stepIndex: number;
      readonly kind: "input";
      readonly target: ExecutionPlanTarget;
      readonly valueRef: string;
    }
  | {
      readonly stepIndex: number;
      readonly kind: "select";
      readonly target: ExecutionPlanTarget;
      readonly valueRef: string;
    }
  | {
      readonly stepIndex: number;
      readonly kind: "scroll";
      readonly target?: ExecutionPlanTarget;
      readonly direction: "up" | "down" | "left" | "right";
      readonly amount: "small" | "page";
    }
  | {
      readonly stepIndex: number;
      readonly kind: "verify";
      readonly claimIds: readonly [string, ...string[]];
    };

export type ExecutionPlanStep = LegacyExecutionPlanStep | IndexedExecutionPlanStep;

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
  readonly stepIndex?: number;
  readonly stage: TStage;
  readonly occurredAt: string;
  readonly payloadHash: string;
  readonly payload: TPayload;
}

export type DecisionTracePayload =
  | { readonly kind: "navigate"; readonly path: string; readonly reason: string }
  | { readonly kind: "click"; readonly target: { readonly nodeId: ObservationNodeId }; readonly reason: string }
  | { readonly kind: "input"; readonly target: { readonly nodeId: ObservationNodeId }; readonly valueRef: string; readonly reason: string }
  | { readonly kind: "select"; readonly target: { readonly nodeId: ObservationNodeId }; readonly valueRef: string; readonly reason: string }
  | { readonly kind: "scroll"; readonly target?: { readonly nodeId: ObservationNodeId }; readonly direction: "up" | "down" | "left" | "right"; readonly amount: "small" | "page"; readonly reason: string }
  | { readonly kind: "window"; readonly target: { readonly nodeId: ObservationNodeId }; readonly operation: "focus" | "minimize" | "restore" | "close"; readonly reason: string };

interface ResolvedWebElementTraceBase {
  readonly targetKind?: "web";
  readonly target: {
    readonly nodeId: ObservationNodeId;
    readonly selector: string;
  };
  readonly graphId: ObservationGraphId;
}

export type ResolvedWebActionTracePayload =
  | { readonly targetKind: "web"; readonly kind: "navigate"; readonly url: string }
  | (ResolvedWebElementTraceBase & { readonly kind: "click" })
  | (ResolvedWebElementTraceBase & { readonly targetKind: "web"; readonly kind: "input"; readonly valueRef: string })
  | (ResolvedWebElementTraceBase & { readonly targetKind: "web"; readonly kind: "select"; readonly valueRef: string })
  | ({ readonly targetKind: "web"; readonly kind: "scroll"; readonly graphId: ObservationGraphId; readonly target?: { readonly nodeId: ObservationNodeId; readonly selector: string }; readonly direction: "up" | "down" | "left" | "right"; readonly amount: "small" | "page" });

export type ResolvedActionTracePayload =
  | ResolvedWebActionTracePayload
  | import("@qualigence/desktop-contracts").ResolvedDesktopAction;

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
