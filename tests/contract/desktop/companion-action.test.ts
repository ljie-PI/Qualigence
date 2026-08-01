import { describe, expect, it } from "vitest";
import type {
  AppSession,
  AppTarget,
  LocalApprovalDecision,
  LocalExecutionPermit,
  LocalPermitRequest,
  ResolvedDesktopAction,
} from "@qualigence/desktop-contracts";
import {
  ExecutionPermit,
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

const descriptor: ExecutionPermitDescriptor = {
  decisionId: "dec-1",
  policyId: "policy-1",
  actionDigestSha256: "a".repeat(64),
  risk: "Normal",
  expiresAt: "2026-08-02T00:10:00.000Z",
};

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
    return this.decision;
  }
  async execute(_request: DesktopActionExecuteRequest): Promise<ActionOutcomeReport> {
    this.log.push("execute");
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

    // The descriptor was mapped onto the local authorization DTO.
    expect(companion.permitRequests[0]?.authorization).toMatchObject({
      decisionId: "dec-1",
      policyId: "policy-1",
      actionDigestSha256: "a".repeat(64),
      risk: "Normal",
    });
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
