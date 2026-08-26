/**
 * Compile-time type test (checked by `tsc --noEmit -p tsconfig.test.json`, not
 * executed by Vitest). Asserts the LS-13 desktop contract types are well-formed
 * and reachable both directly and through the runner-protocol re-export surface.
 */
import {
  UIA_EXTENSION_TYPE,
  type AppTarget,
  type AppSession,
  type CompanionRequest,
  type CompanionResponse,
  type LocalExecutionPermit,
  type ResolvedDesktopAction,
  type UiaExtensionV1,
  type DesktopAdapterCapabilities,
} from "@qualigence/desktop-contracts";
import type {
  ResolvedDesktopAction as ReexportedAction,
  CompanionRequest as ReexportedRequest,
} from "@qualigence/runner-protocol";

const target: AppTarget = {
  targetId: "t",
  platform: "windows",
  launch: { executable: "C:\\a\\b.exe", args: [] },
  process: { expectedImageName: "b.exe", allowedChildImageNames: [] },
  window: {},
  reset: { command: "C:\\a\\reset.exe", args: [], timeoutMs: 1000 },
  shutdown: { gracefulTimeoutMs: 1000, forceAfterTimeout: false },
};
void target;

// AppSession exposes only an opaque processGroupId — never a native Job handle.
const session: AppSession = {
  sessionId: "s",
  processId: 1234,
  processCreationTime: "2026-08-01T00:00:00.000Z",
  processGroupId: "opaque-group",
  rootWindowHandle: "0x0",
  startedAt: "2026-08-01T00:00:00.000Z",
};
// @ts-expect-error AppSession must not expose a native Job Object handle.
const leaked: unknown = session.jobHandle;
void leaked;

const action: ResolvedDesktopAction = {
  targetKind: "desktop",
  kind: "scroll",
  actionId: "a",
  graphId: "g",
  nodeId: "n",
  resolution: "uia",
  direction: "down",
  amount: "page",
};
const viaReexport: ReexportedAction = action;
void viaReexport;

const permit: LocalExecutionPermit = {
  permitToken: "t",
  nonceBase64: "n",
  sessionId: "s",
  runId: "r",
  actionId: "a",
  actionDigestSha256: "d",
  graphId: "g",
  risk: "ExternalSideEffect",
  issuedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-01T00:00:30.000Z",
};

const request: CompanionRequest = {
  protocolMajor: 1,
  requestId: "req-1",
  type: "action.execute",
  payload: {
    sessionId: "s",
    action,
    permit,
    deadlineMs: 5000,
  },
};
const viaReexportReq: ReexportedRequest = request;
void viaReexportReq;

const mismatchedRequestPayload = {
  protocolMajor: 1,
  requestId: "req-2",
  type: "action.execute",
  payload: { sessionId: "s" },
} as const;
// @ts-expect-error CompanionRequest payload must match its envelope type.
const rejectedMismatchedRequestPayload: CompanionRequest = mismatchedRequestPayload;
void rejectedMismatchedRequestPayload;

const response: CompanionResponse = {
  protocolMajor: 1,
  requestId: "req-1",
  type: "action.execute",
  status: "ok",
  payload: { status: "ok" },
};
void response;

const mismatchedResponsePayload = {
  protocolMajor: 1,
  requestId: "req-2",
  type: "action.execute",
  status: "ok",
  payload: { sessionId: "s", capturedAt: "2026-08-01T00:00:00.000Z", rootNodeIds: [], nodes: [] },
} as const;
// @ts-expect-error CompanionResponse payload must match its envelope type.
const rejectedMismatchedResponsePayload: CompanionResponse = mismatchedResponsePayload;
void rejectedMismatchedResponsePayload;

const legacyRawRequest = {
  type: "action.execute",
  sessionId: "s",
  action,
  permit,
  deadlineMs: 5000,
} as const;
// @ts-expect-error CompanionRequest is an IPC envelope, not a legacy raw DTO union.
const rejectedLegacyRequest: CompanionRequest = legacyRawRequest;
void rejectedLegacyRequest;

const uia: UiaExtensionV1 = {
  type: UIA_EXTENSION_TYPE,
  version: "1.0",
  payload: {
    controlTypeId: 50000,
    processId: 1234,
    isOffscreen: false,
    isKeyboardFocusable: true,
    hasKeyboardFocus: false,
    patterns: [{ pattern: "Invoke", available: true }],
  },
};
void uia;

const caps: DesktopAdapterCapabilities = {
  observationExtensions: ["uia/v1"],
  actionKinds: ["click", "input", "select", "scroll", "window"],
  visualFallback: false,
  coordinateFallback: false,
  localApproval: true,
};
void caps;
