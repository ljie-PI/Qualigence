import { describe, expect, it, vi } from "vitest";
import type {
  AppSession,
  AppTarget,
  LocalApprovalDecision,
  LocalExecutionPermit,
  LocalPermitRequest,
  ResolvedDesktopAction,
} from "@qualigence/desktop-contracts";
import {
  createCompanionRequestEnvelope,
  desktopActionDigestSha256,
  desktopValueBindingForPlaintext,
  parseCompanionRequest,
  COMPANION_IPC_LIMITS,
} from "@qualigence/desktop-contracts";
import {
  ExecutionPermit,
  runnerPolicyActionDigestSha256,
  type ExecutionPermitDescriptor,
  type PolicyDecision,
  type ResolvedWebAction,
} from "@qualigence/runner-kernel";
import {
  DesktopExecutionError,
  UiaActionExecutor,
  type ActionOutcomeReport,
  type CompanionClient,
  type DesktopActionExecuteRequest,
  type UiaCaptureRequest,
} from "@qualigence/desktop-windows-uia";
import type { UiaSource } from "@qualigence/desktop-windows-uia";

function descriptorFor(
  action: ResolvedDesktopAction,
  risk: ExecutionPermitDescriptor["risk"] = "Normal",
  decisionId = "dec-1",
): ExecutionPermitDescriptor {
  const policyId = "policy-1";
  const expiresAt = "2026-08-02T00:10:00.000Z";
  return {
    decisionId,
    policyId,
    actionDigestSha256: runnerPolicyActionDigestSha256({
      runId: context.runId,
      action,
      decisionId,
      policyId,
      risk,
      expiresAt,
    }),
    risk,
    expiresAt,
  };
}

function permitFor(desc: ExecutionPermitDescriptor | undefined): ExecutionPermit {
  const decision: PolicyDecision = {
    status: "allowed",
    reason: "auto",
    ...(desc === undefined ? {} : { descriptor: desc }),
  };
  return ExecutionPermit.fromAllowedDecision(decision);
}

const clickAction: ResolvedDesktopAction = {
  targetKind: "desktop",
  kind: "click",
  actionId: "act-1",
  graphId: "graph-1",
  nodeId: "button",
  resolution: "semantic",
  uiaPattern: "Invoke",
};

const issuedPermit: LocalExecutionPermit = {
  permitToken: "token-1",
  nonceBase64: "nonce",
  sessionId: "sess-1",
  runId: "run-1",
  actionId: "act-1",
  actionDigestSha256: "a".repeat(64),
  graphId: "graph-1",
  risk: "Normal",
  issuedAt: "2026-08-02T00:00:00.000Z",
  expiresAt: "2026-08-02T00:10:00.000Z",
};

class ScriptedCompanion implements CompanionClient {
  readonly log: string[] = [];
  permitRequests: LocalPermitRequest[] = [];
  executeRequests: DesktopActionExecuteRequest[] = [];
  private decision: LocalApprovalDecision;
  private executeOutcome: ActionOutcomeReport | (() => Promise<ActionOutcomeReport>);
  private consumed = false;

  constructor(
    decision: LocalApprovalDecision,
    executeOutcome: ActionOutcomeReport | (() => Promise<ActionOutcomeReport>) = { status: "ok" },
  ) {
    this.decision = decision;
    this.executeOutcome = executeOutcome;
  }

  async launch(_target: AppTarget): Promise<AppSession> {
    throw new Error("not used");
  }
  async reset(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async capture(_request: UiaCaptureRequest): Promise<UiaSource> {
    throw new Error("not used");
  }
  async requestPermit(request: LocalPermitRequest): Promise<LocalApprovalDecision> {
    this.log.push("requestPermit");
    this.permitRequests.push(request);
    if (this.decision.status !== "approved") return this.decision;
    return {
      ...this.decision,
      permit: {
        ...this.decision.permit,
        nonceBase64: request.authorization.nonceBase64 ?? this.decision.permit.nonceBase64,
        sessionId: request.sessionId,
        runId: request.runId,
        actionId: request.action.actionId,
        actionDigestSha256: request.authorization.actionDigestSha256,
        graphId: request.action.graphId,
        decisionId: request.authorization.decisionId,
        policyId: request.authorization.policyId,
        risk: request.authorization.risk,
        expiresAt: request.authorization.expiresAt,
        ...(request.authorization.valueBinding === undefined ? {} : { valueBinding: request.authorization.valueBinding }),
      },
    };
  }
  async execute(request: DesktopActionExecuteRequest): Promise<ActionOutcomeReport> {
    this.log.push("execute");
    this.executeRequests.push(request);
    // A one-time Permit: a second execute with the same token fails closed.
    if (this.consumed) {
      throw new DesktopExecutionError("ActionFailed", "LocalPermitConsumed");
    }
    this.consumed = true;
    if (typeof this.executeOutcome === "function") {
      return this.executeOutcome();
    }
    return this.executeOutcome;
  }
}

const context = { sessionId: "sess-1", runId: "run-1", deadlineMs: 5000 };
const descriptor = descriptorFor(clickAction);

describe("UiaActionExecutor", () => {
  it("does not support a Web action", () => {
    const companion = new ScriptedCompanion({
      status: "approved",
      approvalId: "run-1:act-1",
      decidedAt: "2026-08-02T00:00:01.000Z",
      permit: issuedPermit,
    });
    const executor = new UiaActionExecutor(companion, context);
    const webAction: ResolvedWebAction = {
      targetKind: "web",
      kind: "click",
      target: { nodeId: "n1", selector: "#a" },
      graphId: "graph-1",
    };
    expect(executor.supports(webAction)).toBe(false);
  });

  it("refuses to execute a Web action and never contacts the Companion", async () => {
    const companion = new ScriptedCompanion({
      status: "approved",
      approvalId: "run-1:act-1",
      decidedAt: "2026-08-02T00:00:01.000Z",
      permit: issuedPermit,
    });
    const executor = new UiaActionExecutor(companion, context);
    const webAction: ResolvedWebAction = {
      targetKind: "web",
      kind: "click",
      target: { nodeId: "n1", selector: "#a" },
      graphId: "graph-1",
    };
    await expect(executor.execute(webAction, permitFor(descriptor))).rejects.toMatchObject({
      code: "UnsupportedTargetKind",
    });
    expect(companion.log).toEqual([]);
  });

  it("brokers a desktop action: requestPermit THEN execute", async () => {
    const companion = new ScriptedCompanion({
      status: "approved",
      approvalId: "run-1:act-1",
      decidedAt: "2026-08-02T00:00:01.000Z",
      permit: issuedPermit,
    });
    const executor = new UiaActionExecutor(companion, context);

    const outcome = await executor.execute(clickAction, permitFor(descriptor));
    expect(outcome).toEqual({ status: "ok" });
    expect(companion.log).toEqual(["requestPermit", "execute"]);

    // The descriptor identity fields plus session/run/action are bound into the local authorization digest.
    expect(companion.permitRequests[0]?.authorization).toMatchObject({
      decisionId: "dec-1",
      policyId: "policy-1",
      risk: "Normal",
    });
    expect(companion.permitRequests[0]?.authorization.actionDigestSha256).toBe(
      desktopActionDigestSha256({
        sessionId: context.sessionId,
        runId: context.runId,
        action: clickAction,
        decisionId: "dec-1",
        policyId: "policy-1",
        risk: "Normal",
        expiresAt: descriptor.expiresAt,
        nonceBase64: companion.permitRequests[0]!.authorization.nonceBase64!,
      }),
    );
  });

  it("binds Desktop input plaintext only inside action.execute", () => {
    const action: ResolvedDesktopAction = {
      targetKind: "desktop",
      kind: "input",
      actionId: "act-input",
      graphId: "graph-1",
      nodeId: "email",
      resolution: "semantic",
      uiaPattern: "Value",
      valueRef: "profile.email",
    };
    const value = desktopValueBindingForPlaintext(action.valueRef, "alice@example.test");
    const valueBinding = { valueRef: value.valueRef, valueSha256: value.valueSha256, valueByteLength: value.valueByteLength };
    const authorization = {
      decisionId: "dec-input",
      policyId: "policy-1",
      risk: "ExternalSideEffect" as const,
      expiresAt: descriptor.expiresAt,
      nonceBase64: issuedPermit.nonceBase64,
      valueBinding,
      actionDigestSha256: desktopActionDigestSha256({
        sessionId: context.sessionId,
        runId: context.runId,
        action,
        decisionId: "dec-input",
        policyId: "policy-1",
        risk: "ExternalSideEffect",
        expiresAt: descriptor.expiresAt,
        nonceBase64: issuedPermit.nonceBase64,
        valueBinding,
      }),
    };
    const permit: LocalExecutionPermit = {
      ...issuedPermit,
      actionId: action.actionId,
      actionDigestSha256: authorization.actionDigestSha256,
      decisionId: authorization.decisionId,
      policyId: authorization.policyId,
      risk: "ExternalSideEffect",
      valueBinding,
    };

    expect(() => createCompanionRequestEnvelope("req-permit", "permit.request", {
      request: {
        approvalId: "run-1:act-input",
        sessionId: context.sessionId,
        runId: context.runId,
        action,
        authorization,
        safeSummary: "input on email",
        expiresAt: descriptor.expiresAt,
      },
    })).not.toThrow();

    const dispatch = createCompanionRequestEnvelope("req-exec", "action.execute", {
      sessionId: context.sessionId,
      action,
      permit,
      deadlineMs: context.deadlineMs,
      value,
    });
    expect(dispatch.payload.value?.plaintext).toBe("alice@example.test");
  });

  it("rejects missing binding, mismatched plaintext, oversize values, plaintext outside dispatch, and unknown fields", () => {
    const action: ResolvedDesktopAction = {
      targetKind: "desktop",
      kind: "select",
      actionId: "act-select",
      graphId: "graph-1",
      nodeId: "country",
      resolution: "semantic",
      uiaPattern: "Selection",
      valueRef: "profile.country",
    };
    const value = desktopValueBindingForPlaintext(action.valueRef, "Canada");
    const valueBinding = { valueRef: value.valueRef, valueSha256: value.valueSha256, valueByteLength: value.valueByteLength };
    const digest = desktopActionDigestSha256({
      sessionId: context.sessionId,
      runId: context.runId,
      action,
      decisionId: "dec-select",
      policyId: "policy-1",
      risk: "ExternalSideEffect",
      expiresAt: descriptor.expiresAt,
      nonceBase64: issuedPermit.nonceBase64,
      valueBinding,
    });
    const permit = { ...issuedPermit, actionId: action.actionId, actionDigestSha256: digest, decisionId: "dec-select", policyId: "policy-1", risk: "ExternalSideEffect" as const, valueBinding };

    expect(() => parseCompanionRequest({
      protocolMajor: 1,
      requestId: "missing-binding",
      type: "permit.request",
      payload: {
        request: {
          approvalId: "run-1:act-select",
          sessionId: context.sessionId,
          runId: context.runId,
          action,
          authorization: { decisionId: "dec-select", policyId: "policy-1", actionDigestSha256: digest, risk: "ExternalSideEffect", expiresAt: descriptor.expiresAt, nonceBase64: issuedPermit.nonceBase64 },
          safeSummary: "select country",
          expiresAt: descriptor.expiresAt,
        },
      },
    })).toThrow(/value binding/i);

    expect(() => parseCompanionRequest({
      protocolMajor: 1,
      requestId: "mismatch",
      type: "action.execute",
      payload: {
        sessionId: context.sessionId,
        action,
        permit,
        deadlineMs: context.deadlineMs,
        value: { ...value, valueSha256: "b".repeat(64) },
      },
    })).toThrow(/plaintext does not match|dispatch value/i);

    expect(() => desktopValueBindingForPlaintext("too.big", "x".repeat(COMPANION_IPC_LIMITS.maxPlaintextValueBytes + 1))).toThrow(/exceeds/);

    expect(() => parseCompanionRequest({
      protocolMajor: 1,
      requestId: "plaintext-outside-dispatch",
      type: "permit.request",
      payload: {
        request: {
          approvalId: "run-1:act-select",
          sessionId: context.sessionId,
          runId: context.runId,
          action,
          authorization: { decisionId: "dec-select", policyId: "policy-1", actionDigestSha256: digest, risk: "ExternalSideEffect", expiresAt: descriptor.expiresAt, nonceBase64: issuedPermit.nonceBase64, valueBinding },
          safeSummary: "select country",
          expiresAt: descriptor.expiresAt,
          value,
        },
      },
    })).toThrow(/known field/);

    expect(() => parseCompanionRequest({
      protocolMajor: 1,
      requestId: "unknown-field",
      type: "action.execute",
      payload: {
        sessionId: context.sessionId,
        action,
        permit,
        deadlineMs: context.deadlineMs,
        value,
        durablePlaintextCopy: value.plaintext,
      },
    })).toThrow(/known field/);
  });

  it("resolves Desktop plaintext again only at dispatch after approval", async () => {
    const action: ResolvedDesktopAction = {
      targetKind: "desktop",
      kind: "input",
      actionId: "act-input-runtime",
      graphId: "graph-1",
      nodeId: "email",
      resolution: "semantic",
      uiaPattern: "Value",
      valueRef: "profile.email",
    };
    const companion = new ScriptedCompanion({
      status: "approved",
      approvalId: "run-1:act-input-runtime",
      decidedAt: "2026-08-02T00:00:01.000Z",
      permit: issuedPermit,
    });
    const valueProvider = { resolve: vi.fn(async () => "alice@example.test") };
    const executor = new UiaActionExecutor(companion, { ...context, valueProvider });

    await expect(executor.execute(action, permitFor(descriptorFor(action, "ExternalSideEffect", "dec-input-runtime")))).resolves.toEqual({ status: "ok" });

    expect(valueProvider.resolve).toHaveBeenCalledTimes(2);
    expect(companion.permitRequests[0]?.authorization.valueBinding).toMatchObject({ valueRef: "profile.email" });
    expect(companion.permitRequests[0]).not.toHaveProperty("value");
    expect(companion.executeRequests[0]?.value?.plaintext).toBe("alice@example.test");
  });

  it("rejects action.execute permit substitutions across session, action, graph, digest, and nonce", () => {
    const nonceBase64 = "nonce-strict";
    const permit: LocalExecutionPermit = {
      ...issuedPermit,
      nonceBase64,
      decisionId: "dec-1",
      policyId: "policy-1",
      expiresAt: descriptor.expiresAt,
      actionDigestSha256: desktopActionDigestSha256({
        sessionId: context.sessionId,
        runId: context.runId,
        action: clickAction,
        decisionId: "dec-1",
        policyId: "policy-1",
        risk: "Normal",
        expiresAt: descriptor.expiresAt,
        nonceBase64,
      }),
    };
    const payload = {
      sessionId: context.sessionId,
      action: clickAction,
      permit,
      deadlineMs: context.deadlineMs,
    };

    expect(() => createCompanionRequestEnvelope("strict-ok", "action.execute", payload)).not.toThrow();
    expect(() => createCompanionRequestEnvelope("strict-session", "action.execute", {
      ...payload,
      sessionId: "sess-other",
    })).toThrow(/sessionId/i);
    expect(() => createCompanionRequestEnvelope("strict-action", "action.execute", {
      ...payload,
      action: { ...clickAction, actionId: "act-other" },
    })).toThrow(/actionId/i);
    expect(() => createCompanionRequestEnvelope("strict-graph", "action.execute", {
      ...payload,
      action: { ...clickAction, graphId: "graph-other" },
    })).toThrow(/graphId/i);
    expect(() => createCompanionRequestEnvelope("strict-nonce", "action.execute", {
      ...payload,
      permit: { ...permit, nonceBase64: "nonce-other" },
    })).toThrow(/actionDigestSha256/i);
    expect(() => createCompanionRequestEnvelope("strict-digest", "action.execute", {
      ...payload,
      permit: { ...permit, actionDigestSha256: "b".repeat(64) },
    })).toThrow(/actionDigestSha256/i);
  });

  it("marks the kernel dispatch boundary before sending action.execute", async () => {
    const companion = new ScriptedCompanion({
      status: "approved",
      approvalId: "run-1:act-1",
      decidedAt: "2026-08-02T00:00:01.000Z",
      permit: issuedPermit,
    }, async () => {
      throw new DesktopExecutionError("ActionOutcomeUnknown", "pipe closed after dispatch");
    });
    const executor = new UiaActionExecutor(companion, context);
    const kernelPermit = permitFor(descriptor);

    await expect(executor.execute(clickAction, kernelPermit)).rejects.toMatchObject({ code: "ActionOutcomeUnknown" });
    expect(companion.log).toEqual(["requestPermit", "execute"]);
    expect(kernelPermit.dispatchStarted).toBe(true);
  });

  it("requires a policy-bound descriptor before contacting the Companion", async () => {
    const companion = new ScriptedCompanion({
      status: "approved",
      approvalId: "run-1:act-1",
      decidedAt: "2026-08-02T00:00:01.000Z",
      permit: issuedPermit,
    });
    const executor = new UiaActionExecutor(companion, context);
    await expect(executor.execute(clickAction, permitFor(undefined))).rejects.toMatchObject({
      code: "MissingPermitDescriptor",
    });
    expect(companion.log).toEqual([]);
  });

  it("never reaches the worker when the Companion denies approval", async () => {
    const companion = new ScriptedCompanion({
      status: "denied",
      approvalId: "run-1:act-1",
      decidedAt: "2026-08-02T00:00:01.000Z",
    });
    const executor = new UiaActionExecutor(companion, context);
    await expect(executor.execute(clickAction, permitFor(descriptor))).rejects.toMatchObject({
      code: "LocalPermitDenied",
    });
    expect(companion.log).toEqual(["requestPermit"]);
  });

  it("maps an emergency-stopped decision to a stable error before the worker", async () => {
    const companion = new ScriptedCompanion({
      status: "emergency_stopped",
      approvalId: "run-1:act-1",
      decidedAt: "2026-08-02T00:00:01.000Z",
    });
    const executor = new UiaActionExecutor(companion, context);
    await expect(executor.execute(clickAction, permitFor(descriptor))).rejects.toMatchObject({
      code: "EmergencyStopped",
    });
    expect(companion.log).toEqual(["requestPermit"]);
  });

  it("propagates a non-replayable ActionOutcomeUnknown on worker timeout", async () => {
    const companion = new ScriptedCompanion(
      {
        status: "approved",
        approvalId: "run-1:act-1",
        decidedAt: "2026-08-02T00:00:01.000Z",
        permit: issuedPermit,
      },
      async () => {
        throw new DesktopExecutionError("ActionOutcomeUnknown", "worker timed out");
      },
    );
    const executor = new UiaActionExecutor(companion, context);
    await expect(executor.execute(clickAction, permitFor(descriptor))).rejects.toMatchObject({
      code: "ActionOutcomeUnknown",
    });
  });
});
