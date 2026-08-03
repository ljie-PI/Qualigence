import { describe, expect, it } from "vitest";
import {
  StateVisitTracker,
  fingerprintObservationGraph,
} from "@qualigence/exploration";
import type { ObservationGraph } from "@qualigence/runner-protocol";

function graph(overrides: Partial<ObservationGraph> = {}): ObservationGraph {
  return {
    graphId: "graph-1",
    url: "https://shop.example/product?ref=abc",
    title: "Product",
    capturedAt: "2026-08-01T00:00:00.000Z",
    nodes: [
      { id: "node-1", role: "button", name: "Add to cart", confidence: 0.9 },
      { id: "node-2", role: "spinbutton", name: "Quantity", value: "2", confidence: 0.8 },
    ],
    ...overrides,
  };
}

describe("fingerprintObservationGraph", () => {
  it("normalizes volatile graphId, node ids, timestamps and confidence to the same fingerprint", () => {
    const a = fingerprintObservationGraph(graph());
    const b = fingerprintObservationGraph(
      graph({
        graphId: "graph-999",
        capturedAt: "2026-09-15T12:34:56.000Z",
        artifactRefs: ["artifact://x"],
        nodes: [
          { id: "node-77", role: "button", name: "Add to cart", confidence: 0.1 },
          { id: "node-88", role: "spinbutton", name: "Quantity", value: "2", confidence: 0.5 },
        ],
      }),
    );
    expect(a).toBe(b);
  });

  it("ignores the query string but keeps the URL path", () => {
    const a = fingerprintObservationGraph(graph({ url: "https://shop.example/product?x=1" }));
    const b = fingerprintObservationGraph(graph({ url: "https://shop.example/product?y=2" }));
    expect(a).toBe(b);
  });

  it("is order-independent across nodes", () => {
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
    const differentPath = fingerprintObservationGraph(graph({ url: "https://shop.example/cart" }));
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
      tracker.fingerprintOf(graph({ url: "https://shop.example/cart" })),
    );
    expect(product.status).toBe("novel");
    expect(cart.status).toBe("novel");
  });

  it("rejects a non-positive threshold", () => {
    expect(() => new StateVisitTracker(0)).toThrow(/positive/i);
  });
});
