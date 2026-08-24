import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import {
  CANONICAL_GRAPH_FIELDS,
  CANONICAL_NODE_FIELDS,
  OBSERVATION_GRAPH_V1_SCHEMA,
  type ObservationGraphV1,
} from "@qualigence/observation-contracts";

const require = createRequire(import.meta.url);
const schemaPath = require.resolve(
  "@qualigence/observation-contracts/schema",
);

function goodGraph(): ObservationGraphV1 {
  return {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId: "g1",
    target: { kind: "web", targetId: "t1" },
    capturedAt: "2026-08-01T00:00:00.000Z",
    rootNodeIds: ["n1"],
    nodes: [
      {
        id: "n1",
        role: "window",
        state: {},
        relations: [],
        source: { adapterId: "web-playwright", sourceKind: "accessibility" },
        confidence: 1,
        sensitivity: "public",
        extensions: {},
        evidenceRefs: [],
      },
    ],
    evidenceRefs: [],
  };
}

describe("Observation Graph v1 JSON Schema artifact", () => {
  it("is a well-formed draft 2020-12 schema pinning the candidate version", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(schema.$schema).toContain("2020-12");
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties as Record<string, unknown>;
    const schemaBlock = props.schema as {
      properties: { version: { const: string } };
    };
    expect(schemaBlock.properties.version.const).toBe("observation-graph/v1");
  });

  it("declares exactly the canonical graph and node fields (no drift)", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
      properties: Record<string, unknown>;
      $defs: { node: { properties: Record<string, unknown> } };
    };
    expect(new Set(Object.keys(schema.properties))).toEqual(
      new Set(CANONICAL_GRAPH_FIELDS),
    );
    expect(new Set(Object.keys(schema.$defs.node.properties))).toEqual(
      new Set(CANONICAL_NODE_FIELDS),
    );
  });

  it("keeps the candidate status explicit and never frozen", async () => {
    const raw = await readFile(schemaPath, "utf8");
    expect(raw).toContain("candidate");
    expect(raw).not.toContain("frozen\"");
    expect(raw).toContain("serialized migration, Web/Desktop schema, native Windows, manual, and release evidence");
  });

  it("keeps web/v1 schema constraints aligned with the validator", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
      $defs: {
        node: { properties: { extensions: { properties: Record<string, false> } } };
        webExtensionV1: { properties: { payload: { properties: Record<string, { pattern?: string }> } } };
      };
    };
    expect(schema.$defs.node.properties.extensions.properties["web/v1"]).toBe(false);
    expect(schema.$defs.webExtensionV1.properties.payload.properties.origin?.pattern).toContain("?![^/?#]*@");
    expect(schema.$defs.webExtensionV1.properties.payload.properties.pathname?.pattern).toContain("\\.\\.?");
  });

  it("matches a valid v1 payload structurally", () => {
    const graph = goodGraph();
    expect(graph.schema.epoch).toBe("v1");
    expect(graph.rootNodeIds.every((id) => graph.nodes.some((n) => n.id === id))).toBe(
      true,
    );
  });
});
