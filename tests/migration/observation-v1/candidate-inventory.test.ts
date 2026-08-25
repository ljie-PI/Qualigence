import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
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
  StandardReverifier,
  resolvingTargets,
} from "../../helpers/skill-reverifier.js";

const execFileAsync = promisify(execFile);
const FIXTURES = new URL("../../fixtures/migration/pre-v1/", import.meta.url);
const NOW = () => "2026-08-25T00:00:00.000Z";

async function loadFixture<T>(name: string): Promise<T> {
  const path = fileURLToPath(new URL(name, FIXTURES));
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("Ticket 25 active pre-v1 candidate inventory", () => {
  it("classifies active Trace and Skill fixtures with source/output hashes while staying candidate", async () => {
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
    expect(report.counts).toMatchObject({
      inventory: 2,
      migrated: 2,
      deprecated: 0,
      needsHuman: 0,
      failed: 0,
    });
    expect(report.gate.zeroUnexplainedFailures).toBe(true);
    expect(report.gate.allAssetsClassified).toBe(true);

    const byAsset = new Map(report.results.map((result) => [result.assetId, result]));
    const traceResult = byAsset.get(trace.assetId);
    const skillResult = byAsset.get(skill.assetId);

    expect(traceResult).toMatchObject({
      assetKind: "observation",
      status: "migrated",
      migratorVersion: "observation-migrator/v1",
    });
    expect(traceResult?.sourceHash).toHaveLength(64);
    expect(traceResult?.outputRef).toHaveLength(64);

    expect(skillResult).toMatchObject({
      assetKind: "skill",
      status: "migrated",
      sourceHash: skill.previous.contentSha256,
      locatorSchemaVersion: skill.previous.locatorSchemaVersion,
      skillCompilerVersion: skill.previous.compilerVersion,
      sourceTraceRefs: skill.recording.sourceTraceRefs,
    });
    expect(skillResult?.migratorVersion).toBe(
      `observation-migrator/v1+${skill.previous.compilerVersion}`,
    );
    expect(skillResult?.outputRef).toHaveLength(64);
    expect(skillResult?.outputRef).not.toBe(skill.previous.contentSha256);

    const stored = await store.list();
    expect(stored).toHaveLength(2);
    expect(stored.map((entry) => entry.result.assetId).sort()).toEqual(
      [trace.assetId, skill.assetId].sort(),
    );
  });

  it("classifies changed Skill source hashes as failed without overwriting prior results", async () => {
    const skill = await loadFixture<PreV1SkillInventoryAsset>("m2-procedure-skill.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler(
        new StandardReverifier(LocalSkillSigner.generate(), resolvingTargets),
      ),
    );

    const first = await runner.run([skill], { now: NOW });
    const changed = {
      ...skill,
      recording: { ...skill.recording, recordingId: "rec-m2-cart-mutated" },
    } satisfies PreV1SkillInventoryAsset;
    const second = await runner.run([changed], { now: NOW });

    expect(first.results[0]?.status).toBe("migrated");
    expect(second.results[0]).toMatchObject({
      assetId: skill.assetId,
      assetKind: "skill",
      status: "failed",
      reasonCode: "MigrationSourceChanged",
      expectedSourceHash: skill.previous.contentSha256,
    });
    expect(second.results[0]?.sourceHash).not.toBe(skill.previous.contentSha256);
    expect(second.gate.allAssetsClassified).toBe(true);
    expect(second.gate.zeroUnexplainedFailures).toBe(true);
    expect(second.counts.failed).toBe(1);
    expect(await store.list()).toHaveLength(2);
  });

  it("returns the existing immutable result for repeated active inventory runs", async () => {
    const skill = await loadFixture<PreV1SkillInventoryAsset>("m2-procedure-skill.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler(
        new StandardReverifier(LocalSkillSigner.generate(), resolvingTargets),
      ),
    );

    const first = await runner.run([skill], { now: NOW });
    const second = await runner.run([skill], { now: NOW });

    expect(second.results).toEqual(first.results);
    expect(await store.list()).toHaveLength(1);
  });
});

describe("Ticket 25 legacy ObservationGraph inventory", () => {
  it("classifies every repository hit from the required rg inventory", async () => {
    const { stdout } = await execFileAsync("rg", [
      "-l",
      "\\bObservationGraph\\b",
      "apps",
      "packages",
      "tests",
    ]);
    const hits = stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\\/g, "/"))
      .filter((line) => line.length > 0)
      .sort();

    const classified = {
      "packages/contracts/runner-protocol/src/index.ts":
        "hard-excluded legacy public contract declaration retained for pre-v1 migration/test fixture typing; no live producer or consumer imports it",
      "packages/observation-migration/src/pre-v1-projector.ts":
        "explicit pre-v1 decoder/projector allowed by Ticket 25",
      "tests/component/skill-lifecycle/recording-to-replay.test.ts":
        "immutable historical pre-v1 Skill lifecycle fixture that projects through PreV1TraceProjector before live replay",
      "tests/e2e/observation-v1/consumer-migration.test.ts":
        "post-review consumer-migration acceptance historical fixture that projects through PreV1TraceProjector before live consumers",
      "tests/migration/observation-v1/candidate-inventory.test.ts":
        "Ticket 25 inventory test that executes and classifies the required legacy-type repository scan",
    } satisfies Record<string, string>;

    expect(hits).toEqual(Object.keys(classified).sort());
    expect(Object.values(classified).every((reason) => reason.length > 0)).toBe(true);
  });
});
