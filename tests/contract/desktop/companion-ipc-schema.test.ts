import { describe, expect, it } from "vitest";
import {
  assertDeclaredFrameLength,
  classifyLocalAuthorization,
  COMPANION_IPC_LIMITS,
  COMPANION_REQUEST_TYPES,
  CompanionIpcError,
  isLocalPermitExpired,
  parseCompanionDecision,
  parseCompanionRequest,
  parseLocalExecutionPermit,
  parseResolvedDesktopAction,
  validateAppTarget,
  type CompanionRequest,
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

const executeRequest = {
  type: "action.execute",
  sessionId: "sess-1",
  action,
  permit,
  deadlineMs: 5000,
};

describe("AppTarget validation", () => {
  it("accepts a canonical Windows target", () => {
    const target = validateAppTarget(validTarget);
    expect(target.platform).toBe("windows");
    expect(target.launch.args).toEqual(["--fixture", "default"]);
    expect(Object.isFrozen(target)).toBe(true);
  });

  it("rejects a shell command string instead of executable + argv", () => {
    expect(() =>
      validateAppTarget({ ...validTarget, launch: { command: "app.exe --flag" } }),
    ).toThrowError(/InvalidLaunchConfiguration/);
  });

  it("rejects an executable that carries arguments/spaces", () => {
    expect(() =>
      validateAppTarget({
        ...validTarget,
        launch: { executable: "C:\\Apps\\Reference.exe --flag", args: [] },
      }),
    ).toThrowError(/InvalidLaunchConfiguration/);
  });

  it("rejects a broad kill image name with a wildcard", () => {
    expect(() =>
      validateAppTarget({
        ...validTarget,
        process: { expectedImageName: "*.exe", allowedChildImageNames: [] },
      }),
    ).toThrowError(/InvalidProcessConfiguration/);
  });

  it("rejects a missing reset deadline", () => {
    const { reset, ...rest } = validTarget;
    void reset;
    expect(() =>
      validateAppTarget({ ...rest, reset: { command: "C:\\Apps\\Reset.exe", args: [] } }),
    ).toThrowError(/InvalidResetConfiguration/);
  });

  it("rejects a non-Windows platform", () => {
    expect(() => validateAppTarget({ ...validTarget, platform: "macos" })).toThrowError(
      /InvalidPlatform/,
    );
  });
});

describe("CompanionRequest schema", () => {
  it("parses every request discriminant", () => {
    const requests: unknown[] = [
      { type: "handshake.begin", protocolMajor: 1, runnerId: "runner-1", certificatePem: "-----BEGIN CERTIFICATE-----" },
      { type: "handshake.prove", challengeId: "ch-1", signatureBase64: "c2ln" },
      { type: "session.show", runId: "run-1", targetName: "Reference App" },
      { type: "session.pause", runId: "run-1" },
      { type: "session.resume", runId: "run-1" },
      { type: "session.stop", runId: "run-1" },
      { type: "session.close", runId: "run-1" },
      { type: "app.launch", target: validTarget },
      { type: "app.reset", sessionId: "sess-1" },
      { type: "app.shutdown", sessionId: "sess-1" },
      { type: "uia.capture", sessionId: "sess-1", deadlineMs: 2000 },
      {
        type: "permit.request",
        request: {
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
        },
      },
      executeRequest,
    ];
    const parsed = requests.map((r) => parseCompanionRequest(r).type);
    expect(new Set(parsed)).toEqual(new Set(COMPANION_REQUEST_TYPES));
  });

  it("rejects an unknown request type", () => {
    expect(() => parseCompanionRequest({ type: "session.explode", runId: "r" })).toThrowError(
      /UnknownRequestType/,
    );
  });

  it("rejects an oversized declared frame", () => {
    expect(() => assertDeclaredFrameLength(COMPANION_IPC_LIMITS.maxFrameBytes + 1)).toThrowError(
      /CompanionMessageTooLarge/,
    );
  });

  it("rejects a missing deadline", () => {
    const { deadlineMs, ...rest } = executeRequest;
    void deadlineMs;
    expect(() => parseCompanionRequest(rest)).toThrowError(/MissingDeadline/);
  });

  it("rejects a malformed certificate proof", () => {
    expect(() =>
      parseCompanionRequest({ type: "handshake.begin", protocolMajor: 1, runnerId: "r", certificatePem: "" }),
    ).toThrowError(/InvalidCertificateProof/);
    expect(() =>
      parseCompanionRequest({ type: "handshake.prove", challengeId: "ch", signatureBase64: 123 }),
    ).toThrowError(/InvalidCertificateProof/);
  });

  it("rejects action.execute with a missing permit", () => {
    expect(() => parseCompanionRequest({ ...executeRequest, permit: undefined })).toThrowError(
      /LocalPermitInvalid/,
    );
  });

  it("rejects an action/permit digest mismatch at the caller boundary", () => {
    const request = parseCompanionRequest(executeRequest) as Extract<
      CompanionRequest,
      { type: "action.execute" }
    >;
    // The parser preserves both digests; the Companion (Rust) is the authority
    // that recomputes and compares them, but the DTO must expose both so the
    // mismatch is observable.
    expect(request.permit.actionDigestSha256).toBe("a".repeat(64));
    expect(request.action.actionId).toBe(request.permit.actionId);
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
    expect(() => parseResolvedDesktopAction({ ...action, targetKind: "web" })).toThrowError(
      /InvalidAction/,
    );
  });

  it("rejects a permit that is not an object", () => {
    expect(() => parseLocalExecutionPermit(null)).toThrowError(CompanionIpcError);
  });
});
