import { describe, it, expect } from "vitest";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  canonicalObservationJson,
  observationGraphHash,
  validateObservationGraphV1,
  type ObservationGraphV1,
  type ObservationNodeV1,
} from "@qualigence/observation-contracts";

function node(overrides: Partial<ObservationNodeV1> = {}): ObservationNodeV1 {
  return {
    id: "n1",
    role: "button",
    state: {},
    relations: [],
    source: { adapterId: "web-playwright", sourceKind: "accessibility" },
    confidence: 1,
    sensitivity: "public",
    extensions: {},
    evidenceRefs: [],
    ...overrides,
  };
}

function graph(overrides: Partial<ObservationGraphV1> = {}): ObservationGraphV1 {
  return {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId: "g1",
    target: { kind: "web", targetId: "t1" },
    capturedAt: "2026-08-01T00:00:00.000Z",
    rootNodeIds: ["n1"],
    nodes: [node()],
    evidenceRefs: [],
    ...overrides,
  };
}

describe("canonical observation JSON and hash", () => {
  it("accepts a valid v1 graph", () => {
    expect(() => validateObservationGraphV1(graph())).not.toThrow();
  });

  it("sorts object keys so insertion order does not change the hash", () => {
    const a = graph();
    const reordered = {
      evidenceRefs: [],
      nodes: [node()],
      rootNodeIds: ["n1"],
      capturedAt: "2026-08-01T00:00:00.000Z",
      target: { targetId: "t1", kind: "web" as const },
      graphId: "g1",
      schema: OBSERVATION_GRAPH_V1_SCHEMA,
    } as ObservationGraphV1;
    expect(observationGraphHash(a)).toBe(observationGraphHash(reordered));
  });

  it("preserves array order (node order is meaningful)", () => {
    const g1 = graph({
      rootNodeIds: ["a", "b"],
      nodes: [node({ id: "a" }), node({ id: "b" })],
    });
    const g2 = graph({
      rootNodeIds: ["a", "b"],
      nodes: [node({ id: "b" }), node({ id: "a" })],
    });
    expect(observationGraphHash(g1)).not.toBe(observationGraphHash(g2));
  });

  it("normalises strings to NFC before hashing", () => {
    const composed = "é"; // U+00E9
    const decomposed = "e\u0301"; // e + combining acute
    const g1 = graph({ nodes: [node({ name: composed })] });
    const g2 = graph({ nodes: [node({ name: decomposed })] });
    expect(observationGraphHash(g1)).toBe(observationGraphHash(g2));
  });

  it("rejects non-finite numbers in canonical JSON", () => {
    expect(() => canonicalObservationJson({ x: Number.POSITIVE_INFINITY })).toThrow(
      "ObservationSchemaInvalid",
    );
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(() =>
      validateObservationGraphV1(graph({ nodes: [node({ confidence: 1.1 })] })),
    ).toThrow("ObservationSchemaInvalid");
  });

  it("rejects negative bounds", () => {
    expect(() =>
      validateObservationGraphV1(
        graph({
          nodes: [node({ bounds: { x: 0, y: 0, width: -1, height: 2 } })],
        }),
      ),
    ).toThrow("ObservationSchemaInvalid");
  });

  it("rejects a missing root node", () => {
    expect(() =>
      validateObservationGraphV1(graph({ rootNodeIds: ["ghost"] })),
    ).toThrow("DanglingNodeReference");
  });

  it("rejects a dangling relation target", () => {
    expect(() =>
      validateObservationGraphV1(
        graph({
          nodes: [
            node({ id: "n1", relations: [{ type: "child", targetNodeId: "n2" }] }),
          ],
        }),
      ),
    ).toThrow("DanglingNodeReference");
  });

  it("rejects duplicate node ids", () => {
    expect(() =>
      validateObservationGraphV1(
        graph({ rootNodeIds: ["n1"], nodes: [node({ id: "n1" }), node({ id: "n1" })] }),
      ),
    ).toThrow("ObservationSchemaInvalid");
  });

  it("rejects an unmasked secret value", () => {
    expect(() =>
      validateObservationGraphV1(
        graph({ nodes: [node({ sensitivity: "secret", value: "hunter2" })] }),
      ),
    ).toThrow("ObservationSchemaInvalid");
  });

  it("accepts a masked secret value", () => {
    expect(() =>
      validateObservationGraphV1(
        graph({ nodes: [node({ sensitivity: "secret", value: "••••••" })] }),
      ),
    ).not.toThrow();
  });

  it("rejects an unknown non-extension field", () => {
    const bad = graph();
    (bad as unknown as Record<string, unknown>).surprise = true;
    expect(() => validateObservationGraphV1(bad)).toThrow("ObservationSchemaInvalid");
  });

  it("checks evidence refs against a resolver when provided", () => {
    const g = graph({ nodes: [node({ evidenceRefs: ["artifact://x"] })] });
    expect(() =>
      validateObservationGraphV1(g, { evidenceResolver: () => false }),
    ).toThrow("EvidenceReferenceInvalid");
    expect(() =>
      validateObservationGraphV1(g, { evidenceResolver: () => true }),
    ).not.toThrow();
  });
});
