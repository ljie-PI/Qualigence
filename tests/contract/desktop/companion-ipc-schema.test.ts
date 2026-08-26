import { describe, expect, it } from "vitest";
import {
  assertDeclaredFrameLength,
  buildCompanionProofBytes,
  classifyLocalAuthorization,
  COMPANION_IPC_LIMITS,
  COMPANION_REQUEST_TYPES,
  COMPANION_RESPONSE_TYPES,
  COMPANION_UIA_PASSWORD_MASK_VALUE,
  CompanionIpcError,
  createCompanionRequestEnvelope,
  expectedResponseTypeForRequest,
  isLocalPermitExpired,
  parseCompanionDecision,
  parseCompanionRequest,
  parseCompanionResponse,
  parseLocalExecutionPermit,
  parseResolvedDesktopAction,
  validateAppTarget,
  type CompanionResponse,
  type LocalExecutionPermit,
  type ResolvedDesktopAction,
} from "@qualigence/desktop-contracts";

const validTarget = {
  targetId: "wpf-reference",
  platform: "windows",
  launch: {
    executable: "C:\\Apps\\Reference\\Reference.exe",
    args: ["--fixture", "default"],
    workingDirectory: "C:\\Apps\\Reference",
  },
  process: {
    expectedImageName: "Reference.exe",
    allowedChildImageNames: ["ReferenceHelper.exe"],
  },
  window: { titlePattern: "Reference App", automationId: "MainWindow" },
  reset: { command: "C:\\Apps\\Reference\\Reset.exe", args: ["--full"], timeoutMs: 5000 },
  shutdown: { gracefulTimeoutMs: 3000, forceAfterTimeout: true },
};

const action: ResolvedDesktopAction = {
  targetKind: "desktop",
  kind: "click",
  actionId: "act-1",
  graphId: "graph-1",
  nodeId: "node-1",
  resolution: "semantic",
};

const permit: LocalExecutionPermit = {
  permitToken: "dG9rZW4=",
  nonceBase64: "bm9uY2U=",
  sessionId: "sess-1",
  runId: "run-1",
  actionId: "act-1",
  actionDigestSha256: "a".repeat(64),
  graphId: "graph-1",
  risk: "Normal",
  issuedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-01T00:00:30.000Z",
};

const executePayload = {
  sessionId: "sess-1",
  action,
  permit,
  deadlineMs: 5000,
};

const permitRequest = {
  approvalId: "ap-1",
  sessionId: "sess-1",
  runId: "run-1",
  action,
  authorization: {
    decisionId: "dec-1",
    policyId: "pol-1",
    actionDigestSha256: "a".repeat(64),
    risk: "Normal",
    expiresAt: "2026-08-01T00:00:30.000Z",
  },
  safeSummary: "Click the Submit button",
  expiresAt: "2026-08-01T00:00:30.000Z",
} as const;

function request(requestId: string, type: string, payload: unknown): Record<string, unknown> {
  return { protocolMajor: 1, requestId, type, payload };
}

function response(requestId: string, type: string, payload: unknown): Record<string, unknown> {
  return { protocolMajor: 1, requestId, type, status: "ok", payload };
}

const appSession = {
  sessionId: "sess-1",
  processId: 1234,
  processCreationTime: "2026-08-01T00:00:00.000Z",
  processGroupId: "group-1",
  rootWindowHandle: "0x100",
  startedAt: "2026-08-01T00:00:00.000Z",
};

const uiaCapture = {
  sessionId: "sess-1",
  capturedAt: "2026-08-01T00:00:00.000Z",
  rootNodeIds: ["root"],
  nodes: [
    {
      nodeId: "root",
      role: "window",
      controlTypeId: 50032,
      processId: 1234,
      isOffscreen: false,
      isKeyboardFocusable: true,
      hasKeyboardFocus: false,
      isPassword: false,
      patterns: [{ pattern: "Window", available: true }],
      children: [],
    },
  ],
};

describe("AppTarget validation", () => {
  it("accepts a canonical Windows target", () => {
    const target = validateAppTarget(validTarget);
    expect(target.platform).toBe("windows");
    expect(target.launch.args).toEqual(["--fixture", "default"]);
    expect(Object.isFrozen(target)).toBe(true);
  });

  it("rejects a shell command string instead of executable + argv", () => {
    expect(() => validateAppTarget({ ...validTarget, launch: { command: "app.exe --flag" } })).toThrowError(/InvalidLaunchConfiguration/);
  });

  it("rejects an executable that carries arguments/spaces", () => {
    expect(() => validateAppTarget({ ...validTarget, launch: { executable: "C:\\Apps\\Reference.exe --flag", args: [] } })).toThrowError(/InvalidLaunchConfiguration/);
  });

  it("rejects a broad kill image name with a wildcard", () => {
    expect(() => validateAppTarget({ ...validTarget, process: { expectedImageName: "*.exe", allowedChildImageNames: [] } })).toThrowError(/InvalidProcessConfiguration/);
  });

  it("rejects a missing reset deadline", () => {
    const { reset, ...rest } = validTarget;
    void reset;
    expect(() => validateAppTarget({ ...rest, reset: { command: "C:\\Apps\\Reset.exe", args: [] } })).toThrowError(/InvalidResetConfiguration/);
  });

  it("rejects a non-Windows platform", () => {
    expect(() => validateAppTarget({ ...validTarget, platform: "macos" })).toThrowError(/InvalidPlatform/);
  });
});

describe("Companion IPC envelopes", () => {
  it("parses every request discriminant through the bounded envelope", () => {
    const requests: unknown[] = [
      request("req-1", "handshake.begin", { runnerId: "runner-1", certificatePem: "-----BEGIN CERTIFICATE-----" }),
      request("req-2", "handshake.prove", { challengeId: "ch-1", companionInstanceId: "comp-1", nonceBase64: "bm9uY2U=", signatureBase64: "c2ln", signatureAlgorithm: "ecdsa-p256-sha256" }),
      request("req-3", "session.show", { runId: "run-1", targetName: "Reference App" }),
      request("req-4", "session.pause", { runId: "run-1" }),
      request("req-5", "session.resume", { runId: "run-1" }),
      request("req-6", "session.stop", { runId: "run-1" }),
      request("req-7", "session.close", { runId: "run-1" }),
      request("req-8", "app.launch", { target: validTarget }),
      request("req-9", "app.reset", { sessionId: "sess-1" }),
      request("req-10", "app.shutdown", { sessionId: "sess-1" }),
      request("req-11", "uia.capture", { sessionId: "sess-1", deadlineMs: 2000 }),
      request("req-12", "permit.request", { request: permitRequest }),
      request("req-13", "action.execute", executePayload),
    ];
    const parsed = requests.map((r) => parseCompanionRequest(r).type);
    expect(new Set(parsed)).toEqual(new Set(COMPANION_REQUEST_TYPES));
  });

  it("parses the complete CompanionResponse union", () => {
    const responses: CompanionResponse[] = [
      parseCompanionResponse(response("req-1", "handshake.challenge", { challengeId: "ch-1", companionInstanceId: "comp-1", nonceBase64: "bm9uY2U=" })) as CompanionResponse,
      parseCompanionResponse(response("req-2", "handshake.accepted", { companionInstanceId: "comp-1", runnerId: "runner-1", certificateSha256Fingerprint: "a".repeat(64), acceptedAt: "2026-08-01T00:00:00.000Z" })) as CompanionResponse,
      parseCompanionResponse(response("req-3", "session.show", { runId: "run-1", state: "shown", changedAt: "2026-08-01T00:00:00.000Z" })) as CompanionResponse,
      parseCompanionResponse(response("req-4", "session.pause", { runId: "run-1", state: "paused", changedAt: "2026-08-01T00:00:00.000Z" })) as CompanionResponse,
      parseCompanionResponse(response("req-5", "session.resume", { runId: "run-1", state: "resumed", changedAt: "2026-08-01T00:00:00.000Z" })) as CompanionResponse,
      parseCompanionResponse(response("req-6", "session.stop", { runId: "run-1", state: "stopped", changedAt: "2026-08-01T00:00:00.000Z" })) as CompanionResponse,
      parseCompanionResponse(response("req-7", "session.close", { runId: "run-1", state: "closed", changedAt: "2026-08-01T00:00:00.000Z" })) as CompanionResponse,
      parseCompanionResponse(response("req-8", "app.launch", appSession)) as CompanionResponse,
      parseCompanionResponse(response("req-9", "app.reset", { sessionId: "sess-1", completedAt: "2026-08-01T00:00:00.000Z" })) as CompanionResponse,
      parseCompanionResponse(response("req-10", "app.shutdown", { sessionId: "sess-1", completedAt: "2026-08-01T00:00:00.000Z" })) as CompanionResponse,
      parseCompanionResponse(response("req-11", "uia.capture", uiaCapture)) as CompanionResponse,
      parseCompanionResponse(response("req-12", "permit.request", { status: "denied", approvalId: "ap-1", decidedAt: "2026-08-01T00:00:00.000Z" })) as CompanionResponse,
      parseCompanionResponse(response("req-13", "action.execute", { status: "failed", errorCode: "ElementNotFound" })) as CompanionResponse,
    ];
    expect(new Set(responses.map((r) => r.type))).toEqual(new Set(COMPANION_RESPONSE_TYPES));
  });

  it("rejects raw legacy DTOs and unknown envelope fields at runtime", () => {
    const legacy: unknown = { type: "action.execute", ...executePayload };
    expect(() => parseCompanionRequest(legacy)).toThrowError(/InvalidRequestShape/);
    expect(() => parseCompanionRequest({ ...request("req", "app.reset", { sessionId: "s" }), extra: true })).toThrowError(/InvalidRequestShape/);
    expect(() => parseCompanionResponse({ ...response("req", "app.reset", { sessionId: "s", completedAt: "2026-08-01T00:00:00.000Z" }), extra: true })).toThrowError(/InvalidResponseShape/);
  });

  it("rejects unknown request and response types", () => {
    expect(() => parseCompanionRequest(request("req", "session.explode", { runId: "r" }))).toThrowError(/UnknownRequestType/);
    expect(() => parseCompanionResponse(response("req", "session.explode", {}))).toThrowError(/UnknownResponseType/);
  });

  it("rejects zero and oversized declared frames", () => {
    expect(() => assertDeclaredFrameLength(0)).toThrowError(/InvalidRequestShape/);
    expect(() => assertDeclaredFrameLength(COMPANION_IPC_LIMITS.maxFrameBytes + 1)).toThrowError(/CompanionMessageTooLarge/);
  });

  it("rejects a missing deadline and malformed certificate proof payload", () => {
    expect(() => parseCompanionRequest(request("req", "action.execute", { ...executePayload, deadlineMs: undefined }))).toThrowError(/MissingDeadline/);
    expect(() => parseCompanionRequest(request("req", "handshake.begin", { runnerId: "r", certificatePem: "" }))).toThrowError(/InvalidCertificateProof/);
    expect(() => parseCompanionRequest(request("req", "handshake.prove", { challengeId: "ch", companionInstanceId: "comp", nonceBase64: "nonce", signatureBase64: "sig", signatureAlgorithm: "ed25519" }))).toThrowError(/InvalidCertificateProof/);
  });

  it("maps request discriminants to strict response discriminants", () => {
    expect(expectedResponseTypeForRequest("handshake.begin")).toBe("handshake.challenge");
    expect(expectedResponseTypeForRequest("handshake.prove")).toBe("handshake.accepted");
    expect(expectedResponseTypeForRequest("uia.capture")).toBe("uia.capture");
    expect(createCompanionRequestEnvelope("req", "app.reset", { sessionId: "sess-1" }).payload.sessionId).toBe("sess-1");
  });

  it("builds the exact cross-language Companion proof bytes", () => {
    const bytes = buildCompanionProofBytes({
      protocolMajor: 1,
      companionInstanceId: "companion-α",
      nonceBase64: "bm9uY2U=",
      runnerId: "runner-1",
    });
    expect(new TextDecoder().decode(bytes)).toBe("qualigence-companion-proof/v1\n1\ncompanion-α\nbm9uY2U=\nrunner-1\n");
  });

  it("rejects a response DTO/variant with malformed fields", () => {
    expect(() => parseCompanionResponse(response("req", "uia.capture", { ...uiaCapture, nodes: [{ ...uiaCapture.nodes[0], isPassword: "false" }] }))).toThrowError(/InvalidResponseShape/);
    expect(() => parseCompanionResponse({ protocolMajor: 1, requestId: "req", type: "action.execute", status: "error", payload: {}, error: { code: "ApplicationError", safeMessage: "bad" } })).toThrowError(/InvalidResponseShape/);
  });

  it("enforces the fixed UIA password mask on captured password nodes", () => {
    const maskedPasswordCapture = {
      ...uiaCapture,
      nodes: [{ ...uiaCapture.nodes[0], isPassword: true, value: COMPANION_UIA_PASSWORD_MASK_VALUE }],
    };
    const parsed = parseCompanionResponse(response("req", "uia.capture", maskedPasswordCapture));
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok" && parsed.type === "uia.capture") {
      expect(parsed.payload.nodes[0]?.value).toBe(COMPANION_UIA_PASSWORD_MASK_VALUE);
    }

    expect(() => parseCompanionResponse(response("req", "uia.capture", {
      ...uiaCapture,
      nodes: [{ ...uiaCapture.nodes[0], isPassword: true, value: "hunter2" }],
    }))).toThrowError(/password controls must be the fixed UIA password mask token/);
    expect(() => parseCompanionResponse(response("req", "uia.capture", {
      ...uiaCapture,
      nodes: [{ ...uiaCapture.nodes[0], isPassword: true }],
    }))).toThrowError(/password controls must be the fixed UIA password mask token/);
  });
});

describe("approval decision + permit classification", () => {
  it("parses an approved decision carrying a permit", () => {
    const decision = parseCompanionDecision({
      status: "approved",
      approvalId: "ap-1",
      decidedAt: "2026-08-01T00:00:00.000Z",
      permit,
    });
    expect(decision.status).toBe("approved");
  });

  it("parses a denied decision without a permit", () => {
    const decision = parseCompanionDecision({
      status: "denied",
      approvalId: "ap-1",
      decidedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(decision).toMatchObject({ status: "denied" });
  });

  it("classifies ProductionForbidden as always forbidden and high risk as approval-gated", () => {
    expect(classifyLocalAuthorization("ProductionForbidden")).toBe("forbidden");
    expect(classifyLocalAuthorization("Destructive")).toBe("requires-approval");
    expect(classifyLocalAuthorization("ExternalSideEffect")).toBe("requires-approval");
    expect(classifyLocalAuthorization("Normal")).toBe("auto-normal");
  });

  it("treats an expired permit as expired", () => {
    expect(isLocalPermitExpired(permit, "2026-08-01T00:00:31.000Z")).toBe(true);
    expect(isLocalPermitExpired(permit, "2026-08-01T00:00:10.000Z")).toBe(false);
  });
});

describe("permit + action DTO guards", () => {
  it("rejects a non-desktop action", () => {
    expect(() => parseResolvedDesktopAction({ ...action, targetKind: "web" })).toThrowError(/InvalidAction/);
  });

  it("rejects a permit that is not an object", () => {
    expect(() => parseLocalExecutionPermit(null)).toThrowError(CompanionIpcError);
  });
});
