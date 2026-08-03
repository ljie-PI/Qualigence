/**
 * Compile-time type test (checked by `tsc --noEmit -p tsconfig.test.json`, not
 * executed by Vitest). It asserts the v1 candidate types are well-formed and
 * reachable through the runner-protocol single-contract re-export.
 */
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  type ObservationGraphV1,
  type ObservationNodeV1,
} from "@qualigence/observation-contracts";
import type { ObservationGraphV1 as ReexportedGraph } from "@qualigence/runner-protocol";

const node: ObservationNodeV1 = {
  id: "n1",
  role: "window",
  state: { focused: true, label: "root", depth: 0 },
  relations: [{ type: "child", targetNodeId: "n2" }],
  source: { adapterId: "web-playwright", sourceKind: "accessibility" },
  confidence: 1,
  sensitivity: "public",
  extensions: {
    "uia/v1": { type: "uia/v1", version: "1.0", payload: { controlType: "Window" } },
  },
  evidenceRefs: ["artifact://a"],
};

const graph: ObservationGraphV1 = {
  schema: OBSERVATION_GRAPH_V1_SCHEMA,
  graphId: "g1",
  target: { kind: "web", targetId: "t1" },
  capturedAt: "2026-08-01T00:00:00.000Z",
  rootNodeIds: ["n1"],
  nodes: [node],
  evidenceRefs: [],
};

const version: "observation-graph/v1" = graph.schema.version;
void version;

const viaReexport: ReexportedGraph = graph;

export const OBSERVATION_TYPE_FIXTURE: ReexportedGraph = viaReexport;
