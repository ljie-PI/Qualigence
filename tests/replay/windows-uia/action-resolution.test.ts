import { describe, expect, it } from "vitest";
import {
  UiaActionResolver,
  UiaResolutionError,
  mapUiaPayloadToObservationV1,
  type UiaSource,
} from "@qualigence/desktop-windows-uia";
import type { ProposedAction } from "@qualigence/runner-kernel";

const source: UiaSource = {
  sessionId: "sess-resolve",
  capturedAt: "2026-08-02T00:00:00.000Z",
  rootNodeIds: ["window"],
  nodes: [
    {
      nodeId: "window",
      role: "window",
      controlTypeId: 50032,
      name: "Reference App",
      processId: 7,
      isOffscreen: false,
      isKeyboardFocusable: false,
      hasKeyboardFocus: false,
      isPassword: false,
      patterns: [{ pattern: "Window", available: true }],
      children: ["button", "label"],
    },
    {
      nodeId: "button",
      role: "button",
      controlTypeId: 50000,
      name: "Submit",
      processId: 7,
      isOffscreen: false,
      isKeyboardFocusable: true,
      hasKeyboardFocus: false,
      isPassword: false,
      patterns: [{ pattern: "Invoke", available: true }],
      children: [],
    },
    {
      nodeId: "label",
      role: "text",
      controlTypeId: 50020,
      name: "Static text",
      processId: 7,
      isOffscreen: false,
      isKeyboardFocusable: false,
      hasKeyboardFocus: false,
      isPassword: false,
      patterns: [],
      children: [],
    },
  ],
};

const graph = mapUiaPayloadToObservationV1(source, { adapterId: "desktop-windows-uia" });

function clickProposal(nodeId: string): ProposedAction {
  return { kind: "click", target: { nodeId }, reason: "test" };
}

describe("UiaActionResolver", () => {
  it("resolves a semantic click to the Invoke pattern", () => {
    const resolver = new UiaActionResolver();
    const resolved = resolver.resolve(clickProposal("button"), graph, { actionId: "act-1" });

    expect(resolved).toMatchObject({
      targetKind: "desktop",
      kind: "click",
      actionId: "act-1",
      graphId: graph.graphId,
      nodeId: "button",
      resolution: "semantic",
      uiaPattern: "Invoke",
    });
  });

  it("fails with PlanDiverged when the proposed node is no longer present", () => {
    const resolver = new UiaActionResolver();
    try {
      resolver.resolve(clickProposal("ghost"), graph, { actionId: "act-1" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UiaResolutionError);
      expect((error as UiaResolutionError).code).toBe("PlanDiverged");
    }
  });

  it("fails with UiaPatternUnsupported when the node cannot be invoked", () => {
    const resolver = new UiaActionResolver();
    try {
      resolver.resolve(clickProposal("label"), graph, { actionId: "act-1" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(UiaResolutionError);
      expect((error as UiaResolutionError).code).toBe("UiaPatternUnsupported");
    }
  });
});
