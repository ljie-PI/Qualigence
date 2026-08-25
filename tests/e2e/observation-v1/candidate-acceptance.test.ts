import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LocalSkillSigner } from "@qualigence/kms-local";
import {
  InMemoryObservationMigrationStore,
  ObservationCandidateInventoryRunner,
  SkillRecompiler,
  type ActivePreV1InventoryAsset,
  type PreV1ObservationAsset,
  type PreV1SkillInventoryAsset,
} from "@qualigence/observation-migration";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_TYPE,
  validateObservationGraphV1,
  type ObservationGraphV1,
} from "@qualigence/observation-contracts";
import { UIA_EXTENSION_TYPE } from "@qualigence/desktop-contracts";
import {
  UiaActionResolver,
  mapUiaPayloadToObservationV1,
  type UiaSource,
} from "@qualigence/desktop-windows-uia";
import type { ProposedAction } from "@qualigence/runner-kernel";
import {
  StandardReverifier,
  resolvingTargets,
} from "../../helpers/skill-reverifier.js";

const FIXTURES = new URL("../../fixtures/migration/pre-v1/", import.meta.url);
const CHECKLIST = new URL(
  "../../../docs/testing/observation-graph-v1-freeze-checklist.md",
  import.meta.url,
);
const NOW = () => "2026-08-25T00:00:00.000Z";

async function loadFixture<T>(name: string): Promise<T> {
  const path = fileURLToPath(new URL(name, FIXTURES));
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("Ticket 25 candidate acceptance", () => {
  it("classifies the complete active pre-v1 inventory and accepts only candidate results", async () => {
    const trace = await loadFixture<PreV1ObservationAsset>("m1-web-observation.json");
    const skill = await loadFixture<PreV1SkillInventoryAsset>("m2-procedure-skill.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler(
        new StandardReverifier(LocalSkillSigner.generate(), resolvingTargets),
      ),
    );

    const report = await runner.run(
      [trace as ActivePreV1InventoryAsset, skill],
      { now: NOW },
    );

    expect(report.status).toBe("candidate");
    expect(report.gate.frozen).toBe(false);
    expect(report.unexplainedFailures).toEqual([]);
    expect(report.gate.zeroUnexplainedFailures).toBe(true);
    expect(report.gate.allAssetsClassified).toBe(true);
    expect(report.counts.inventory).toBe(2);
    expect(report.counts.failed).toBe(0);
    expect(report.results.every((result) => result.status !== "failed")).toBe(true);

    for (const result of report.results) {
      expect(["migrated", "deprecated", "needs_human"]).toContain(result.status);
      expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.outputRef).toMatch(/^[a-f0-9]{64}$/);
      expect(result.migratorVersion).toContain("observation-migrator/v1");
      if (result.assetKind === "skill") {
        expect(result.skillSourceHash).toMatch(/^[a-f0-9]{64}$/);
        expect(result.skillCompilerVersion).toBe(skill.previous.compilerVersion);
        expect(result.sourceTraceRefs).toEqual(skill.recording.sourceTraceRefs);
      }
    }

    const stored = await store.list();
    expect(stored).toHaveLength(2);
    const webProjection = stored.find(
      (entry) => entry.result.assetKind === "observation",
    )?.projection;
    expect(webProjection).toBeDefined();
    expect(webProjection?.schema).toEqual(OBSERVATION_GRAPH_V1_SCHEMA);
    expect(webProjection?.extensions?.[WEB_EXTENSION_V1_TYPE]).toMatchObject({
      type: WEB_EXTENSION_V1_TYPE,
      version: "1.0",
    });
  });

  it("accepts the existing Windows replay projection on the same candidate schema", () => {
    const graph = validateObservationGraphV1(
      mapUiaPayloadToObservationV1(windowsSource(), {
        adapterId: "desktop-windows-uia",
      }) as ObservationGraphV1,
    );
    const resolver = new UiaActionResolver();
    const action = {
      kind: "click",
      target: { nodeId: "button" },
      reason: "candidate acceptance",
    } satisfies ProposedAction;

    expect(graph.schema).toEqual(OBSERVATION_GRAPH_V1_SCHEMA);
    const button = graph.nodes.find((node) => node.id === "button");
    expect(button?.extensions[UIA_EXTENSION_TYPE]).toMatchObject({
      type: UIA_EXTENSION_TYPE,
      version: "1.0",
    });
    expect(resolver.resolve(action, graph, { actionId: "act-acceptance" })).toMatchObject({
      targetKind: "desktop",
      kind: "click",
      actionId: "act-acceptance",
      graphId: graph.graphId,
      nodeId: "button",
      resolution: "semantic",
      uiaPattern: "Invoke",
    });
  });

  it("keeps the checklist and generated acceptance report in candidate state", async () => {
    const checklist = await readFile(fileURLToPath(CHECKLIST), "utf8");
    const trace = await loadFixture<PreV1ObservationAsset>("m1-web-observation.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler(
        new StandardReverifier(LocalSkillSigner.generate(), resolvingTargets),
      ),
    );

    const report = await runner.run([trace as ActivePreV1InventoryAsset], {
      now: NOW,
    });

    expect(checklist).toContain("# Observation Graph v1 — Freeze Checklist (candidate)");
    expect(checklist).toContain("Status: **candidate**");
    expect(report.status).toBe("candidate");
    expect(report.gate.frozen).toBe(false);
    expect(JSON.stringify(report)).not.toContain('"status":"frozen"');
  });
});

function windowsSource(): UiaSource {
  return {
    sessionId: "sess-candidate-acceptance",
    capturedAt: "2026-08-25T00:00:00.000Z",
    rootNodeIds: ["window"],
    nodes: [
      {
        nodeId: "window",
        role: "window",
        controlTypeId: 50032,
        name: "Reference App",
        processId: 7,
        isOffscreen: false,
        isKeyboardFocusable: false,
        hasKeyboardFocus: false,
        isPassword: false,
        patterns: [{ pattern: "Window", available: true }],
        children: ["button"],
      },
      {
        nodeId: "button",
        role: "button",
        controlTypeId: 50000,
        name: "Submit",
        processId: 7,
        isOffscreen: false,
        isKeyboardFocusable: true,
        hasKeyboardFocus: false,
        isPassword: false,
        patterns: [{ pattern: "Invoke", available: true }],
        children: [],
      },
    ],
  };
}
