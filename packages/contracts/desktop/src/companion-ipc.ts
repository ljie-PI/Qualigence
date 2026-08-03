/**
 * Companion IPC contract (LS-13 / M3).
 *
 * The Rust Companion is the SOLE broker for desktop process lifecycle, UIA
 * capture and UIA action execution (specialist review finding W-01). TypeScript
 * never holds a Win32/UIA handle or a target PID; it may only send these typed,
 * bounded, versioned request DTOs across the authenticated Named Pipe.
 *
 * Every one of these types is a wire DTO. In particular {@link LocalExecutionPermit}
 * is a *description* of a permit the Companion issued — TypeScript can never mint
 * a valid one, because the Companion stores only the token hash + full binding in
 * memory and consumes it exactly once. These DTOs deliberately do not import
 * `@qualigence/runner-kernel`; the branded `ExecutionPermit` and Sensor/Action
 * ports are added there in a later PR.
 */

import type { UiaPattern } from "./uia-extension.js";
import { validateAppTarget, type AppTarget } from "./app-target.js";

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

export type ResolvedDesktopAction =
  | (ResolvedDesktopActionBase & { readonly kind: "click" })
  | (ResolvedDesktopActionBase & { readonly kind: "input"; readonly valueRef: string })
  | (ResolvedDesktopActionBase & { readonly kind: "select"; readonly option: string })
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

export type LocalApprovalStatus =
  | "approved"
  | "denied"
  | "timed_out"
  | "emergency_stopped";

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
  readonly nonceBase64: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionDigestSha256: string;
  readonly graphId: string;
  readonly risk: LocalActionRisk;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type CompanionRequest =
  | { readonly type: "handshake.begin"; readonly protocolMajor: 1; readonly runnerId: string; readonly certificatePem: string }
  | { readonly type: "handshake.prove"; readonly challengeId: string; readonly signatureBase64: string }
  | { readonly type: "session.show"; readonly runId: string; readonly targetName: string }
  | { readonly type: "session.pause"; readonly runId: string }
  | { readonly type: "session.resume"; readonly runId: string }
  | { readonly type: "session.stop"; readonly runId: string }
  | { readonly type: "session.close"; readonly runId: string }
  | { readonly type: "app.launch"; readonly target: AppTarget }
  | { readonly type: "app.reset"; readonly sessionId: string }
  | { readonly type: "app.shutdown"; readonly sessionId: string }
  | { readonly type: "uia.capture"; readonly sessionId: string; readonly deadlineMs: number }
  | { readonly type: "permit.request"; readonly request: LocalPermitRequest }
  | {
      readonly type: "action.execute";
      readonly sessionId: string;
      readonly action: ResolvedDesktopAction;
      readonly permit: LocalExecutionPermit;
      readonly deadlineMs: number;
    };

export type CompanionRequestType = CompanionRequest["type"];

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

/** Fixed protocol bounds; anything beyond these fails closed before dispatch. */
export const COMPANION_IPC_LIMITS = {
  /** Maximum single declared frame (32-bit length-prefixed) in bytes. */
  maxFrameBytes: 1 << 20,
  maxRunnerIdLength: 200,
  maxCertificatePemLength: 16_384,
  maxSignatureBase64Length: 2048,
  maxChallengeIdLength: 128,
  maxIdLength: 200,
  maxTargetNameLength: 512,
  maxSafeSummaryLength: 1024,
  maxDigestLength: 64,
  maxTokenLength: 512,
  maxNonceLength: 512,
  minDeadlineMs: 1,
  maxDeadlineMs: 600_000,
} as const;

export const PROTOCOL_MAJOR = 1 as const;

export type CompanionIpcErrorCode =
  | "CompanionMessageTooLarge"
  | "InvalidRequestShape"
  | "UnknownRequestType"
  | "InvalidHandshake"
  | "InvalidCertificateProof"
  | "MissingDeadline"
  | "InvalidDeadline"
  | "InvalidAction"
  | "LocalPermitInvalid"
  | "LocalAuthorizationInvalid"
  | "InvalidApprovalDecision";

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

function str(
  value: unknown,
  code: CompanionIpcErrorCode,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CompanionIpcError(code, `${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new CompanionIpcError(code, `${field} exceeds ${maxLength} characters`);
  }
  return value;
}

const RISKS: readonly LocalActionRisk[] = ["Normal", "ExternalSideEffect", "Destructive", "ProductionForbidden"];
const RESOLUTIONS: readonly DesktopActionResolution[] = ["semantic", "uia", "visual", "coordinate"];

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

/** Reject an oversized declared frame length before ever allocating for it. */
export function assertDeclaredFrameLength(declaredLength: number): void {
  if (!Number.isInteger(declaredLength) || declaredLength < 0) {
    throw new CompanionIpcError("InvalidRequestShape", "declared frame length must be a non-negative integer");
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
  if (!isRecord(value)) {
    throw new CompanionIpcError("InvalidAction", "action must be an object");
  }
  if (value.targetKind !== "desktop") {
    throw new CompanionIpcError("InvalidAction", "action.targetKind must be \"desktop\"");
  }
  const actionId = str(value.actionId, "InvalidAction", "action.actionId", COMPANION_IPC_LIMITS.maxIdLength);
  const graphId = str(value.graphId, "InvalidAction", "action.graphId", COMPANION_IPC_LIMITS.maxIdLength);
  const nodeId = str(value.nodeId, "InvalidAction", "action.nodeId", COMPANION_IPC_LIMITS.maxIdLength);
  if (typeof value.resolution !== "string" || !RESOLUTIONS.includes(value.resolution as DesktopActionResolution)) {
    throw new CompanionIpcError("InvalidAction", `action.resolution must be one of ${RESOLUTIONS.join(", ")}`);
  }
  const resolution = value.resolution as DesktopActionResolution;
  const base: ResolvedDesktopActionBase = {
    targetKind: "desktop",
    actionId,
    graphId,
    nodeId,
    resolution,
    ...(value.uiaPattern === undefined ? {} : { uiaPattern: value.uiaPattern as UiaPattern }),
  };

  switch (value.kind) {
    case "click":
      return { ...base, kind: "click" };
    case "input":
      return { ...base, kind: "input", valueRef: str(value.valueRef, "InvalidAction", "action.valueRef", COMPANION_IPC_LIMITS.maxIdLength) };
    case "select":
      return { ...base, kind: "select", option: str(value.option, "InvalidAction", "action.option", COMPANION_IPC_LIMITS.maxSafeSummaryLength) };
    case "scroll": {
      const direction = value.direction;
      const amount = value.amount;
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
        throw new CompanionIpcError("InvalidAction", "action.direction is invalid");
      }
      if (amount !== "page" && amount !== "small") {
        throw new CompanionIpcError("InvalidAction", "action.amount is invalid");
      }
      return { ...base, kind: "scroll", direction, amount };
    }
    case "window": {
      const op = value.windowOperation;
      if (op !== "focus" && op !== "minimize" && op !== "restore" && op !== "close") {
        throw new CompanionIpcError("InvalidAction", "action.windowOperation is invalid");
      }
      return { ...base, kind: "window", windowOperation: op };
    }
    default:
      throw new CompanionIpcError("InvalidAction", "action.kind is invalid");
  }
}

export function parseLocalPermitAuthorization(value: unknown): LocalPermitAuthorization {
  if (!isRecord(value)) {
    throw new CompanionIpcError("LocalAuthorizationInvalid", "authorization must be an object");
  }
  return {
    decisionId: str(value.decisionId, "LocalAuthorizationInvalid", "authorization.decisionId", COMPANION_IPC_LIMITS.maxIdLength),
    policyId: str(value.policyId, "LocalAuthorizationInvalid", "authorization.policyId", COMPANION_IPC_LIMITS.maxIdLength),
    actionDigestSha256: str(value.actionDigestSha256, "LocalAuthorizationInvalid", "authorization.actionDigestSha256", COMPANION_IPC_LIMITS.maxDigestLength),
    risk: requireRisk(value.risk, "LocalAuthorizationInvalid", "authorization.risk"),
    expiresAt: str(value.expiresAt, "LocalAuthorizationInvalid", "authorization.expiresAt", 64),
  };
}

export function parseLocalExecutionPermit(value: unknown): LocalExecutionPermit {
  if (!isRecord(value)) {
    throw new CompanionIpcError("LocalPermitInvalid", "permit must be an object");
  }
  return {
    permitToken: str(value.permitToken, "LocalPermitInvalid", "permit.permitToken", COMPANION_IPC_LIMITS.maxTokenLength),
    nonceBase64: str(value.nonceBase64, "LocalPermitInvalid", "permit.nonceBase64", COMPANION_IPC_LIMITS.maxNonceLength),
    sessionId: str(value.sessionId, "LocalPermitInvalid", "permit.sessionId", COMPANION_IPC_LIMITS.maxIdLength),
    runId: str(value.runId, "LocalPermitInvalid", "permit.runId", COMPANION_IPC_LIMITS.maxIdLength),
    actionId: str(value.actionId, "LocalPermitInvalid", "permit.actionId", COMPANION_IPC_LIMITS.maxIdLength),
    actionDigestSha256: str(value.actionDigestSha256, "LocalPermitInvalid", "permit.actionDigestSha256", COMPANION_IPC_LIMITS.maxDigestLength),
    graphId: str(value.graphId, "LocalPermitInvalid", "permit.graphId", COMPANION_IPC_LIMITS.maxIdLength),
    risk: requireRisk(value.risk, "LocalPermitInvalid", "permit.risk"),
    issuedAt: str(value.issuedAt, "LocalPermitInvalid", "permit.issuedAt", 64),
    expiresAt: str(value.expiresAt, "LocalPermitInvalid", "permit.expiresAt", 64),
  };
}

export function parseLocalPermitRequest(value: unknown): LocalPermitRequest {
  if (!isRecord(value)) {
    throw new CompanionIpcError("LocalPermitInvalid", "permit request must be an object");
  }
  return {
    approvalId: str(value.approvalId, "LocalPermitInvalid", "request.approvalId", COMPANION_IPC_LIMITS.maxIdLength),
    sessionId: str(value.sessionId, "LocalPermitInvalid", "request.sessionId", COMPANION_IPC_LIMITS.maxIdLength),
    runId: str(value.runId, "LocalPermitInvalid", "request.runId", COMPANION_IPC_LIMITS.maxIdLength),
    action: parseResolvedDesktopAction(value.action),
    authorization: parseLocalPermitAuthorization(value.authorization),
    safeSummary: str(value.safeSummary, "LocalPermitInvalid", "request.safeSummary", COMPANION_IPC_LIMITS.maxSafeSummaryLength),
    expiresAt: str(value.expiresAt, "LocalPermitInvalid", "request.expiresAt", 64),
  };
}

/** Strictly validate an approval-decision DTO returned by the Companion. */
export function parseCompanionDecision(value: unknown): LocalApprovalDecision {
  if (!isRecord(value)) {
    throw new CompanionIpcError("InvalidApprovalDecision", "decision must be an object");
  }
  const approvalId = str(value.approvalId, "InvalidApprovalDecision", "decision.approvalId", COMPANION_IPC_LIMITS.maxIdLength);
  const decidedAt = str(value.decidedAt, "InvalidApprovalDecision", "decision.decidedAt", 64);
  switch (value.status) {
    case "approved":
      return { status: "approved", approvalId, decidedAt, permit: parseLocalExecutionPermit(value.permit) };
    case "denied":
    case "timed_out":
    case "emergency_stopped":
      return { status: value.status, approvalId, decidedAt };
    default:
      throw new CompanionIpcError("InvalidApprovalDecision", "decision.status is invalid");
  }
}

/**
 * Strictly validate an untrusted Companion request DTO. Rejects unknown types,
 * missing deadlines, malformed handshake proofs, and missing/invalid permits with
 * stable error codes so the transport can fail closed before any dispatch.
 */
export function parseCompanionRequest(value: unknown): CompanionRequest {
  if (!isRecord(value)) {
    throw new CompanionIpcError("InvalidRequestShape", "request must be an object");
  }
  const type = value.type;
  if (typeof type !== "string" || !COMPANION_REQUEST_TYPES.includes(type as CompanionRequestType)) {
    throw new CompanionIpcError("UnknownRequestType", `unknown request type: ${String(type)}`);
  }

  switch (type as CompanionRequestType) {
    case "handshake.begin": {
      if (value.protocolMajor !== PROTOCOL_MAJOR) {
        throw new CompanionIpcError("InvalidHandshake", "protocolMajor must be 1");
      }
      return {
        type: "handshake.begin",
        protocolMajor: PROTOCOL_MAJOR,
        runnerId: str(value.runnerId, "InvalidHandshake", "runnerId", COMPANION_IPC_LIMITS.maxRunnerIdLength),
        certificatePem: str(value.certificatePem, "InvalidCertificateProof", "certificatePem", COMPANION_IPC_LIMITS.maxCertificatePemLength),
      };
    }
    case "handshake.prove":
      return {
        type: "handshake.prove",
        challengeId: str(value.challengeId, "InvalidCertificateProof", "challengeId", COMPANION_IPC_LIMITS.maxChallengeIdLength),
        signatureBase64: str(value.signatureBase64, "InvalidCertificateProof", "signatureBase64", COMPANION_IPC_LIMITS.maxSignatureBase64Length),
      };
    case "session.show":
      return {
        type: "session.show",
        runId: str(value.runId, "InvalidRequestShape", "runId", COMPANION_IPC_LIMITS.maxIdLength),
        targetName: str(value.targetName, "InvalidRequestShape", "targetName", COMPANION_IPC_LIMITS.maxTargetNameLength),
      };
    case "session.pause":
      return { type: "session.pause", runId: str(value.runId, "InvalidRequestShape", "runId", COMPANION_IPC_LIMITS.maxIdLength) };
    case "session.resume":
      return { type: "session.resume", runId: str(value.runId, "InvalidRequestShape", "runId", COMPANION_IPC_LIMITS.maxIdLength) };
    case "session.stop":
      return { type: "session.stop", runId: str(value.runId, "InvalidRequestShape", "runId", COMPANION_IPC_LIMITS.maxIdLength) };
    case "session.close":
      return { type: "session.close", runId: str(value.runId, "InvalidRequestShape", "runId", COMPANION_IPC_LIMITS.maxIdLength) };
    case "app.launch":
      return { type: "app.launch", target: validateAppTarget(value.target) };
    case "app.reset":
      return { type: "app.reset", sessionId: str(value.sessionId, "InvalidRequestShape", "sessionId", COMPANION_IPC_LIMITS.maxIdLength) };
    case "app.shutdown":
      return { type: "app.shutdown", sessionId: str(value.sessionId, "InvalidRequestShape", "sessionId", COMPANION_IPC_LIMITS.maxIdLength) };
    case "uia.capture":
      return {
        type: "uia.capture",
        sessionId: str(value.sessionId, "InvalidRequestShape", "sessionId", COMPANION_IPC_LIMITS.maxIdLength),
        deadlineMs: requireDeadline(value.deadlineMs),
      };
    case "permit.request":
      return { type: "permit.request", request: parseLocalPermitRequest(value.request) };
    case "action.execute": {
      if (value.permit === undefined || value.permit === null) {
        throw new CompanionIpcError("LocalPermitInvalid", "action.execute requires a permit");
      }
      return {
        type: "action.execute",
        sessionId: str(value.sessionId, "InvalidRequestShape", "sessionId", COMPANION_IPC_LIMITS.maxIdLength),
        action: parseResolvedDesktopAction(value.action),
        permit: parseLocalExecutionPermit(value.permit),
        deadlineMs: requireDeadline(value.deadlineMs),
      };
    }
    default:
      throw new CompanionIpcError("UnknownRequestType", `unhandled request type: ${type}`);
  }
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
