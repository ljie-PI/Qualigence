import { describe, expect, it } from "vitest";
import {
  ExecutionPermit,
  classifyDesktopActionRisk,
  isDesktopAction,
  isWebAction,
  type ExecutionPermitDescriptor,
  type PolicyDecision,
  type ResolvedAction,
  type ResolvedDesktopAction,
  type ResolvedWebAction,
} from "@qualigence/runner-kernel";

const webAction: ResolvedWebAction = {
  targetKind: "web",
  kind: "click",
  target: { nodeId: "node-1", selector: "text=Login" },
  graphId: "graph-1",
};

const legacyWebAction: ResolvedAction = {
  kind: "click",
  target: { nodeId: "node-1", selector: "text=Login" },
  graphId: "graph-1",
};

function desktopAction(
  overrides: Partial<ResolvedDesktopAction> = {},
): ResolvedDesktopAction {
  return {
    targetKind: "desktop",
    kind: "click",
    actionId: "act-1",
    graphId: "graph-1",
    nodeId: "node-1",
    resolution: "semantic",
    ...overrides,
  } as ResolvedDesktopAction;
}

describe("targetKind discriminator", () => {
  it("narrows web and desktop resolved actions", () => {
    expect(isWebAction(webAction)).toBe(true);
    expect(isDesktopAction(webAction)).toBe(false);
    expect(isWebAction(legacyWebAction)).toBe(true);

    const desktop = desktopAction();
    expect(isDesktopAction(desktop)).toBe(true);
    expect(isWebAction(desktop)).toBe(false);
  });

  it("classifies desktop action risk conservatively", () => {
    expect(classifyDesktopActionRisk(desktopAction({ kind: "click" }))).toBe("Normal");
    expect(
      classifyDesktopActionRisk(
        desktopAction({ kind: "scroll", direction: "down", amount: "page" } as Partial<ResolvedDesktopAction>),
      ),
    ).toBe("Normal");
    expect(
      classifyDesktopActionRisk(
        desktopAction({ kind: "window", windowOperation: "focus" } as Partial<ResolvedDesktopAction>),
      ),
    ).toBe("Normal");
    expect(
      classifyDesktopActionRisk(
        desktopAction({ kind: "input", valueRef: "secret:1" } as Partial<ResolvedDesktopAction>),
      ),
    ).toBe("ExternalSideEffect");
    expect(
      classifyDesktopActionRisk(
        desktopAction({ kind: "select", valueRef: "choice.delete" } as Partial<ResolvedDesktopAction>),
      ),
    ).toBe("ExternalSideEffect");
    expect(
      classifyDesktopActionRisk(
        desktopAction({ kind: "window", windowOperation: "close" } as Partial<ResolvedDesktopAction>),
      ),
    ).toBe("Destructive");
  });

  it("binds an execution permit descriptor built from an allowed policy decision", () => {
    const descriptor: ExecutionPermitDescriptor = {
      decisionId: "decision-1",
      policyId: "policy-1",
      actionDigestSha256: "a".repeat(64),
      risk: "ExternalSideEffect",
      expiresAt: "2026-08-02T00:00:00.000Z",
    };
    const decision: PolicyDecision = {
      status: "allowed",
      reason: "approved",
      descriptor,
    };
    const permit = ExecutionPermit.fromAllowedDecision(decision);
    expect(permit.descriptor).toEqual(descriptor);
  });

  it("still constructs a permit from a bare allowed decision (web M1 path)", () => {
    const permit = ExecutionPermit.fromAllowedDecision({
      status: "allowed",
      reason: "auto",
    });
    expect(permit.descriptor).toBeUndefined();
    expect(permit.reason).toBe("auto");
  });

  it("rejects constructing a permit from a denied decision", () => {
    expect(() =>
      ExecutionPermit.fromAllowedDecision({ status: "denied", reason: "no" }),
    ).toThrow();
  });
});
