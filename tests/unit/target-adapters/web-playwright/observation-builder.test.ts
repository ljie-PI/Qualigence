import { describe, expect, it } from "vitest";
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
  });

  it("assigns a unique node id per node in DOM order", () => {
    const { graph } = buildObservationGraph("run-1", 1, candidates);
    expect(graph.nodes).toHaveLength(candidates.length);
    const ids = graph.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^n-\d+-[0-9a-f]{8}$/);
    }
  });

  it("keeps distinct node ids for elements sharing role and name", () => {
    const twins: readonly ObservationCandidate[] = [
      { role: "button", name: "Add" },
      { role: "button", name: "Add" },
    ];
    const { graph } = buildObservationGraph("run-2", 3, twins);
    const [first, second] = graph.nodes;
    expect(first?.id).not.toBe(second?.id);
  });

  it("fixes confidence at 1 and only includes attributes that were read", () => {
    const { graph } = buildObservationGraph("run-1", 1, candidates);
    const button = graph.nodes[0];
    expect(button).toMatchObject({ role: "button", name: "Add to cart", confidence: 1 });
    expect(button).not.toHaveProperty("value");
    expect(button).not.toHaveProperty("disabled");
    expect(button).not.toHaveProperty("text");

    const disabled = graph.nodes[2];
    expect(disabled).toMatchObject({ role: "button", name: "Checkout", disabled: true });
  });

  it("never surfaces a value that was not captured (password inputs)", () => {
    const { graph } = buildObservationGraph("run-1", 1, candidates);
    const password = graph.nodes[3];
    expect(password).toMatchObject({ role: "textbox", name: "Password" });
    expect(password).not.toHaveProperty("value");
  });

  it("registers a graph-scoped locator descriptor for each node", () => {
    const { graph, descriptors } = buildObservationGraph("run-1", 1, candidates);
    for (const node of graph.nodes) {
      expect(descriptors.has(node.id)).toBe(true);
    }
    const buttonId = graph.nodes[0]!.id;
    expect(descriptors.get(buttonId)).toMatchObject({
      kind: "role",
      role: "button",
      name: "Add to cart",
    });
  });
});
