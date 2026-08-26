/**
 * Companion IPC contract (LS-13 / M3).
 *
 * The Rust Companion is the SOLE broker for desktop process lifecycle, UIA
 * capture and UIA action execution (specialist review finding W-01). TypeScript
 * never holds a Win32/UIA handle or a target PID; it may only send these typed,
 * bounded, versioned request DTOs across the authenticated Named Pipe.
 *
 * Every frame uses a bounded 32-bit big-endian length prefix followed by a UTF-8
 * JSON envelope. The envelope is part of the public security contract consumed
 * by the downstream native Companion tickets: request IDs are unique among
 * in-flight requests, request/response variants are correlated by type, and the
 * certificate proof signs the exact bytes produced by
 * {@link buildCompanionProofBytes}.
 */

import { createHash } from "node:crypto";
import type { UiaPattern, UiaPatternDescriptor } from "./uia-extension.js";
import { validateAppTarget, type AppSession, type AppTarget } from "./app-target.js";

export type LocalActionRisk = "Normal" | "ExternalSideEffect" | "Destructive" | "ProductionForbidden";

export type DesktopActionResolution = "semantic" | "uia" | "visual" | "coordinate";

export interface ResolvedDesktopActionBase {
  readonly targetKind: "desktop";
  readonly actionId: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly resolution: DesktopActionResolution;
  readonly uiaPattern?: UiaPattern;
}

export interface DesktopValueBinding {
  readonly valueRef: string;
  readonly valueSha256: string;
  readonly valueByteLength: number;
}

export interface DesktopPlaintextValue extends DesktopValueBinding {
  /** Bounded short-lived plaintext for the authenticated action dispatch frame only. */
  readonly plaintext: string;
}

export type ResolvedDesktopAction =
  | (ResolvedDesktopActionBase & { readonly kind: "click" })
  | (ResolvedDesktopActionBase & { readonly kind: "input"; readonly valueRef: string })
  | (ResolvedDesktopActionBase & { readonly kind: "select"; readonly valueRef: string })
  | (ResolvedDesktopActionBase & {
      readonly kind: "scroll";
      readonly direction: "up" | "down" | "left" | "right";
      readonly amount: "page" | "small";
    })
  | (ResolvedDesktopActionBase & {
      readonly kind: "window";
      readonly windowOperation: "focus" | "minimize" | "restore" | "close";
    });

export interface ResolvedWebAction {
  readonly targetKind: "web";
  readonly kind: "click";
  readonly target: { readonly nodeId: string; readonly selector: string };
  readonly graphId: string;
}

export type ResolvedAction = ResolvedWebAction | ResolvedDesktopAction;

/**
 * The policy decision context that authorizes minting a Permit. Mirrors the
 * Runner Kernel `ExecutionPermitDescriptor` fields but is an IPC DTO only.
 */
export interface LocalPermitAuthorization {
  readonly decisionId: string;
  readonly policyId: string;
  readonly actionDigestSha256: string;
  readonly risk: LocalActionRisk;
  readonly expiresAt: string;
  /** Required on the IPC wire: one-use Runner nonce that the returned Permit must echo and bind. */
  readonly nonceBase64?: string;
  readonly valueBinding?: DesktopValueBinding;
}

export interface LocalPermitRequest {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly action: ResolvedDesktopAction;
  readonly authorization: LocalPermitAuthorization;
  readonly safeSummary: string;
  readonly expiresAt: string;
}

export type LocalApprovalStatus = "approved" | "denied" | "timed_out" | "emergency_stopped";

export type LocalApprovalDecision =
  | {
      readonly status: "approved";
      readonly approvalId: string;
      readonly decidedAt: string;
      readonly permit: LocalExecutionPermit;
    }
  | {
      readonly status: "denied" | "timed_out" | "emergency_stopped";
      readonly approvalId: string;
      readonly decidedAt: string;
    };

export interface LocalExecutionPermit {
  readonly permitToken: string;
  /** Echo of the one-use Runner nonce from LocalPermitAuthorization. */
  readonly nonceBase64: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionDigestSha256: string;
  readonly graphId: string;
  /** Required on the IPC wire; optional here only for structural in-memory fakes. */
  readonly decisionId?: string;
  /** Required on the IPC wire; optional here only for structural in-memory fakes. */
  readonly policyId?: string;
  readonly risk: LocalActionRisk;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly valueBinding?: DesktopValueBinding;
}

export interface CompanionUiaSourceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CompanionUiaSourceNode {
  readonly nodeId: string;
  readonly role: string;
  readonly controlTypeId: number;
  readonly name?: string;
  readonly value?: string;
  readonly automationId?: string;
  readonly frameworkId?: string;
  readonly className?: string;
  readonly nativeWindowHandle?: string;
  readonly processId: number;
  readonly isOffscreen: boolean;
  readonly isKeyboardFocusable: boolean;
  readonly hasKeyboardFocus: boolean;
  readonly isPassword: boolean;
  readonly bounds?: CompanionUiaSourceBounds;
  readonly patterns: readonly UiaPatternDescriptor[];
  readonly children: readonly string[];
}

export interface CompanionUiaSource {
  readonly sessionId: string;
  readonly capturedAt: string;
  readonly rootNodeIds: readonly string[];
  readonly nodes: readonly CompanionUiaSourceNode[];
}

export type LocalActionOutcomeReport =
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly errorCode: string };

export interface CompanionRequestPayloadByType {
  readonly "handshake.begin": { readonly runnerId: string; readonly certificatePem: string };
  readonly "handshake.prove": {
    readonly challengeId: string;
    readonly companionInstanceId: string;
    readonly nonceBase64: string;
    readonly signatureBase64: string;
    readonly signatureAlgorithm: CompanionProofSignatureAlgorithm;
  };
  readonly "session.show": { readonly runId: string; readonly targetName: string };
  readonly "session.pause": { readonly runId: string };
  readonly "session.resume": { readonly runId: string };
  readonly "session.stop": { readonly runId: string };
  readonly "session.close": { readonly runId: string };
  readonly "app.launch": { readonly target: AppTarget };
  readonly "app.reset": { readonly sessionId: string };
  readonly "app.shutdown": { readonly sessionId: string };
  readonly "uia.capture": { readonly sessionId: string; readonly deadlineMs: number };
  readonly "permit.request": { readonly request: LocalPermitRequest };
  readonly "action.execute": {
    readonly sessionId: string;
    readonly action: ResolvedDesktopAction;
    readonly permit: LocalExecutionPermit;
    readonly deadlineMs: number;
    /** Present only for Desktop input/select dispatch and never valid in Trace or durable DTOs. */
    readonly value?: DesktopPlaintextValue;
  };
}

export type CompanionRequestType = keyof CompanionRequestPayloadByType;

export type CompanionRequestEnvelope<T extends CompanionRequestType = CompanionRequestType> = {
  readonly [K in T]: {
    readonly protocolMajor: typeof PROTOCOL_MAJOR;
    readonly requestId: string;
    readonly type: K;
    readonly payload: CompanionRequestPayloadByType[K];
  }
}[T];

export type CompanionRequest = CompanionRequestEnvelope;

export interface CompanionHandshakeChallenge {
  readonly challengeId: string;
  readonly companionInstanceId: string;
  readonly nonceBase64: string;
}

export interface CompanionHandshakeAccepted {
  readonly companionInstanceId: string;
  readonly runnerId: string;
  readonly certificateSha256Fingerprint?: string;
  readonly acceptedAt: string;
}

export type CompanionSessionResponsePayload = {
  readonly runId: string;
  readonly state: "shown" | "paused" | "resumed" | "stopped" | "closed";
  readonly changedAt: string;
};

export type CompanionAppLifecyclePayload =
  | AppSession
  | { readonly sessionId: string; readonly completedAt: string };

export interface CompanionResponsePayloadByType {
  readonly "handshake.challenge": CompanionHandshakeChallenge;
  readonly "handshake.accepted": CompanionHandshakeAccepted;
  readonly "session.show": CompanionSessionResponsePayload;
  readonly "session.pause": CompanionSessionResponsePayload;
  readonly "session.resume": CompanionSessionResponsePayload;
  readonly "session.stop": CompanionSessionResponsePayload;
  readonly "session.close": CompanionSessionResponsePayload;
  readonly "app.launch": AppSession;
  readonly "app.reset": { readonly sessionId: string; readonly completedAt: string };
  readonly "app.shutdown": { readonly sessionId: string; readonly completedAt: string };
  readonly "uia.capture": CompanionUiaSource;
  readonly "permit.request": LocalApprovalDecision;
  readonly "action.execute": LocalActionOutcomeReport;
}

export type CompanionResponseType = keyof CompanionResponsePayloadByType;

export type ExpectedCompanionResponseType<T extends CompanionRequestType> = T extends "handshake.begin"
  ? "handshake.challenge"
  : T extends "handshake.prove"
    ? "handshake.accepted"
    : Extract<T, CompanionResponseType>;

export type CompanionOkResponse<T extends CompanionResponseType = CompanionResponseType> = {
  readonly [K in T]: {
    readonly protocolMajor: typeof PROTOCOL_MAJOR;
    readonly requestId: string;
    readonly type: K;
    readonly status: "ok";
    readonly payload: CompanionResponsePayloadByType[K];
  }
}[T];

export type CompanionStableErrorCode =
  | "CompanionUnavailable"
  | "CompanionIdentityRejected"
  | "CompanionUnauthenticated"
  | "CompanionProtocolViolation"
  | "CompanionBackpressure"
  | "CompanionRequestTimeout"
  | "CompanionCorrelationError"
  | "CompanionMessageTooLarge"
  | "PolicyDenied"
  | "CapabilityMismatch"
  | "UnsupportedRequest"
  | "ApplicationError"
  | "ActionOutcomeUnknown";

export interface CompanionStableError {
  readonly code: CompanionStableErrorCode;
  readonly safeMessage: string;
}

export type CompanionErrorResponse<T extends CompanionResponseType = CompanionResponseType> = {
  readonly [K in T]: {
    readonly protocolMajor: typeof PROTOCOL_MAJOR;
    readonly requestId: string;
    readonly type: K;
    readonly status: "error";
    readonly error: CompanionStableError;
  }
}[T];

export type CompanionResponse<T extends CompanionResponseType = CompanionResponseType> =
  | CompanionOkResponse<T>
  | CompanionErrorResponse<T>;

export const COMPANION_REQUEST_TYPES: readonly CompanionRequestType[] = [
  "handshake.begin",
  "handshake.prove",
  "session.show",
  "session.pause",
  "session.resume",
  "session.stop",
  "session.close",
  "app.launch",
  "app.reset",
  "app.shutdown",
  "uia.capture",
  "permit.request",
  "action.execute",
];

export const COMPANION_RESPONSE_TYPES: readonly CompanionResponseType[] = [
  "handshake.challenge",
  "handshake.accepted",
  "session.show",
  "session.pause",
  "session.resume",
  "session.stop",
  "session.close",
  "app.launch",
  "app.reset",
  "app.shutdown",
  "uia.capture",
  "permit.request",
  "action.execute",
];

/** Fixed protocol bounds; anything beyond these fails closed before dispatch. */
export const COMPANION_IPC_LIMITS = {
  /** Maximum single declared frame (32-bit length-prefixed) in bytes. */
  maxFrameBytes: 1 << 20,
  maxBufferedBytes: 1 << 20,
  maxInFlightRequests: 32,
  maxRequestIdLength: 128,
  maxRunnerIdLength: 200,
  maxCertificatePemLength: 16_384,
  maxSignatureBase64Length: 2048,
  maxSignatureAlgorithmLength: 32,
  maxChallengeIdLength: 128,
  maxCompanionInstanceIdLength: 200,
  maxIdLength: 200,
  maxTargetNameLength: 512,
  maxSafeSummaryLength: 1024,
  maxDigestLength: 64,
  maxPlaintextValueBytes: 64 * 1024,
  maxTokenLength: 512,
  maxNonceLength: 512,
  maxErrorMessageLength: 512,
  minDeadlineMs: 1,
  maxDeadlineMs: 600_000,
} as const;

export const PROTOCOL_MAJOR = 1 as const;

export const COMPANION_PROOF_CONTEXT = "qualigence-companion-proof/v1";

/** Fixed native UIA password mask token; password values must never cross IPC in plaintext. */
export const COMPANION_UIA_PASSWORD_MASK_VALUE = "\u2022\u2022\u2022\u2022";

export type CompanionProofSignatureAlgorithm = "ecdsa-p256-sha256" | "rsa-pss-sha256";

export type CompanionIpcErrorCode =
  | "CompanionMessageTooLarge"
  | "InvalidRequestShape"
  | "UnknownRequestType"
  | "InvalidResponseShape"
  | "UnknownResponseType"
  | "InvalidHandshake"
  | "InvalidCertificateProof"
  | "MissingDeadline"
  | "InvalidDeadline"
  | "InvalidAction"
  | "LocalPermitInvalid"
  | "LocalAuthorizationInvalid"
  | "InvalidApprovalDecision"
  | "InvalidActionOutcome"
  | "InvalidCorrelation";

export class CompanionIpcError extends Error {
  readonly code: CompanionIpcErrorCode;

  constructor(code: CompanionIpcErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CompanionIpcError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, code: CompanionIpcErrorCode, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CompanionIpcError(code, `${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new CompanionIpcError(code, `${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function optionalStr(value: unknown, code: CompanionIpcErrorCode, field: string, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return str(value, code, field, maxLength);
}

function bool(value: unknown, code: CompanionIpcErrorCode, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new CompanionIpcError(code, `${field} must be a boolean`);
  }
  return value;
}

function int(value: unknown, code: CompanionIpcErrorCode, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new CompanionIpcError(code, `${field} must be an integer`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], code: CompanionIpcErrorCode, label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new CompanionIpcError(code, `${label}.${key} is not a known field`);
    }
  }
}

function requireRecord(value: unknown, code: CompanionIpcErrorCode, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CompanionIpcError(code, `${field} must be an object`);
  }
  return value;
}

function requireStringArray(value: unknown, code: CompanionIpcErrorCode, field: string, maxEntries = 1000): readonly string[] {
  if (!Array.isArray(value)) {
    throw new CompanionIpcError(code, `${field} must be an array`);
  }
  if (value.length > maxEntries) {
    throw new CompanionIpcError(code, `${field} exceeds ${maxEntries} entries`);
  }
  return Object.freeze(value.map((entry, index) => str(entry, code, `${field}[${index}]`, COMPANION_IPC_LIMITS.maxIdLength)));
}

const RISKS: readonly LocalActionRisk[] = ["Normal", "ExternalSideEffect", "Destructive", "ProductionForbidden"];
const RESOLUTIONS: readonly DesktopActionResolution[] = ["semantic", "uia", "visual", "coordinate"];
const UIA_PATTERNS: readonly UiaPattern[] = [
  "Invoke",
  "Value",
  "Selection",
  "SelectionItem",
  "Scroll",
  "ExpandCollapse",
  "Toggle",
  "Window",
];
const PROOF_ALGORITHMS: readonly CompanionProofSignatureAlgorithm[] = ["ecdsa-p256-sha256", "rsa-pss-sha256"];
const STABLE_ERROR_CODES: readonly CompanionStableErrorCode[] = [
  "CompanionUnavailable",
  "CompanionIdentityRejected",
  "CompanionUnauthenticated",
  "CompanionProtocolViolation",
  "CompanionBackpressure",
  "CompanionRequestTimeout",
  "CompanionCorrelationError",
  "CompanionMessageTooLarge",
  "PolicyDenied",
  "CapabilityMismatch",
  "UnsupportedRequest",
  "ApplicationError",
  "ActionOutcomeUnknown",
];

function requireRisk(value: unknown, code: CompanionIpcErrorCode, field: string): LocalActionRisk {
  if (typeof value !== "string" || !RISKS.includes(value as LocalActionRisk)) {
    throw new CompanionIpcError(code, `${field} must be one of ${RISKS.join(", ")}`);
  }
  return value as LocalActionRisk;
}

function requireDeadline(value: unknown): number {
  if (value === undefined) {
    throw new CompanionIpcError("MissingDeadline", "deadlineMs is required");
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new CompanionIpcError("InvalidDeadline", "deadlineMs must be an integer");
  }
  if (value < COMPANION_IPC_LIMITS.minDeadlineMs || value > COMPANION_IPC_LIMITS.maxDeadlineMs) {
    throw new CompanionIpcError(
      "InvalidDeadline",
      `deadlineMs must be between ${COMPANION_IPC_LIMITS.minDeadlineMs} and ${COMPANION_IPC_LIMITS.maxDeadlineMs}`,
    );
  }
  return value;
}

/** Reject an oversized or empty declared frame length before ever allocating for it. */
export function assertDeclaredFrameLength(declaredLength: number): void {
  if (!Number.isInteger(declaredLength) || declaredLength <= 0) {
    throw new CompanionIpcError("InvalidRequestShape", "declared frame length must be a positive integer");
  }
  if (declaredLength > COMPANION_IPC_LIMITS.maxFrameBytes) {
    throw new CompanionIpcError(
      "CompanionMessageTooLarge",
      `declared frame length ${declaredLength} exceeds ${COMPANION_IPC_LIMITS.maxFrameBytes} bytes`,
    );
  }
}

/** Strictly validate a {@link ResolvedDesktopAction} IPC DTO. */
export function parseResolvedDesktopAction(value: unknown): ResolvedDesktopAction {
  const raw = requireRecord(value, "InvalidAction", "action");
  if (raw.targetKind !== "desktop") {
    throw new CompanionIpcError("InvalidAction", "action.targetKind must be \"desktop\"");
  }
  const actionId = str(raw.actionId, "InvalidAction", "action.actionId", COMPANION_IPC_LIMITS.maxIdLength);
  const graphId = str(raw.graphId, "InvalidAction", "action.graphId", COMPANION_IPC_LIMITS.maxIdLength);
  const nodeId = str(raw.nodeId, "InvalidAction", "action.nodeId", COMPANION_IPC_LIMITS.maxIdLength);
  if (typeof raw.resolution !== "string" || !RESOLUTIONS.includes(raw.resolution as DesktopActionResolution)) {
    throw new CompanionIpcError("InvalidAction", `action.resolution must be one of ${RESOLUTIONS.join(", ")}`);
  }
  const resolution = raw.resolution as DesktopActionResolution;
  if (raw.uiaPattern !== undefined && (typeof raw.uiaPattern !== "string" || !UIA_PATTERNS.includes(raw.uiaPattern as UiaPattern))) {
    throw new CompanionIpcError("InvalidAction", "action.uiaPattern is invalid");
  }
  const base: ResolvedDesktopActionBase = {
    targetKind: "desktop",
    actionId,
    graphId,
    nodeId,
    resolution,
    ...(raw.uiaPattern === undefined ? {} : { uiaPattern: raw.uiaPattern as UiaPattern }),
  };

  switch (raw.kind) {
    case "click":
      exactKeys(raw, ["targetKind", "kind", "actionId", "graphId", "nodeId", "resolution", "uiaPattern"], "InvalidAction", "action");
      return { ...base, kind: "click" };
    case "input":
      exactKeys(raw, ["targetKind", "kind", "actionId", "graphId", "nodeId", "resolution", "uiaPattern", "valueRef"], "InvalidAction", "action");
      return { ...base, kind: "input", valueRef: str(raw.valueRef, "InvalidAction", "action.valueRef", COMPANION_IPC_LIMITS.maxIdLength) };
    case "select":
      exactKeys(raw, ["targetKind", "kind", "actionId", "graphId", "nodeId", "resolution", "uiaPattern", "valueRef"], "InvalidAction", "action");
      return { ...base, kind: "select", valueRef: str(raw.valueRef, "InvalidAction", "action.valueRef", COMPANION_IPC_LIMITS.maxIdLength) };
    case "scroll": {
      exactKeys(raw, ["targetKind", "kind", "actionId", "graphId", "nodeId", "resolution", "uiaPattern", "direction", "amount"], "InvalidAction", "action");
      const direction = raw.direction;
      const amount = raw.amount;
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
        throw new CompanionIpcError("InvalidAction", "action.direction is invalid");
      }
      if (amount !== "page" && amount !== "small") {
        throw new CompanionIpcError("InvalidAction", "action.amount is invalid");
      }
      return { ...base, kind: "scroll", direction, amount };
    }
    case "window": {
      exactKeys(raw, ["targetKind", "kind", "actionId", "graphId", "nodeId", "resolution", "uiaPattern", "windowOperation"], "InvalidAction", "action");
      const op = raw.windowOperation;
      if (op !== "focus" && op !== "minimize" && op !== "restore" && op !== "close") {
        throw new CompanionIpcError("InvalidAction", "action.windowOperation is invalid");
      }
      return { ...base, kind: "window", windowOperation: op };
    }
    default:
      throw new CompanionIpcError("InvalidAction", "action.kind is invalid");
  }
}

export function parseDesktopValueBinding(
  value: unknown,
  code: CompanionIpcErrorCode = "LocalAuthorizationInvalid",
): DesktopValueBinding {
  const raw = requireRecord(value, code, "valueBinding");
  exactKeys(raw, ["valueRef", "valueSha256", "valueByteLength"], code, "valueBinding");
  const valueByteLength = int(raw.valueByteLength, code, "valueBinding.valueByteLength");
  if (valueByteLength < 0 || valueByteLength > COMPANION_IPC_LIMITS.maxPlaintextValueBytes) {
    throw new CompanionIpcError(
      code,
      `valueBinding.valueByteLength must be between 0 and ${COMPANION_IPC_LIMITS.maxPlaintextValueBytes}`,
    );
  }
  return {
    valueRef: str(raw.valueRef, code, "valueBinding.valueRef", COMPANION_IPC_LIMITS.maxIdLength),
    valueSha256: str(raw.valueSha256, code, "valueBinding.valueSha256", COMPANION_IPC_LIMITS.maxDigestLength),
    valueByteLength,
  };
}

export function desktopValueBindingForPlaintext(valueRef: string, plaintext: string): DesktopPlaintextValue {
  const bytes = new TextEncoder().encode(plaintext);
  if (bytes.byteLength > COMPANION_IPC_LIMITS.maxPlaintextValueBytes) {
    throw new CompanionIpcError("InvalidAction", `plaintext value exceeds ${COMPANION_IPC_LIMITS.maxPlaintextValueBytes} bytes`);
  }
  return Object.freeze({
    valueRef: str(valueRef, "InvalidAction", "value.valueRef", COMPANION_IPC_LIMITS.maxIdLength),
    valueSha256: createHash("sha256").update(bytes).digest("hex"),
    valueByteLength: bytes.byteLength,
    plaintext,
  });
}

export function parseDesktopPlaintextValue(value: unknown): DesktopPlaintextValue {
  const raw = requireRecord(value, "InvalidAction", "value");
  exactKeys(raw, ["valueRef", "valueSha256", "valueByteLength", "plaintext"], "InvalidAction", "value");
  const plaintext = str(raw.plaintext, "InvalidAction", "value.plaintext", COMPANION_IPC_LIMITS.maxPlaintextValueBytes);
  const parsed = parseDesktopValueBinding({
    valueRef: raw.valueRef,
    valueSha256: raw.valueSha256,
    valueByteLength: raw.valueByteLength,
  }, "InvalidAction");
  const expected = desktopValueBindingForPlaintext(parsed.valueRef, plaintext);
  if (parsed.valueSha256 !== expected.valueSha256 || parsed.valueByteLength !== expected.valueByteLength) {
    throw new CompanionIpcError("InvalidAction", "value plaintext does not match valueSha256/valueByteLength");
  }
  return Object.freeze({ ...parsed, plaintext });
}

function valueRefForAction(action: ResolvedDesktopAction): string | undefined {
  return action.kind === "input" || action.kind === "select" ? action.valueRef : undefined;
}

export function assertDesktopValueBindingMatchesAction(
  action: ResolvedDesktopAction,
  binding: DesktopValueBinding | undefined,
  code: CompanionIpcErrorCode = "LocalAuthorizationInvalid",
): void {
  const valueRef = valueRefForAction(action);
  if (valueRef === undefined) {
    if (binding !== undefined) throw new CompanionIpcError(code, "non-value Desktop actions must not include a value binding");
    return;
  }
  if (binding === undefined) throw new CompanionIpcError(code, "Desktop input/select actions require a value binding");
  if (binding.valueRef !== valueRef) throw new CompanionIpcError(code, "valueBinding.valueRef must match action.valueRef");
}

export interface DesktopActionDigestInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly action: ResolvedDesktopAction;
  readonly decisionId: string;
  readonly policyId: string;
  readonly risk: LocalActionRisk;
  readonly expiresAt: string;
  readonly nonceBase64: string;
  readonly valueBinding?: DesktopValueBinding;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function desktopActionDigestSha256(input: DesktopActionDigestInput): string {
  assertDesktopValueBindingMatchesAction(input.action, input.valueBinding);
  return createHash("sha256")
    .update(canonicalize({
      schema: "qualigence-desktop-action-digest/v1",
      sessionId: input.sessionId,
      runId: input.runId,
      action: input.action,
      decisionId: input.decisionId,
      policyId: input.policyId,
      risk: input.risk,
      expiresAt: input.expiresAt,
      nonceBase64: input.nonceBase64,
      valueBinding: input.valueBinding,
    }))
    .digest("hex");
}

export function parseLocalPermitAuthorization(value: unknown): LocalPermitAuthorization & { readonly nonceBase64: string } {
  const raw = requireRecord(value, "LocalAuthorizationInvalid", "authorization");
  exactKeys(
    raw,
    ["decisionId", "policyId", "actionDigestSha256", "risk", "expiresAt", "nonceBase64", "valueBinding"],
    "LocalAuthorizationInvalid",
    "authorization",
  );
  const valueBinding = raw.valueBinding === undefined ? undefined : parseDesktopValueBinding(raw.valueBinding, "LocalAuthorizationInvalid");
  return {
    decisionId: str(raw.decisionId, "LocalAuthorizationInvalid", "authorization.decisionId", COMPANION_IPC_LIMITS.maxIdLength),
    policyId: str(raw.policyId, "LocalAuthorizationInvalid", "authorization.policyId", COMPANION_IPC_LIMITS.maxIdLength),
    actionDigestSha256: str(raw.actionDigestSha256, "LocalAuthorizationInvalid", "authorization.actionDigestSha256", COMPANION_IPC_LIMITS.maxDigestLength),
    risk: requireRisk(raw.risk, "LocalAuthorizationInvalid", "authorization.risk"),
    expiresAt: str(raw.expiresAt, "LocalAuthorizationInvalid", "authorization.expiresAt", 64),
    nonceBase64: str(raw.nonceBase64, "LocalAuthorizationInvalid", "authorization.nonceBase64", COMPANION_IPC_LIMITS.maxNonceLength),
    ...(valueBinding === undefined ? {} : { valueBinding }),
  };
}

export function parseLocalExecutionPermit(value: unknown): LocalExecutionPermit {
  const raw = requireRecord(value, "LocalPermitInvalid", "permit");
  exactKeys(
    raw,
    ["permitToken", "nonceBase64", "sessionId", "runId", "actionId", "actionDigestSha256", "graphId", "decisionId", "policyId", "risk", "issuedAt", "expiresAt", "valueBinding"],
    "LocalPermitInvalid",
    "permit",
  );
  const valueBinding = raw.valueBinding === undefined ? undefined : parseDesktopValueBinding(raw.valueBinding, "LocalPermitInvalid");
  return {
    permitToken: str(raw.permitToken, "LocalPermitInvalid", "permit.permitToken", COMPANION_IPC_LIMITS.maxTokenLength),
    nonceBase64: str(raw.nonceBase64, "LocalPermitInvalid", "permit.nonceBase64", COMPANION_IPC_LIMITS.maxNonceLength),
    sessionId: str(raw.sessionId, "LocalPermitInvalid", "permit.sessionId", COMPANION_IPC_LIMITS.maxIdLength),
    runId: str(raw.runId, "LocalPermitInvalid", "permit.runId", COMPANION_IPC_LIMITS.maxIdLength),
    actionId: str(raw.actionId, "LocalPermitInvalid", "permit.actionId", COMPANION_IPC_LIMITS.maxIdLength),
    actionDigestSha256: str(raw.actionDigestSha256, "LocalPermitInvalid", "permit.actionDigestSha256", COMPANION_IPC_LIMITS.maxDigestLength),
    graphId: str(raw.graphId, "LocalPermitInvalid", "permit.graphId", COMPANION_IPC_LIMITS.maxIdLength),
    decisionId: str(raw.decisionId, "LocalPermitInvalid", "permit.decisionId", COMPANION_IPC_LIMITS.maxIdLength),
    policyId: str(raw.policyId, "LocalPermitInvalid", "permit.policyId", COMPANION_IPC_LIMITS.maxIdLength),
    risk: requireRisk(raw.risk, "LocalPermitInvalid", "permit.risk"),
    issuedAt: str(raw.issuedAt, "LocalPermitInvalid", "permit.issuedAt", 64),
    expiresAt: str(raw.expiresAt, "LocalPermitInvalid", "permit.expiresAt", 64),
    ...(valueBinding === undefined ? {} : { valueBinding }),
  };
}

export function parseLocalPermitRequest(value: unknown): LocalPermitRequest {
  const raw = requireRecord(value, "LocalPermitInvalid", "permit request");
  exactKeys(raw, ["approvalId", "sessionId", "runId", "action", "authorization", "safeSummary", "expiresAt"], "LocalPermitInvalid", "request");
  const action = parseResolvedDesktopAction(raw.action);
  const authorization = parseLocalPermitAuthorization(raw.authorization);
  assertDesktopValueBindingMatchesAction(action, authorization.valueBinding, "LocalPermitInvalid");
  const sessionId = str(raw.sessionId, "LocalPermitInvalid", "request.sessionId", COMPANION_IPC_LIMITS.maxIdLength);
  const runId = str(raw.runId, "LocalPermitInvalid", "request.runId", COMPANION_IPC_LIMITS.maxIdLength);
  const expectedDigest = desktopActionDigestSha256({
    sessionId,
    runId,
    action,
    decisionId: authorization.decisionId,
    policyId: authorization.policyId,
    risk: authorization.risk,
    expiresAt: authorization.expiresAt,
    nonceBase64: authorization.nonceBase64,
    ...(authorization.valueBinding === undefined ? {} : { valueBinding: authorization.valueBinding }),
  });
  if (authorization.actionDigestSha256 !== expectedDigest) {
    throw new CompanionIpcError("LocalPermitInvalid", "authorization.actionDigestSha256 does not match the Desktop action binding");
  }
  const requestExpiresAt = str(raw.expiresAt, "LocalPermitInvalid", "request.expiresAt", 64);
  if (requestExpiresAt !== authorization.expiresAt) {
    throw new CompanionIpcError("LocalPermitInvalid", "request.expiresAt must match authorization.expiresAt");
  }
  return {
    approvalId: str(raw.approvalId, "LocalPermitInvalid", "request.approvalId", COMPANION_IPC_LIMITS.maxIdLength),
    sessionId,
    runId,
    action,
    authorization,
    safeSummary: str(raw.safeSummary, "LocalPermitInvalid", "request.safeSummary", COMPANION_IPC_LIMITS.maxSafeSummaryLength),
    expiresAt: requestExpiresAt,
  };
}

/** Strictly validate an approval-decision DTO returned by the Companion. */
export function parseCompanionDecision(value: unknown): LocalApprovalDecision {
  const raw = requireRecord(value, "InvalidApprovalDecision", "decision");
  const approvalId = str(raw.approvalId, "InvalidApprovalDecision", "decision.approvalId", COMPANION_IPC_LIMITS.maxIdLength);
  const decidedAt = str(raw.decidedAt, "InvalidApprovalDecision", "decision.decidedAt", 64);
  switch (raw.status) {
    case "approved":
      exactKeys(raw, ["status", "approvalId", "decidedAt", "permit"], "InvalidApprovalDecision", "decision");
      return { status: "approved", approvalId, decidedAt, permit: parseLocalExecutionPermit(raw.permit) };
    case "denied":
    case "timed_out":
    case "emergency_stopped":
      exactKeys(raw, ["status", "approvalId", "decidedAt"], "InvalidApprovalDecision", "decision");
      return { status: raw.status, approvalId, decidedAt };
    default:
      throw new CompanionIpcError("InvalidApprovalDecision", "decision.status is invalid");
  }
}

export function assertActionExecutePermitBinding(
  payloadSessionId: string,
  action: ResolvedDesktopAction,
  permit: LocalExecutionPermit,
): void {
  assertDesktopValueBindingMatchesAction(action, permit.valueBinding, "LocalPermitInvalid");
  if (permit.sessionId !== payloadSessionId) {
    throw new CompanionIpcError("LocalPermitInvalid", "permit.sessionId must match action.execute sessionId");
  }
  if (permit.actionId !== action.actionId) {
    throw new CompanionIpcError("LocalPermitInvalid", "permit.actionId must match action.actionId");
  }
  if (permit.graphId !== action.graphId) {
    throw new CompanionIpcError("LocalPermitInvalid", "permit.graphId must match action.graphId");
  }
  if (permit.decisionId === undefined || permit.policyId === undefined) {
    throw new CompanionIpcError("LocalPermitInvalid", "permit must include decisionId and policyId");
  }
  const expectedDigest = desktopActionDigestSha256({
    sessionId: permit.sessionId,
    runId: permit.runId,
    action,
    decisionId: permit.decisionId,
    policyId: permit.policyId,
    risk: permit.risk,
    expiresAt: permit.expiresAt,
    nonceBase64: permit.nonceBase64,
    ...(permit.valueBinding === undefined ? {} : { valueBinding: permit.valueBinding }),
  });
  if (permit.actionDigestSha256 !== expectedDigest) {
    throw new CompanionIpcError("LocalPermitInvalid", "permit.actionDigestSha256 does not match the Desktop action binding");
  }
}

export function assertActionExecuteValueBinding(
  action: ResolvedDesktopAction,
  permit: LocalExecutionPermit,
  value: DesktopPlaintextValue | undefined,
): void {
  const valueRef = valueRefForAction(action);
  if (valueRef === undefined) {
    if (value !== undefined) {
      throw new CompanionIpcError("InvalidAction", "plaintext value is only allowed for input/select dispatch");
    }
    return;
  }
  if (value === undefined) throw new CompanionIpcError("InvalidAction", "Desktop input/select dispatch requires plaintext value");
  if (permit.valueBinding === undefined) throw new CompanionIpcError("LocalPermitInvalid", "permit requires value binding for input/select dispatch");
  if (
    value.valueRef !== valueRef ||
    value.valueRef !== permit.valueBinding.valueRef ||
    value.valueSha256 !== permit.valueBinding.valueSha256 ||
    value.valueByteLength !== permit.valueBinding.valueByteLength
  ) {
    throw new CompanionIpcError("InvalidAction", "dispatch value does not match the permit value binding");
  }
}

export function parseLocalActionOutcomeReport(value: unknown): LocalActionOutcomeReport {
  const raw = requireRecord(value, "InvalidActionOutcome", "action outcome");
  switch (raw.status) {
    case "ok":
      exactKeys(raw, ["status"], "InvalidActionOutcome", "action outcome");
      return { status: "ok" };
    case "failed":
      exactKeys(raw, ["status", "errorCode"], "InvalidActionOutcome", "action outcome");
      return { status: "failed", errorCode: str(raw.errorCode, "InvalidActionOutcome", "action outcome.errorCode", COMPANION_IPC_LIMITS.maxIdLength) };
    default:
      throw new CompanionIpcError("InvalidActionOutcome", "action outcome.status is invalid");
  }
}

function parsePatternDescriptor(value: unknown): UiaPatternDescriptor {
  const raw = requireRecord(value, "InvalidResponseShape", "patterns[]");
  exactKeys(raw, ["pattern", "available", "readOnly"], "InvalidResponseShape", "pattern");
  if (typeof raw.pattern !== "string" || !UIA_PATTERNS.includes(raw.pattern as UiaPattern)) {
    throw new CompanionIpcError("InvalidResponseShape", "pattern.pattern is invalid");
  }
  const readOnly = raw.readOnly === undefined ? undefined : bool(raw.readOnly, "InvalidResponseShape", "pattern.readOnly");
  return Object.freeze({
    pattern: raw.pattern as UiaPattern,
    available: bool(raw.available, "InvalidResponseShape", "pattern.available"),
    ...(readOnly === undefined ? {} : { readOnly }),
  });
}

function parseUiaBounds(value: unknown): CompanionUiaSourceBounds {
  const raw = requireRecord(value, "InvalidResponseShape", "bounds");
  exactKeys(raw, ["x", "y", "width", "height"], "InvalidResponseShape", "bounds");
  return Object.freeze({
    x: int(raw.x, "InvalidResponseShape", "bounds.x"),
    y: int(raw.y, "InvalidResponseShape", "bounds.y"),
    width: int(raw.width, "InvalidResponseShape", "bounds.width"),
    height: int(raw.height, "InvalidResponseShape", "bounds.height"),
  });
}

function parseUiaNode(value: unknown): CompanionUiaSourceNode {
  const raw = requireRecord(value, "InvalidResponseShape", "nodes[]");
  exactKeys(raw, ["nodeId", "role", "controlTypeId", "name", "value", "automationId", "frameworkId", "className", "nativeWindowHandle", "processId", "isOffscreen", "isKeyboardFocusable", "hasKeyboardFocus", "isPassword", "bounds", "patterns", "children"], "InvalidResponseShape", "node");
  if (!Array.isArray(raw.patterns)) {
    throw new CompanionIpcError("InvalidResponseShape", "node.patterns must be an array");
  }
  const isPassword = bool(raw.isPassword, "InvalidResponseShape", "node.isPassword");
  const nodeValue = raw.value === undefined ? undefined : str(raw.value, "InvalidResponseShape", "node.value", COMPANION_IPC_LIMITS.maxSafeSummaryLength);
  if (isPassword && nodeValue !== COMPANION_UIA_PASSWORD_MASK_VALUE) {
    throw new CompanionIpcError("InvalidResponseShape", "node.value for password controls must be the fixed UIA password mask token");
  }
  return Object.freeze({
    nodeId: str(raw.nodeId, "InvalidResponseShape", "node.nodeId", COMPANION_IPC_LIMITS.maxIdLength),
    role: str(raw.role, "InvalidResponseShape", "node.role", COMPANION_IPC_LIMITS.maxIdLength),
    controlTypeId: int(raw.controlTypeId, "InvalidResponseShape", "node.controlTypeId"),
    ...(raw.name === undefined ? {} : { name: str(raw.name, "InvalidResponseShape", "node.name", COMPANION_IPC_LIMITS.maxSafeSummaryLength) }),
    ...(nodeValue === undefined ? {} : { value: nodeValue }),
    ...(raw.automationId === undefined ? {} : { automationId: str(raw.automationId, "InvalidResponseShape", "node.automationId", COMPANION_IPC_LIMITS.maxIdLength) }),
    ...(raw.frameworkId === undefined ? {} : { frameworkId: str(raw.frameworkId, "InvalidResponseShape", "node.frameworkId", COMPANION_IPC_LIMITS.maxIdLength) }),
    ...(raw.className === undefined ? {} : { className: str(raw.className, "InvalidResponseShape", "node.className", COMPANION_IPC_LIMITS.maxIdLength) }),
    ...(raw.nativeWindowHandle === undefined ? {} : { nativeWindowHandle: str(raw.nativeWindowHandle, "InvalidResponseShape", "node.nativeWindowHandle", COMPANION_IPC_LIMITS.maxIdLength) }),
    processId: int(raw.processId, "InvalidResponseShape", "node.processId"),
    isOffscreen: bool(raw.isOffscreen, "InvalidResponseShape", "node.isOffscreen"),
    isKeyboardFocusable: bool(raw.isKeyboardFocusable, "InvalidResponseShape", "node.isKeyboardFocusable"),
    hasKeyboardFocus: bool(raw.hasKeyboardFocus, "InvalidResponseShape", "node.hasKeyboardFocus"),
    isPassword,
    ...(raw.bounds === undefined ? {} : { bounds: parseUiaBounds(raw.bounds) }),
    patterns: Object.freeze(raw.patterns.map((entry) => parsePatternDescriptor(entry))),
    children: requireStringArray(raw.children, "InvalidResponseShape", "node.children"),
  });
}

export function parseCompanionUiaSource(value: unknown): CompanionUiaSource {
  const raw = requireRecord(value, "InvalidResponseShape", "uia capture");
  exactKeys(raw, ["sessionId", "capturedAt", "rootNodeIds", "nodes"], "InvalidResponseShape", "uia capture");
  if (!Array.isArray(raw.nodes)) {
    throw new CompanionIpcError("InvalidResponseShape", "nodes must be an array");
  }
  return Object.freeze({
    sessionId: str(raw.sessionId, "InvalidResponseShape", "uia.sessionId", COMPANION_IPC_LIMITS.maxIdLength),
    capturedAt: str(raw.capturedAt, "InvalidResponseShape", "uia.capturedAt", 64),
    rootNodeIds: requireStringArray(raw.rootNodeIds, "InvalidResponseShape", "uia.rootNodeIds"),
    nodes: Object.freeze(raw.nodes.map((entry) => parseUiaNode(entry))),
  });
}

function parseAppSession(value: unknown): AppSession {
  const raw = requireRecord(value, "InvalidResponseShape", "app session");
  exactKeys(raw, ["sessionId", "processId", "processCreationTime", "processGroupId", "rootWindowHandle", "startedAt"], "InvalidResponseShape", "app session");
  return Object.freeze({
    sessionId: str(raw.sessionId, "InvalidResponseShape", "session.sessionId", COMPANION_IPC_LIMITS.maxIdLength),
    processId: int(raw.processId, "InvalidResponseShape", "session.processId"),
    processCreationTime: str(raw.processCreationTime, "InvalidResponseShape", "session.processCreationTime", 64),
    processGroupId: str(raw.processGroupId, "InvalidResponseShape", "session.processGroupId", COMPANION_IPC_LIMITS.maxIdLength),
    rootWindowHandle: str(raw.rootWindowHandle, "InvalidResponseShape", "session.rootWindowHandle", COMPANION_IPC_LIMITS.maxIdLength),
    startedAt: str(raw.startedAt, "InvalidResponseShape", "session.startedAt", 64),
  });
}

function parseSessionPayload(value: unknown, expected: CompanionSessionResponsePayload["state"]): CompanionSessionResponsePayload {
  const raw = requireRecord(value, "InvalidResponseShape", "session response");
  exactKeys(raw, ["runId", "state", "changedAt"], "InvalidResponseShape", "session response");
  if (raw.state !== expected) {
    throw new CompanionIpcError("InvalidResponseShape", `session state must be ${expected}`);
  }
  return Object.freeze({
    runId: str(raw.runId, "InvalidResponseShape", "session.runId", COMPANION_IPC_LIMITS.maxIdLength),
    state: expected,
    changedAt: str(raw.changedAt, "InvalidResponseShape", "session.changedAt", 64),
  });
}

function parseLifecycleDonePayload(value: unknown): { readonly sessionId: string; readonly completedAt: string } {
  const raw = requireRecord(value, "InvalidResponseShape", "lifecycle response");
  exactKeys(raw, ["sessionId", "completedAt"], "InvalidResponseShape", "lifecycle response");
  return Object.freeze({
    sessionId: str(raw.sessionId, "InvalidResponseShape", "lifecycle.sessionId", COMPANION_IPC_LIMITS.maxIdLength),
    completedAt: str(raw.completedAt, "InvalidResponseShape", "lifecycle.completedAt", 64),
  });
}

function parseResponsePayload<T extends CompanionResponseType>(type: T, payload: unknown): CompanionResponsePayloadByType[T] {
  switch (type) {
    case "handshake.challenge": {
      const raw = requireRecord(payload, "InvalidHandshake", "handshake challenge");
      exactKeys(raw, ["challengeId", "companionInstanceId", "nonceBase64"], "InvalidHandshake", "handshake challenge");
      return Object.freeze({
        challengeId: str(raw.challengeId, "InvalidHandshake", "challengeId", COMPANION_IPC_LIMITS.maxChallengeIdLength),
        companionInstanceId: str(raw.companionInstanceId, "InvalidHandshake", "companionInstanceId", COMPANION_IPC_LIMITS.maxCompanionInstanceIdLength),
        nonceBase64: str(raw.nonceBase64, "InvalidHandshake", "nonceBase64", COMPANION_IPC_LIMITS.maxNonceLength),
      }) as CompanionResponsePayloadByType[T];
    }
    case "handshake.accepted": {
      const raw = requireRecord(payload, "InvalidHandshake", "handshake accepted");
      exactKeys(raw, ["companionInstanceId", "runnerId", "certificateSha256Fingerprint", "acceptedAt"], "InvalidHandshake", "handshake accepted");
      const fingerprint = optionalStr(raw.certificateSha256Fingerprint, "InvalidCertificateProof", "certificateSha256Fingerprint", COMPANION_IPC_LIMITS.maxDigestLength);
      return Object.freeze({
        companionInstanceId: str(raw.companionInstanceId, "InvalidHandshake", "companionInstanceId", COMPANION_IPC_LIMITS.maxCompanionInstanceIdLength),
        runnerId: str(raw.runnerId, "InvalidHandshake", "runnerId", COMPANION_IPC_LIMITS.maxRunnerIdLength),
        ...(fingerprint === undefined ? {} : { certificateSha256Fingerprint: fingerprint }),
        acceptedAt: str(raw.acceptedAt, "InvalidHandshake", "acceptedAt", 64),
      }) as CompanionResponsePayloadByType[T];
    }
    case "session.show":
      return parseSessionPayload(payload, "shown") as CompanionResponsePayloadByType[T];
    case "session.pause":
      return parseSessionPayload(payload, "paused") as CompanionResponsePayloadByType[T];
    case "session.resume":
      return parseSessionPayload(payload, "resumed") as CompanionResponsePayloadByType[T];
    case "session.stop":
      return parseSessionPayload(payload, "stopped") as CompanionResponsePayloadByType[T];
    case "session.close":
      return parseSessionPayload(payload, "closed") as CompanionResponsePayloadByType[T];
    case "app.launch":
      return parseAppSession(payload) as CompanionResponsePayloadByType[T];
    case "app.reset":
    case "app.shutdown":
      return parseLifecycleDonePayload(payload) as CompanionResponsePayloadByType[T];
    case "uia.capture":
      return parseCompanionUiaSource(payload) as CompanionResponsePayloadByType[T];
    case "permit.request":
      return parseCompanionDecision(payload) as CompanionResponsePayloadByType[T];
    case "action.execute":
      return parseLocalActionOutcomeReport(payload) as CompanionResponsePayloadByType[T];
    default:
      throw new CompanionIpcError("UnknownResponseType", `unhandled response type: ${String(type)}`);
  }
}

function parseRequestPayload<T extends CompanionRequestType>(type: T, payload: unknown): CompanionRequestPayloadByType[T] {
  const raw = requireRecord(payload, "InvalidRequestShape", "request payload");
  switch (type) {
    case "handshake.begin":
      exactKeys(raw, ["runnerId", "certificatePem"], "InvalidHandshake", "handshake.begin.payload");
      return {
        runnerId: str(raw.runnerId, "InvalidHandshake", "runnerId", COMPANION_IPC_LIMITS.maxRunnerIdLength),
        certificatePem: str(raw.certificatePem, "InvalidCertificateProof", "certificatePem", COMPANION_IPC_LIMITS.maxCertificatePemLength),
      } as CompanionRequestPayloadByType[T];
    case "handshake.prove": {
      exactKeys(raw, ["challengeId", "companionInstanceId", "nonceBase64", "signatureBase64", "signatureAlgorithm"], "InvalidCertificateProof", "handshake.prove.payload");
      if (typeof raw.signatureAlgorithm !== "string" || !PROOF_ALGORITHMS.includes(raw.signatureAlgorithm as CompanionProofSignatureAlgorithm)) {
        throw new CompanionIpcError("InvalidCertificateProof", "signatureAlgorithm is invalid");
      }
      return {
        challengeId: str(raw.challengeId, "InvalidCertificateProof", "challengeId", COMPANION_IPC_LIMITS.maxChallengeIdLength),
        companionInstanceId: str(raw.companionInstanceId, "InvalidCertificateProof", "companionInstanceId", COMPANION_IPC_LIMITS.maxCompanionInstanceIdLength),
        nonceBase64: str(raw.nonceBase64, "InvalidCertificateProof", "nonceBase64", COMPANION_IPC_LIMITS.maxNonceLength),
        signatureBase64: str(raw.signatureBase64, "InvalidCertificateProof", "signatureBase64", COMPANION_IPC_LIMITS.maxSignatureBase64Length),
        signatureAlgorithm: raw.signatureAlgorithm as CompanionProofSignatureAlgorithm,
      } as CompanionRequestPayloadByType[T];
    }
    case "session.show":
      exactKeys(raw, ["runId", "targetName"], "InvalidRequestShape", "session.show.payload");
      return {
        runId: str(raw.runId, "InvalidRequestShape", "runId", COMPANION_IPC_LIMITS.maxIdLength),
        targetName: str(raw.targetName, "InvalidRequestShape", "targetName", COMPANION_IPC_LIMITS.maxTargetNameLength),
      } as CompanionRequestPayloadByType[T];
    case "session.pause":
    case "session.resume":
    case "session.stop":
    case "session.close":
      exactKeys(raw, ["runId"], "InvalidRequestShape", `${type}.payload`);
      return { runId: str(raw.runId, "InvalidRequestShape", "runId", COMPANION_IPC_LIMITS.maxIdLength) } as CompanionRequestPayloadByType[T];
    case "app.launch":
      exactKeys(raw, ["target"], "InvalidRequestShape", "app.launch.payload");
      return { target: validateAppTarget(raw.target) } as CompanionRequestPayloadByType[T];
    case "app.reset":
    case "app.shutdown":
      exactKeys(raw, ["sessionId"], "InvalidRequestShape", `${type}.payload`);
      return { sessionId: str(raw.sessionId, "InvalidRequestShape", "sessionId", COMPANION_IPC_LIMITS.maxIdLength) } as CompanionRequestPayloadByType[T];
    case "uia.capture":
      exactKeys(raw, ["sessionId", "deadlineMs"], "InvalidRequestShape", "uia.capture.payload");
      return {
        sessionId: str(raw.sessionId, "InvalidRequestShape", "sessionId", COMPANION_IPC_LIMITS.maxIdLength),
        deadlineMs: requireDeadline(raw.deadlineMs),
      } as CompanionRequestPayloadByType[T];
    case "permit.request":
      exactKeys(raw, ["request"], "InvalidRequestShape", "permit.request.payload");
      return { request: parseLocalPermitRequest(raw.request) } as CompanionRequestPayloadByType[T];
    case "action.execute": {
      exactKeys(raw, ["sessionId", "action", "permit", "deadlineMs", "value"], "InvalidRequestShape", "action.execute.payload");
      const action = parseResolvedDesktopAction(raw.action);
      const permit = parseLocalExecutionPermit(raw.permit);
      const sessionId = str(raw.sessionId, "InvalidRequestShape", "sessionId", COMPANION_IPC_LIMITS.maxIdLength);
      assertActionExecutePermitBinding(sessionId, action, permit);
      const value = raw.value === undefined ? undefined : parseDesktopPlaintextValue(raw.value);
      assertActionExecuteValueBinding(action, permit, value);
      return {
        sessionId,
        action,
        permit,
        deadlineMs: requireDeadline(raw.deadlineMs),
        ...(value === undefined ? {} : { value }),
      } as CompanionRequestPayloadByType[T];
    }
    default:
      throw new CompanionIpcError("UnknownRequestType", `unhandled request type: ${String(type)}`);
  }
}

function parseRequestType(value: unknown): CompanionRequestType {
  if (typeof value !== "string" || !COMPANION_REQUEST_TYPES.includes(value as CompanionRequestType)) {
    throw new CompanionIpcError("UnknownRequestType", `unknown request type: ${String(value)}`);
  }
  return value as CompanionRequestType;
}

function parseResponseType(value: unknown): CompanionResponseType {
  if (typeof value !== "string" || !COMPANION_RESPONSE_TYPES.includes(value as CompanionResponseType)) {
    throw new CompanionIpcError("UnknownResponseType", `unknown response type: ${String(value)}`);
  }
  return value as CompanionResponseType;
}

export function expectedResponseTypeForRequest<T extends CompanionRequestType>(type: T): ExpectedCompanionResponseType<T> {
  switch (type) {
    case "handshake.begin":
      return "handshake.challenge" as ExpectedCompanionResponseType<T>;
    case "handshake.prove":
      return "handshake.accepted" as ExpectedCompanionResponseType<T>;
    default:
      return type as ExpectedCompanionResponseType<T>;
  }
}

export function createCompanionRequestEnvelope<T extends CompanionRequestType>(
  requestId: string,
  type: T,
  payload: CompanionRequestPayloadByType[T],
): CompanionRequestEnvelope<T> {
  return parseCompanionRequest({ protocolMajor: PROTOCOL_MAJOR, requestId, type, payload }) as CompanionRequestEnvelope<T>;
}

/** Strictly validate an untrusted Companion request envelope. */
export function parseCompanionRequest(value: unknown): CompanionRequestEnvelope {
  const raw = requireRecord(value, "InvalidRequestShape", "request");
  exactKeys(raw, ["protocolMajor", "requestId", "type", "payload"], "InvalidRequestShape", "request");
  if (raw.protocolMajor !== PROTOCOL_MAJOR) {
    throw new CompanionIpcError("InvalidHandshake", "protocolMajor must be 1");
  }
  const requestId = str(raw.requestId, "InvalidCorrelation", "requestId", COMPANION_IPC_LIMITS.maxRequestIdLength);
  const type = parseRequestType(raw.type);
  return Object.freeze({
    protocolMajor: PROTOCOL_MAJOR,
    requestId,
    type,
    payload: parseRequestPayload(type, raw.payload),
  }) as CompanionRequestEnvelope;
}

export function parseCompanionStableError(value: unknown): CompanionStableError {
  const raw = requireRecord(value, "InvalidResponseShape", "response.error");
  exactKeys(raw, ["code", "safeMessage"], "InvalidResponseShape", "response.error");
  if (typeof raw.code !== "string" || !STABLE_ERROR_CODES.includes(raw.code as CompanionStableErrorCode)) {
    throw new CompanionIpcError("InvalidResponseShape", "response.error.code is invalid");
  }
  return Object.freeze({
    code: raw.code as CompanionStableErrorCode,
    safeMessage: str(raw.safeMessage, "InvalidResponseShape", "response.error.safeMessage", COMPANION_IPC_LIMITS.maxErrorMessageLength),
  });
}

/** Strictly validate an untrusted Companion response envelope. */
export function parseCompanionResponse(value: unknown): CompanionResponse {
  const raw = requireRecord(value, "InvalidResponseShape", "response");
  exactKeys(raw, ["protocolMajor", "requestId", "type", "status", "payload", "error"], "InvalidResponseShape", "response");
  if (raw.protocolMajor !== PROTOCOL_MAJOR) {
    throw new CompanionIpcError("InvalidHandshake", "response.protocolMajor must be 1");
  }
  const requestId = str(raw.requestId, "InvalidCorrelation", "response.requestId", COMPANION_IPC_LIMITS.maxRequestIdLength);
  const type = parseResponseType(raw.type);
  switch (raw.status) {
    case "ok":
      if (raw.error !== undefined) {
        throw new CompanionIpcError("InvalidResponseShape", "ok response must not include error");
      }
      return Object.freeze({
        protocolMajor: PROTOCOL_MAJOR,
        requestId,
        type,
        status: "ok",
        payload: parseResponsePayload(type, raw.payload),
      }) as CompanionResponse;
    case "error":
      if (raw.payload !== undefined) {
        throw new CompanionIpcError("InvalidResponseShape", "error response must not include payload");
      }
      return Object.freeze({
        protocolMajor: PROTOCOL_MAJOR,
        requestId,
        type,
        status: "error",
        error: parseCompanionStableError(raw.error),
      }) as CompanionResponse;
    default:
      throw new CompanionIpcError("InvalidResponseShape", "response.status must be ok or error");
  }
}

export interface CompanionProofBytesInput {
  readonly protocolMajor: typeof PROTOCOL_MAJOR;
  readonly companionInstanceId: string;
  readonly nonceBase64: string;
  readonly runnerId: string;
}

/**
 * Build the exact proof byte-vector shared by the TypeScript client and native
 * Companion:
 * `qualigence-companion-proof/v1\n1\n${companionInstanceId}\n${nonceBase64}\n${runnerId}\n`.
 */
export function buildCompanionProofBytes(input: CompanionProofBytesInput): Uint8Array {
  if (input.protocolMajor !== PROTOCOL_MAJOR) {
    throw new CompanionIpcError("InvalidHandshake", "proof protocolMajor must be 1");
  }
  const companionInstanceId = str(input.companionInstanceId, "InvalidHandshake", "companionInstanceId", COMPANION_IPC_LIMITS.maxCompanionInstanceIdLength);
  const nonceBase64 = str(input.nonceBase64, "InvalidHandshake", "nonceBase64", COMPANION_IPC_LIMITS.maxNonceLength);
  const runnerId = str(input.runnerId, "InvalidHandshake", "runnerId", COMPANION_IPC_LIMITS.maxRunnerIdLength);
  return new TextEncoder().encode(`${COMPANION_PROOF_CONTEXT}\n${PROTOCOL_MAJOR}\n${companionInstanceId}\n${nonceBase64}\n${runnerId}\n`);
}

/**
 * Local authorization policy evaluation shared with the Companion's Rust logic:
 * ProductionForbidden is *always* denied, higher-risk classes always require an
 * explicit human approval, and only Normal may be auto-issued in an active
 * unpaused session. This never mints a permit; it only classifies.
 */
export type LocalAuthorizationClass = "auto-normal" | "requires-approval" | "forbidden";

export function classifyLocalAuthorization(risk: LocalActionRisk): LocalAuthorizationClass {
  switch (risk) {
    case "ProductionForbidden":
      return "forbidden";
    case "Destructive":
    case "ExternalSideEffect":
      return "requires-approval";
    case "Normal":
      return "auto-normal";
  }
}

/** True if the permit's `expiresAt` is at or before `nowIso`. */
export function isLocalPermitExpired(permit: LocalExecutionPermit, nowIso: string): boolean {
  const expires = Date.parse(permit.expiresAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(expires) || Number.isNaN(now)) {
    return true;
  }
  return now >= expires;
}
