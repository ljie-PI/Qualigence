import { describe, expect, it } from "vitest";
import {
  mapUiaPayloadToObservationV1,
  type UiaSource,
} from "@qualigence/desktop-windows-uia";
import type { ObservationGraphV1, ObservationNodeV1 } from "@qualigence/observation-contracts";

const goldenPayload: UiaSource = {
  sessionId: "sess-golden",
  capturedAt: "2026-08-02T00:00:00.000Z",
  rootNodeIds: ["window"],
  nodes: [
    {
      nodeId: "window",
      role: "window",
      controlTypeId: 50032,
      name: "Reference App",
      automationId: "MainWindow",
      frameworkId: "WPF",
      className: "HwndWrapper",
      nativeWindowHandle: "0x00010",
      processId: 4242,
      isOffscreen: false,
      isKeyboardFocusable: false,
      hasKeyboardFocus: false,
      isPassword: false,
      patterns: [{ pattern: "Window", available: true, readOnly: false }],
      children: ["button", "username", "password", "list"],
    },
    {
      nodeId: "button",
      role: "button",
      controlTypeId: 50000,
      name: "Submit",
      automationId: "SubmitButton",
      frameworkId: "WPF",
      className: "Button",
      processId: 4242,
      isOffscreen: false,
      isKeyboardFocusable: true,
      hasKeyboardFocus: false,
      isPassword: false,
      bounds: { x: 10, y: 20, width: 80, height: 24 },
      patterns: [{ pattern: "Invoke", available: true }],
      children: [],
    },
    {
      nodeId: "username",
      role: "textbox",
      controlTypeId: 50004,
      name: "Username",
      value: "alice",
      automationId: "UsernameEdit",
      frameworkId: "WPF",
      className: "TextBox",
      processId: 4242,
      isOffscreen: false,
      isKeyboardFocusable: true,
      hasKeyboardFocus: true,
      isPassword: false,
      patterns: [{ pattern: "Value", available: true, readOnly: false }],
      children: [],
    },
    {
      nodeId: "password",
      role: "textbox",
      controlTypeId: 50004,
      name: "Password",
      // Already masked by the Companion worker before it reached TypeScript.
      value: "••••",
      automationId: "PasswordEdit",
      frameworkId: "WPF",
      className: "PasswordBox",
      processId: 4242,
      isOffscreen: false,
      isKeyboardFocusable: true,
      hasKeyboardFocus: false,
      isPassword: true,
      patterns: [{ pattern: "Value", available: true, readOnly: false }],
      children: [],
    },
    {
      nodeId: "list",
      role: "list",
      controlTypeId: 50008,
      name: "Results",
      automationId: "ResultsList",
      frameworkId: "WPF",
      className: "ListBox",
      processId: 4242,
      isOffscreen: true,
      isKeyboardFocusable: true,
      hasKeyboardFocus: false,
      isPassword: false,
      patterns: [
        { pattern: "Selection", available: true, readOnly: false },
        { pattern: "Scroll", available: true },
      ],
      children: [],
    },
  ],
};

function node(graph: ObservationGraphV1, id: string): ObservationNodeV1 {
  const found = graph.nodes.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`node ${id} missing`);
  }
  return found;
}

describe("mapUiaPayloadToObservationV1", () => {
  it("maps a uia/v1 source into a validated Observation Graph v1", () => {
    const graph = mapUiaPayloadToObservationV1(goldenPayload, {
      adapterId: "desktop-windows-uia",
    });

    expect(graph.schema).toEqual({ epoch: "v1", version: "observation-graph/v1" });
    expect(graph.target).toEqual({ kind: "app", targetId: "sess-golden" });
    expect(graph.rootNodeIds).toEqual(["window"]);
    expect(graph.nodes).toHaveLength(5);
  });

  it("preserves every UIA-specific fact inside the uia/v1 extension", () => {
    const graph = mapUiaPayloadToObservationV1(goldenPayload, {
      adapterId: "desktop-windows-uia",
    });
    const button = node(graph, "button");
    const extension = button.extensions["uia/v1"];
    expect(extension.type).toBe("uia/v1");
    expect(extension.version).toBe("1.0");
    expect(extension.payload).toMatchObject({
      controlTypeId: 50000,
      automationId: "SubmitButton",
      frameworkId: "WPF",
      className: "Button",
      processId: 4242,
      isKeyboardFocusable: true,
    });
    expect(Array.isArray(extension.payload.patterns)).toBe(true);
  });

  it("maps common facts (role, name, state, bounds, child relations) into the core", () => {
    const graph = mapUiaPayloadToObservationV1(goldenPayload, {
      adapterId: "desktop-windows-uia",
    });
    const window = node(graph, "window");
    expect(window.relations).toEqual([
      { type: "child", targetNodeId: "button" },
      { type: "child", targetNodeId: "username" },
      { type: "child", targetNodeId: "password" },
      { type: "child", targetNodeId: "list" },
    ]);
    expect(window.source).toEqual({ adapterId: "desktop-windows-uia", sourceKind: "uia" });

    const button = node(graph, "button");
    expect(button.bounds).toEqual({ x: 10, y: 20, width: 80, height: 24 });

    const list = node(graph, "list");
    expect(list.state.offscreen).toBe(true);

    const username = node(graph, "username");
    expect(username.value).toBe("alice");
    expect(username.state.keyboardFocused).toBe(true);
  });

  it("maps a password control to a secret node with no recoverable value", () => {
    const graph = mapUiaPayloadToObservationV1(goldenPayload, {
      adapterId: "desktop-windows-uia",
    });
    const password = node(graph, "password");
    expect(password.sensitivity).toBe("secret");
    expect(password.value).toBeUndefined();
  });

  it("attaches provided evidence refs to the graph", () => {
    const graph = mapUiaPayloadToObservationV1(goldenPayload, {
      adapterId: "desktop-windows-uia",
      evidenceRefs: ["artifact://uia-source/sess-golden"],
    });
    expect(graph.evidenceRefs).toEqual(["artifact://uia-source/sess-golden"]);
  });
});
