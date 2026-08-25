import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_REDACTION_MARKER,
  WEB_EXTENSION_V1_TYPE,
  type ObservationGraphV1,
  type ObservationNodeV1,
  type VersionedExtension,
} from "@qualigence/runner-protocol";

export interface ReplayGraphNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly text?: string;
  readonly sensitivity?: ObservationNodeV1["sensitivity"];
  readonly state?: ObservationNodeV1["state"];
}

export interface WebReplayGraphOptions {
  readonly graphId?: string;
  readonly targetId?: string;
  readonly origin?: string;
  readonly title?: string;
  readonly queryKeys?: readonly string[];
  readonly claimIds?: readonly string[];
}

export function webReplayGraph(
  pathname: string,
  nodes: readonly ReplayGraphNode[],
  options: WebReplayGraphOptions = {},
): ObservationGraphV1 {
  const graphId = options.graphId ?? `graph-${pathname.replace(/[^a-z0-9]+/gi, "-")}`;
  const rootId = `${graphId}:root`;
  const graphNodes = nodes.map((node, index): ObservationNodeV1 => {
    const state = node.state ?? (node.text === undefined ? {} : { text: node.text });
    return {
      id: `${graphId}:node-${index + 1}`,
      role: node.role,
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(node.value === undefined ? {} : { value: node.value }),
      state,
      relations: [],
      source: { adapterId: "test-fixture", sourceKind: "accessibility" },
      confidence: 1,
      sensitivity: node.sensitivity ?? "public",
      extensions: {},
      evidenceRefs: [],
    };
  });
  const root: ObservationNodeV1 = {
    id: rootId,
    role: "document",
    name: options.title ?? "Test page",
    state: {},
    relations: graphNodes.map((node) => ({ type: "child", targetNodeId: node.id })),
    source: { adapterId: "test-fixture", sourceKind: "accessibility" },
    confidence: 1,
    sensitivity: "public",
    extensions: {},
    evidenceRefs: [],
  };
  const extensions: Record<string, VersionedExtension> = {
    [WEB_EXTENSION_V1_TYPE]: {
      type: WEB_EXTENSION_V1_TYPE,
      version: "1.0",
      payload: {
        origin: options.origin ?? "https://shop.example",
        pathname,
        title: options.title ?? "Test page",
        viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
        query: Object.fromEntries(
          (options.queryKeys ?? []).map((key) => [key, WEB_EXTENSION_V1_REDACTION_MARKER]),
        ),
      },
    },
  };
  if (options.claimIds !== undefined) {
    extensions["skill-replay/v1"] = {
      type: "skill-replay/v1",
      version: "1.0",
      payload: { claims: [...options.claimIds] },
    };
  }
  return {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId,
    target: { kind: "web", targetId: options.targetId ?? "web-cart" },
    capturedAt: "2026-08-25T00:00:00.000Z",
    rootNodeIds: [rootId],
    nodes: [root, ...graphNodes],
    evidenceRefs: [],
    extensions,
  };
}
