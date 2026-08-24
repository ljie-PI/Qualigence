import { describe, it, expect } from "vitest";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  ObservationError,
  parseExtensionKey,
  requireExtensionMajor,
  requireGraphExtensionMajor,
  findExtensionMajor,
  validateObservationGraphV1,
  observationGraphHash,
  type ObservationGraphV1,
  type ObservationNodeV1,
} from "@qualigence/observation-contracts";
import {
  OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN,
  WEB_OBSERVATION_EXTENSION_V1_CAPABILITY,
  WEB_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN,
  advertisedCapabilityTokens,
  capabilities,
} from "@qualigence/runner-protocol";

function nodeWith(
  extensions: ObservationNodeV1["extensions"],
): ObservationNodeV1 {
  return {
    id: "n1",
    role: "window",
    state: {},
    relations: [],
    source: { adapterId: "uia", sourceKind: "uia-tree" },
    confidence: 1,
    sensitivity: "public",
    extensions,
    evidenceRefs: [],
  };
}

function graphWith(node: ObservationNodeV1): ObservationGraphV1 {
  return {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId: "g1",
    target: { kind: "app", targetId: "win-app" },
    capturedAt: "2026-08-01T00:00:00.000Z",
    rootNodeIds: [node.id],
    nodes: [node],
    evidenceRefs: [],
    extensions: {},
  };
}

const uiaV1 = {
  "uia/v1": {
    type: "uia/v1",
    version: "1.3",
    payload: { controlType: "Window", automationId: "root", unknownMinorField: 42 },
  },
} as const;

describe("extension compatibility", () => {
  it("parses <name>/v<major> keys", () => {
    expect(parseExtensionKey("uia/v1")).toEqual({ name: "uia", major: 1 });
    expect(parseExtensionKey("uia/v12")).toEqual({ name: "uia", major: 12 });
    expect(parseExtensionKey("not-a-key")).toBeUndefined();
    expect(parseExtensionKey("UIA/v1")).toBeUndefined();
  });

  it("accepts an extension-namespaced unknown minor field and round-trips it", () => {
    const node = nodeWith(uiaV1);
    expect(() => validateObservationGraphV1(graphWith(node))).not.toThrow();
    const roundTrip = JSON.parse(
      JSON.stringify(graphWith(node)),
    ) as ObservationGraphV1;
    expect(roundTrip).toEqual(graphWith(node));
    // The unknown minor field survives and hashing is stable.
    expect(observationGraphHash(roundTrip)).toBe(observationGraphHash(graphWith(node)));
  });

  it("resolves a required extension at the matching major", () => {
    const node = nodeWith(uiaV1);
    const extension = requireExtensionMajor(node, "uia", 1);
    expect(extension.payload.unknownMinorField).toBe(42);
    expect(findExtensionMajor(node, "uia", 1)).toBe(extension);
  });

  it("fails closed when a consumer requires an unsupported major", () => {
    const node = nodeWith(uiaV1);
    try {
      requireExtensionMajor(node, "uia", 2);
      throw new Error("expected ExtensionVersionUnsupported");
    } catch (error) {
      expect(error).toBeInstanceOf(ObservationError);
      expect((error as ObservationError).code).toBe("ExtensionVersionUnsupported");
    }
    expect(findExtensionMajor(node, "uia", 2)).toBeUndefined();
  });

  it("rejects a malformed extension key", () => {
    const node = nodeWith({
      badkey: { type: "x", version: "1", payload: {} },
    } as unknown as ObservationNodeV1["extensions"]);
    expect(() => validateObservationGraphV1(graphWith(node))).toThrow(
      "ObservationSchemaInvalid",
    );
  });

  it("resolves graph-level extension majors independently from node extensions", () => {
    const graph = {
      ...graphWith(nodeWith({})),
      extensions: {
        "web/v1": {
          type: "web/v1",
          version: "1.0",
          payload: {
            origin: "https://example.test",
            pathname: "/",
            title: "Example",
            viewport: { width: 1024, height: 768, devicePixelRatio: 1 },
            query: {},
          },
        },
      },
    } as const;

    expect(validateObservationGraphV1(graph).extensions?.["web/v1"]?.type).toBe("web/v1");
    expect(requireGraphExtensionMajor(graph, "web", 1).type).toBe("web/v1");
    expect(() => requireGraphExtensionMajor(graph, "web", 2)).toThrow(ObservationError);
  });

  it("advertises the graph v1 and web/v1 observation capability tokens", () => {
    const tokens = advertisedCapabilityTokens(
      capabilities({
        observationExtensions: ["observation-graph/v1", WEB_OBSERVATION_EXTENSION_V1_CAPABILITY],
      }),
    );

    expect(tokens.has(OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN)).toBe(true);
    expect(tokens.has(WEB_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN)).toBe(true);
  });
});
