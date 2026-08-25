import { describe, expect, it } from "vitest";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_REDACTION_MARKER,
  WEB_EXTENSION_V1_TYPE,
  validateObservationGraphV1,
} from "@qualigence/runner-protocol";
import {
  buildObservationGraph,
  normalizeVisibleText,
  type ObservationCandidate,
} from "@qualigence/web-playwright/internal";

describe("normalizeVisibleText", () => {
  it("applies NFC, collapses whitespace and trims", () => {
    expect(normalizeVisibleText("  A\n B  ")).toBe("A B");
    expect(normalizeVisibleText("\tAdd  to\tcart \n")).toBe("Add to cart");
  });

  it("normalizes combining sequences to NFC", () => {
    const decomposed = "e\u0301"; // e + combining acute accent
    expect(normalizeVisibleText(decomposed)).toBe("\u00e9");
  });
});

describe("buildObservationGraph", () => {
  const candidates: readonly ObservationCandidate[] = [
    { role: "button", name: "Add to cart" },
    { role: "text", text: "Cart total: $0" },
    { role: "button", name: "Checkout", disabled: true },
    { role: "textbox", name: "Password" },
  ];

  it("derives the graphId from the run id and ordinal", () => {
    const { graph } = buildObservationGraph("run-1", 1, candidates);
    expect(graph.graphId).toBe("run-1:observation:1");
    expect(graph.schema).toEqual(OBSERVATION_GRAPH_V1_SCHEMA);
  });

  it("assigns a unique node id per observed candidate plus a deterministic document root", () => {
    const { graph } = buildObservationGraph("run-1", 1, candidates);
    expect(graph.rootNodeIds).toEqual(["n-000000-document"]);
    expect(graph.nodes).toHaveLength(candidates.length + 1);
    const ids = graph.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("n-000000-document");
    for (const id of ids.slice(1)) {
      expect(id).toMatch(/^n-\d{6}-[0-9a-f]{8}$/);
    }
    expect(graph.nodes[0]?.relations.map((relation) => relation.targetNodeId)).toEqual(ids.slice(1));
  });

  it("keeps distinct node ids for elements sharing role and name", () => {
    const twins: readonly ObservationCandidate[] = [
      { role: "button", name: "Add" },
      { role: "button", name: "Add" },
    ];
    const { graph } = buildObservationGraph("run-2", 3, twins);
    const [first, second] = graph.nodes.slice(1);
    expect(first?.id).not.toBe(second?.id);
  });

  it("fixes confidence at 1 and maps state/source/sensitivity into v1 nodes", () => {
    const { graph } = buildObservationGraph("run-1", 1, candidates);
    const button = graph.nodes[1];
    expect(button).toMatchObject({
      role: "button",
      name: "Add to cart",
      confidence: 1,
      state: { disabled: false },
      source: { adapterId: "web-playwright", sourceKind: "dom" },
      sensitivity: "public",
      extensions: {},
      evidenceRefs: [],
    });
    expect(button).not.toHaveProperty("value");

    const disabled = graph.nodes[3];
    expect(disabled).toMatchObject({ role: "button", name: "Checkout", state: { disabled: true } });
  });

  it("never surfaces a value that was not captured (password inputs)", () => {
    const { graph } = buildObservationGraph("run-1", 1, candidates);
    const password = graph.nodes[4];
    expect(password).toMatchObject({ role: "textbox", name: "Password" });
    expect(password).not.toHaveProperty("value");
  });

  it("registers adapter-local locator descriptors for observed candidate nodes only", () => {
    const { graph, descriptors } = buildObservationGraph("run-1", 1, candidates);
    expect(descriptors.has(graph.rootNodeIds[0]!)).toBe(false);
    for (const node of graph.nodes.slice(1)) {
      expect(descriptors.has(node.id)).toBe(true);
    }
    const buttonId = graph.nodes[1]!.id;
    expect(descriptors.get(buttonId)).toMatchObject({
      kind: "role",
      role: "button",
      name: "Add to cart",
    });
  });

  it("emits validated privacy-safe web/v1 metadata with only allowlisted query keys", () => {
    const { graph } = buildObservationGraph("run-1", 1, candidates, {
      url: "https://example.test/checkout?token=secret&ref=abc#section",
      title: "Checkout",
      capturedAt: "2026-08-24T00:00:00.000Z",
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
      allowedQueryKeys: ["ref"],
      evidenceRefs: ["1-observation.json", "1.png"],
    });

    expect(() => validateObservationGraphV1(graph, { allowedWebQueryKeys: ["ref"] })).not.toThrow();
    expect(graph.target).toEqual({ kind: "web", targetId: "https://example.test" });
    expect(graph.capturedAt).toBe("2026-08-24T00:00:00.000Z");
    expect(graph.evidenceRefs).toEqual(["1-observation.json", "1.png"]);
    expect(graph.extensions?.[WEB_EXTENSION_V1_TYPE]).toMatchObject({
      type: WEB_EXTENSION_V1_TYPE,
      version: "1.0",
      payload: {
        origin: "https://example.test",
        pathname: "/checkout",
        title: "Checkout",
        viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
        query: { ref: WEB_EXTENSION_V1_REDACTION_MARKER },
      },
    });
    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("abc");
    expect(serialized).not.toContain("section");
  });
});
