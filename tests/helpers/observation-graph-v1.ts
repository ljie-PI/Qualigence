import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_TYPE,
  type ObservationGraphV1,
  type ObservationNodeV1,
} from "@qualigence/runner-protocol";

export type ObservationGraphV1TestNode = Pick<ObservationNodeV1, "id" | "role"> &
  Partial<Pick<ObservationNodeV1, "name" | "value" | "confidence" | "sensitivity" | "evidenceRefs">> & {
    readonly text?: string;
  };

export function observationGraphV1(
  graphId: string,
  nodes: readonly ObservationGraphV1TestNode[] = [],
  overrides: Partial<ObservationGraphV1> = {},
): ObservationGraphV1 {
  const origin = overrides.target?.targetId ?? "https://example.test";
  const root: ObservationNodeV1 = {
    id: `${graphId}:root`,
    role: "document",
    name: "Test page",
    state: {},
    relations: nodes.map((node) => ({ type: "child", targetNodeId: node.id })),
    source: { adapterId: "test-fixture", sourceKind: "fixture" },
    confidence: 1,
    sensitivity: "public",
    extensions: {},
    evidenceRefs: [],
  };
  const graph: ObservationGraphV1 = {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId,
    target: { kind: "web", targetId: origin },
    capturedAt: "2026-08-24T00:00:00.000Z",
    rootNodeIds: [root.id],
    nodes: [root, ...nodes.map((node): ObservationNodeV1 => ({
      id: node.id,
      role: node.role,
      ...((node.name ?? node.text) === undefined ? {} : { name: node.name ?? node.text }),
      ...(node.value === undefined ? {} : { value: node.value }),
      state: {},
      relations: [],
      source: { adapterId: "test-fixture", sourceKind: "fixture" },
      confidence: node.confidence ?? 1,
      sensitivity: node.sensitivity ?? "public",
      extensions: {},
      evidenceRefs: node.evidenceRefs ?? [],
    }))],
    evidenceRefs: [],
    extensions: {
      [WEB_EXTENSION_V1_TYPE]: {
        type: WEB_EXTENSION_V1_TYPE,
        version: "1.0",
        payload: {
          origin,
          pathname: "/",
          title: "Test page",
          viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
          query: {},
        },
      },
    },
    ...overrides,
  };
  return graph;
}
