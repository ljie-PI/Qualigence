import { describe, it, expect } from "vitest";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  observationGraphHash,
  validateObservationGraphV1,
  type ObservationGraphV1,
  type ObservationNodeV1,
} from "@qualigence/observation-contracts";

/** Deterministic small permutations of object keys, used instead of fast-check. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const perm of permutations(rest)) {
      result.push([item, ...perm]);
    }
  });
  return result;
}

/** Rebuild an object with the given key order. */
function reorder(
  record: Record<string, unknown>,
  order: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    out[key] = record[key];
  }
  return out;
}

function baseNode(id: string): ObservationNodeV1 {
  return {
    id,
    role: "generic",
    name: `name-${id}`,
    state: { visible: true, order: id.length },
    relations: [],
    source: { adapterId: "web-playwright", sourceKind: "accessibility" },
    confidence: 0.5,
    sensitivity: "public",
    extensions: {},
    evidenceRefs: [],
  };
}

function baseGraph(): ObservationGraphV1 {
  const nodes = [baseNode("a"), baseNode("b"), baseNode("c")];
  nodes[0] = { ...nodes[0]!, relations: [{ type: "child", targetNodeId: "b" }] };
  nodes[1] = { ...nodes[1]!, relations: [{ type: "controls", targetNodeId: "c" }] };
  return {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId: "g-prop",
    target: { kind: "web", targetId: "t1" },
    capturedAt: "2026-08-01T00:00:00.000Z",
    rootNodeIds: ["a"],
    nodes,
    evidenceRefs: ["artifact://root"],
    extensions: {},
  };
}

describe("observation graph properties", () => {
  it("hash is invariant under any top-level key permutation", () => {
    const graph = baseGraph();
    const expected = observationGraphHash(graph);
    const keys = Object.keys(graph);
    for (const order of permutations(keys)) {
      const permuted = reorder(
        graph as unknown as Record<string, unknown>,
        order,
      ) as unknown as ObservationGraphV1;
      expect(observationGraphHash(permuted)).toBe(expected);
    }
  });

  it("hash is invariant under node-level key rotation", () => {
    const graph = baseGraph();
    const expected = observationGraphHash(graph);
    const node = graph.nodes[0]! as unknown as Record<string, unknown>;
    const keys = Object.keys(node);
    for (let shift = 0; shift < keys.length; shift += 1) {
      const order = [...keys.slice(shift), ...keys.slice(0, shift)];
      const permutedNode = reorder(node, order);
      const permuted: ObservationGraphV1 = {
        ...graph,
        nodes: [
          permutedNode as unknown as ObservationNodeV1,
          ...graph.nodes.slice(1),
        ],
      };
      expect(observationGraphHash(permuted)).toBe(expected);
    }
  });

  it("every relation target in a valid graph resolves to a node (no dangling)", () => {
    const graph = baseGraph();
    validateObservationGraphV1(graph);
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const node of graph.nodes) {
      for (const relation of node.relations) {
        expect(ids.has(relation.targetNodeId)).toBe(true);
      }
    }
  });

  it("hash is invariant under semantic-set permutations", () => {
    const graph = {
      ...baseGraph(),
      rootNodeIds: ["b", "a"],
      nodes: [
        { ...baseNode("b"), relations: [{ type: "controls", targetNodeId: "c" } as const] },
        {
          ...baseNode("a"),
          relations: [
            { type: "owns", targetNodeId: "b" } as const,
            { type: "child", targetNodeId: "b" } as const,
          ],
        },
        baseNode("c"),
      ],
      evidenceRefs: ["artifact://z", "artifact://root"],
    } satisfies ObservationGraphV1;

    const permuted = {
      ...graph,
      rootNodeIds: ["a", "b"],
      nodes: [
        {
          ...baseNode("a"),
          relations: [
            { type: "child", targetNodeId: "b" } as const,
            { type: "owns", targetNodeId: "b" } as const,
          ],
        },
        baseNode("c"),
        { ...baseNode("b"), relations: [{ type: "controls", targetNodeId: "c" } as const] },
      ],
      evidenceRefs: ["artifact://root", "artifact://z"],
    } satisfies ObservationGraphV1;

    expect(observationGraphHash(permuted)).toBe(observationGraphHash(graph));
  });

  it("hash remains sensitive to business-order arrays", () => {
    const graph = {
      ...baseGraph(),
      nodes: [
        {
          ...baseNode("a"),
          evidenceRefs: ["artifact://first", "artifact://second"],
        },
        baseNode("b"),
        baseNode("c"),
      ],
      extensions: {
        "custom/v1": {
          type: "custom/v1",
          version: "1.0",
          payload: { steps: ["first", "second"] },
        },
      },
    } satisfies ObservationGraphV1;

    const reordered = {
      ...graph,
      nodes: [
        {
          ...baseNode("a"),
          evidenceRefs: ["artifact://second", "artifact://first"],
        },
        baseNode("b"),
        baseNode("c"),
      ],
      extensions: {
        "custom/v1": {
          type: "custom/v1",
          version: "1.0",
          payload: { steps: ["second", "first"] },
        },
      },
    } satisfies ObservationGraphV1;

    expect(observationGraphHash(reordered)).not.toBe(observationGraphHash(graph));
  });
});
