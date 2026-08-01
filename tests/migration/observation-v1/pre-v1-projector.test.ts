import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  ObservationError,
  validateObservationGraphV1,
} from "@qualigence/observation-contracts";
import {
  PreV1TraceProjector,
  type PreV1ObservationAsset,
} from "@qualigence/observation-migration";

const FIXTURES = new URL("../../fixtures/migration/pre-v1/", import.meta.url);

async function loadAsset(name: string): Promise<PreV1ObservationAsset> {
  const path = fileURLToPath(new URL(name, FIXTURES));
  return JSON.parse(await readFile(path, "utf8")) as PreV1ObservationAsset;
}

describe("pre-v1 Trace projection", () => {
  it("projects a realistic M1 Web observation to a schema-valid v1 candidate", async () => {
    const asset = await loadAsset("m1-web-observation.json");
    const projector = new PreV1TraceProjector();
    const graph = projector.project(asset);

    expect(graph).toMatchObject({
      schema: { epoch: "v1", version: "observation-graph/v1" },
      target: { kind: "web", targetId: "web-shop" },
    });
    expect(() => validateObservationGraphV1(graph)).not.toThrow();

    // A flat pre-v1 graph projects to all-roots with the same node count.
    expect(graph.rootNodeIds).toEqual(graph.nodes.map((n) => n.id));
    expect(graph.nodes.length).toBe(asset.observation.nodes.length);

    // Graph-level artifact refs are carried across as evidence.
    expect(graph.evidenceRefs).toEqual(asset.observation.artifactRefs ?? []);

    // Every node cites the source adapter and defaults to public sensitivity.
    for (const node of graph.nodes) {
      expect(node.source).toEqual({
        adapterId: "web-playwright",
        sourceKind: "accessibility",
      });
      expect(node.sensitivity).toBe("public");
      expect(node.extensions).toEqual({});
    }
  });

  it("maps legacy text/disabled into the v1 state map (lossless, re-derivable)", async () => {
    const asset = await loadAsset("m1-web-observation.json");
    const graph = new PreV1TraceProjector().project(asset);

    const heading = asset.observation.nodes.find((n) => n.role === "heading");
    const projectedHeading = graph.nodes.find((n) => n.id === heading?.id);
    expect(projectedHeading?.state.text).toBe(heading?.text);

    const disabledSource = asset.observation.nodes.find(
      (n) => n.disabled === true,
    );
    const projectedDisabled = graph.nodes.find((n) => n.id === disabledSource?.id);
    expect(projectedDisabled?.state.disabled).toBe(true);
  });

  it("never mutates the pre-v1 source payload", async () => {
    const asset = await loadAsset("m1-web-observation.json");
    const before = JSON.stringify(asset.observation);
    new PreV1TraceProjector().project(asset);
    expect(JSON.stringify(asset.observation)).toBe(before);
  });

  it("rejects a corrupted source artifact with SourceAssetCorrupted", async () => {
    const asset = await loadAsset("corrupted-artifact.json");
    const projector = new PreV1TraceProjector();
    try {
      projector.project(asset);
      throw new Error("expected SourceAssetCorrupted");
    } catch (error) {
      expect(error).toBeInstanceOf(ObservationError);
      expect((error as ObservationError).code).toBe("SourceAssetCorrupted");
    }
  });

  it("recomputes a stable source hash for the M2 skill asset's observation", async () => {
    const asset = await loadAsset("m2-procedure-skill.json");
    const projector = new PreV1TraceProjector();
    const graph = projector.project(asset);
    expect(graph.schema.version).toBe("observation-graph/v1");
    expect(projector.sourceHash(asset)).toHaveLength(64);
  });
});
