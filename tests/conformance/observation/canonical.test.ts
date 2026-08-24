import { describe, it, expect } from "vitest";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_REDACTION_MARKER,
  WEB_EXTENSION_V1_TYPE,
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
    extensions: {},
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
      extensions: {},
      schema: OBSERVATION_GRAPH_V1_SCHEMA,
    } as ObservationGraphV1;
    expect(observationGraphHash(a)).toBe(observationGraphHash(reordered));
  });

  it("sorts semantic-set arrays so node, relation, root, and graph evidence order do not change the hash", () => {
    const g1 = graph({
      rootNodeIds: ["b", "a"],
      nodes: [
        node({ id: "b", relations: [{ type: "controls", targetNodeId: "a" }] }),
        node({ id: "a", relations: [
          { type: "owns", targetNodeId: "b" },
          { type: "child", targetNodeId: "b" },
        ] }),
      ],
      evidenceRefs: ["artifact://z", "artifact://a"],
    });
    const g2 = graph({
      rootNodeIds: ["a", "b"],
      nodes: [
        node({ id: "a", relations: [
          { type: "child", targetNodeId: "b" },
          { type: "owns", targetNodeId: "b" },
        ] }),
        node({ id: "b", relations: [{ type: "controls", targetNodeId: "a" }] }),
      ],
      evidenceRefs: ["artifact://a", "artifact://z"],
    });
    expect(observationGraphHash(g1)).toBe(observationGraphHash(g2));
  });

  it("preserves business-order and undeclared extension arrays", () => {
    const g1 = graph({
      nodes: [node({ id: "n1", evidenceRefs: ["artifact://first", "artifact://second"] })],
      extensions: {
        "custom/v1": {
          type: "custom/v1",
          version: "1.0",
          payload: { observedSequence: ["first", "second"] },
        },
      },
    });
    const g2 = graph({
      nodes: [node({ id: "n1", evidenceRefs: ["artifact://second", "artifact://first"] })],
      extensions: {
        "custom/v1": {
          type: "custom/v1",
          version: "1.0",
          payload: { observedSequence: ["second", "first"] },
        },
      },
    });
    expect(observationGraphHash(g1)).not.toBe(observationGraphHash(g2));
  });

  it("rejects non-identical entries with equal normalized semantic keys", () => {
    const composed = "é";
    const decomposed = "e\u0301";
    expect(() =>
      validateObservationGraphV1(
        graph({
          rootNodeIds: [composed, decomposed],
          nodes: [node({ id: composed })],
        }),
      ),
    ).toThrow("ObservationSchemaInvalid");
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

  it("accepts a privacy-safe graph-level web/v1 extension", () => {
    const g = graph({
      extensions: {
        [WEB_EXTENSION_V1_TYPE]: {
          type: WEB_EXTENSION_V1_TYPE,
          version: "1.0",
          payload: {
            origin: "https://example.test",
            pathname: "/checkout",
            title: "Checkout",
            viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
            query: { ref: WEB_EXTENSION_V1_REDACTION_MARKER },
          },
        },
      },
    });
    expect(() => validateObservationGraphV1(g, { allowedWebQueryKeys: ["ref"] })).not.toThrow();
  });

  it("rejects raw query values and forbidden URL fragments in web/v1", () => {
    const payload = {
      origin: "https://example.test",
      pathname: "/checkout",
      title: "Checkout",
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      query: { token: "secret-token" },
      fragment: "payment",
    };
    expect(() =>
      validateObservationGraphV1(
        graph({
          extensions: {
            [WEB_EXTENSION_V1_TYPE]: {
              type: WEB_EXTENSION_V1_TYPE,
              version: "1.0",
              payload,
            },
          },
        }),
        { allowedWebQueryKeys: ["ref"] },
      ),
    ).toThrow("ObservationSchemaInvalid");
  });

  it("rejects invalid web/v1 viewport bounds", () => {
    expect(() =>
      validateObservationGraphV1(
        graph({
          extensions: {
            [WEB_EXTENSION_V1_TYPE]: {
              type: WEB_EXTENSION_V1_TYPE,
              version: "1.0",
              payload: {
                origin: "https://example.test",
                pathname: "/checkout",
                title: "Checkout",
                viewport: { width: 0, height: 720, devicePixelRatio: 1 },
                query: {},
              },
            },
          },
        }),
      ),
    ).toThrow("ObservationSchemaInvalid");
  });
});
