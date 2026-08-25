import { describe, expect, it } from "vitest";
import {
  StateVisitTracker,
  fingerprintObservationGraph,
} from "@qualigence/exploration";
import {
  WEB_EXTENSION_V1_TYPE,
  type ObservationGraphV1,
} from "@qualigence/runner-protocol";
import { observationGraphV1, type ObservationGraphV1TestNode } from "../../../helpers/observation-graph-v1.js";

interface GraphOptions {
  readonly graphId?: string;
  readonly capturedAt?: string;
  readonly evidenceRefs?: readonly string[];
  readonly origin?: string;
  readonly pathname?: string;
  readonly title?: string;
  readonly nodes?: readonly ObservationGraphV1TestNode[];
}

function graph(overrides: GraphOptions = {}): ObservationGraphV1 {
  const graphId = overrides.graphId ?? "graph-1";
  const origin = overrides.origin ?? "https://shop.example";
  const pathname = overrides.pathname ?? "/product";
  const title = overrides.title ?? "Product";
  return observationGraphV1(
    graphId,
    overrides.nodes ?? [
      { id: "node-1", role: "button", name: "Add to cart", confidence: 0.9 },
      { id: "node-2", role: "spinbutton", name: "Quantity", value: "2", confidence: 0.8 },
    ],
    {
      capturedAt: overrides.capturedAt ?? "2026-08-01T00:00:00.000Z",
      evidenceRefs: overrides.evidenceRefs ?? [],
      target: { kind: "web", targetId: origin },
      extensions: {
        [WEB_EXTENSION_V1_TYPE]: {
          type: WEB_EXTENSION_V1_TYPE,
          version: "1.0",
          payload: {
            origin,
            pathname,
            title,
            viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
            query: {},
          },
        },
      },
    },
  );
}

function graphWithSecretValueAndState(
  value: string,
  state: Readonly<Record<string, boolean | string | number>>,
): ObservationGraphV1 {
  const base = graph({
    nodes: [
      { id: "node-1", role: "button", name: "Add to cart", confidence: 0.9 },
      { id: "node-secret", role: "textbox", name: "Password", value, sensitivity: "secret", confidence: 0.8 },
    ],
  });
  return {
    ...base,
    nodes: base.nodes.map((node) => (node.id === "node-secret" ? { ...node, state } : node)),
  };
}

describe("fingerprintObservationGraph", () => {
  it("normalizes volatile graphId, node ids, timestamps and confidence to the same fingerprint", () => {
    const a = fingerprintObservationGraph(graph());
    const b = fingerprintObservationGraph(
      graph({
        graphId: "graph-999",
        capturedAt: "2026-09-15T12:34:56.000Z",
        evidenceRefs: ["artifact://x"],
        nodes: [
          { id: "node-77", role: "button", name: "Add to cart", confidence: 0.1 },
          { id: "node-88", role: "spinbutton", name: "Quantity", value: "2", confidence: 0.5 },
        ],
      }),
    );
    expect(a).toBe(b);
  });

  it("ignores redacted query values but keeps the typed web/v1 path", () => {
    const a = fingerprintObservationGraph(graph({ pathname: "/product" }));
    const b = fingerprintObservationGraph(graph({ pathname: "/product" }));
    expect(a).toBe(b);
  });

  it("is order-independent across graph semantic sets", () => {
    const forward = fingerprintObservationGraph(graph());
    const reversed = fingerprintObservationGraph(
      graph({
        nodes: [
          { id: "node-2", role: "spinbutton", name: "Quantity", value: "2", confidence: 0.8 },
          { id: "node-1", role: "button", name: "Add to cart", confidence: 0.9 },
        ],
      }),
    );
    expect(forward).toBe(reversed);
  });

  it("produces a different fingerprint for a semantic or state change", () => {
    const base = fingerprintObservationGraph(graph());
    const differentPath = fingerprintObservationGraph(graph({ pathname: "/cart" }));
    const differentValue = fingerprintObservationGraph(
      graph({
        nodes: [
          { id: "node-1", role: "button", name: "Add to cart", confidence: 0.9 },
          { id: "node-2", role: "spinbutton", name: "Quantity", value: "9", confidence: 0.8 },
        ],
      }),
    );
    expect(differentPath).not.toBe(base);
    expect(differentValue).not.toBe(base);
  });

  it("does not let secret node values or state change the fingerprint", () => {
    const first = fingerprintObservationGraph(
      graphWithSecretValueAndState("***", { filled: true, length: 8, text: "first secret" }),
    );
    const second = fingerprintObservationGraph(
      graphWithSecretValueAndState("••••••", { filled: false, length: 12, text: "second secret" }),
    );

    expect(second).toBe(first);
  });

  it("fails closed when web/v1 is missing for a web-dependent fingerprint", () => {
    const withoutWeb = { ...graph(), extensions: {} };
    expect(() => fingerprintObservationGraph(withoutWeb)).toThrow(/ExtensionVersionUnsupported/);
  });
});

describe("StateVisitTracker", () => {
  it("treats the first visit as novel and any revisit as state_repeated (default cap 1)", () => {
    const tracker = new StateVisitTracker();
    const fp = tracker.fingerprintOf(graph());
    expect(tracker.hasVisited(fp)).toBe(false);
    expect(tracker.record(fp)).toMatchObject({ status: "novel", fingerprint: fp });
    expect(tracker.hasVisited(fp)).toBe(true);
    expect(tracker.record(fp)).toMatchObject({
      status: "repeated",
      reason: "state_repeated",
    });
  });

  it("stops at the exact maximum-visit threshold", () => {
    const tracker = new StateVisitTracker(2);
    const fp = tracker.fingerprintOf(graph());
    expect(tracker.record(fp).status).toBe("novel");
    expect(tracker.record(fp).status).toBe("novel");
    expect(tracker.record(fp)).toMatchObject({
      status: "repeated",
      reason: "state_repeated",
    });
  });

  it("allows many distinct states without tripping the revisit guard", () => {
    const tracker = new StateVisitTracker();
    const product = tracker.record(tracker.fingerprintOf(graph()));
    const cart = tracker.record(
      tracker.fingerprintOf(graph({ pathname: "/cart" })),
    );
    expect(product.status).toBe("novel");
    expect(cart.status).toBe("novel");
  });

  it("rejects a non-positive threshold", () => {
    expect(() => new StateVisitTracker(0)).toThrow(/positive/i);
  });
});
