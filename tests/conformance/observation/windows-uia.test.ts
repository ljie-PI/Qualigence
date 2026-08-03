import { describe, expect, it } from "vitest";
import {
  ObservationError,
  requireExtensionMajor,
  validateObservationGraphV1,
  type ObservationGraphV1,
} from "@qualigence/observation-contracts";
import {
  mapUiaPayloadToObservationV1,
  type UiaSource,
} from "@qualigence/desktop-windows-uia";

const minimalSource: UiaSource = {
  sessionId: "sess-conf",
  capturedAt: "2026-08-02T00:00:00.000Z",
  rootNodeIds: ["window"],
  nodes: [
    {
      nodeId: "window",
      role: "window",
      controlTypeId: 50032,
      name: "Reference App",
      automationId: "MainWindow",
      processId: 100,
      isOffscreen: false,
      isKeyboardFocusable: false,
      hasKeyboardFocus: false,
      isPassword: false,
      patterns: [{ pattern: "Window", available: true, readOnly: false }],
      children: ["button"],
    },
    {
      nodeId: "button",
      role: "button",
      controlTypeId: 50000,
      name: "Submit",
      processId: 100,
      isOffscreen: false,
      isKeyboardFocusable: true,
      hasKeyboardFocus: false,
      isPassword: false,
      patterns: [{ pattern: "Invoke", available: true }],
      children: [],
    },
  ],
};

describe("windows-uia conformance", () => {
  it("produces a graph that passes strict v1 validation", () => {
    const graph = mapUiaPayloadToObservationV1(minimalSource, {
      adapterId: "desktop-windows-uia",
    });
    expect(() => validateObservationGraphV1(graph)).not.toThrow();
  });

  it("round-trips an unknown minor field inside the uia/v1 extension payload", () => {
    const graph = mapUiaPayloadToObservationV1(minimalSource, {
      adapterId: "desktop-windows-uia",
    });
    // A consumer / newer producer adds an unknown minor field; the versioned
    // extension mechanism must carry it through validation untouched.
    const button = graph.nodes.find((n) => n.id === "button");
    if (button === undefined) {
      throw new Error("button node missing");
    }
    const buttonExt = button.extensions["uia/v1"];
    if (buttonExt === undefined) {
      throw new Error("button uia/v1 extension missing");
    }
    const augmented: ObservationGraphV1 = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === "button"
          ? {
              ...n,
              extensions: {
                "uia/v1": {
                  ...buttonExt,
                  payload: {
                    ...buttonExt.payload,
                    landmarkType: "form",
                  },
                },
              },
            }
          : n,
      ),
    };
    const validated = validateObservationGraphV1(augmented);
    const validatedButton = validated.nodes.find((n) => n.id === "button");
    expect(validatedButton?.extensions["uia/v1"]?.payload.landmarkType).toBe("form");
  });

  it("fails closed when a consumer requires an unsupported uia major", () => {
    const graph = mapUiaPayloadToObservationV1(minimalSource, {
      adapterId: "desktop-windows-uia",
    });
    const button = graph.nodes.find((n) => n.id === "button");
    if (button === undefined) {
      throw new Error("button node missing");
    }
    // The node carries uia/v1; a consumer that requires uia/v2 must reject it.
    expect(() => requireExtensionMajor(button, "uia", 2)).toThrow(ObservationError);
    // And the present major resolves cleanly.
    expect(requireExtensionMajor(button, "uia", 1).type).toBe("uia/v1");
  });
});
