import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LocalSkillSigner } from "@qualigence/kms-local";
import {
  FileObservationMigrationStore,
  InMemoryObservationMigrationStore,
  ObservationCandidateInventoryRunner,
  PreV1TraceProjector,
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
      sourceHash: skill.declaredSourceHash,
      skillSourceHash: skill.previous.contentSha256,
      skillVersion: skill.previous.version,
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

  it("classifies changed Skill content hashes as failed without overwriting prior results", async () => {
    const skill = await loadFixture<PreV1SkillInventoryAsset>("m2-procedure-skill.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler(
        new StandardReverifier(LocalSkillSigner.generate(), resolvingTargets),
      ),
    );
    const projector = new PreV1TraceProjector();

    const first = await runner.run([skill], { now: NOW });
    const changedBase = {
      ...skill,
      recording: { ...skill.recording, recordingId: "rec-m2-cart-mutated" },
      observation: {
        ...skill.observation,
        graphId: "run-m2-product-mutated:observation:0",
      },
    } satisfies PreV1SkillInventoryAsset;
    const changed = {
      ...changedBase,
      declaredSourceHash: projector.sourceHash(changedBase),
    } satisfies PreV1SkillInventoryAsset;
    const second = await runner.run([changed], { now: NOW });

    expect(first.results[0]?.status).toBe("migrated");
    expect(second.results[0]).toMatchObject({
      assetId: skill.assetId,
      assetKind: "skill",
      status: "failed",
      reasonCode: "MigrationSourceChanged",
      skillSourceHash: skill.previous.contentSha256,
    });
    expect(second.results[0]?.computedSkillSourceHash).toHaveLength(64);
    expect(second.results[0]?.computedSkillSourceHash).not.toBe(
      skill.previous.contentSha256,
    );
    expect(second.results[0]?.sourceHash).toBe(changed.declaredSourceHash);
    expect(second.gate.allAssetsClassified).toBe(true);
    expect(second.gate.zeroUnexplainedFailures).toBe(true);
    expect(second.counts.failed).toBe(1);
    expect(await store.list()).toHaveLength(2);
  });

  it("treats a changed Skill source Trace payload as a new hash-bound attempt", async () => {
    const skill = await loadFixture<PreV1SkillInventoryAsset>("m2-procedure-skill.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler(
        new StandardReverifier(LocalSkillSigner.generate(), resolvingTargets),
      ),
    );
    const projector = new PreV1TraceProjector();

    const first = await runner.run([skill], { now: NOW });
    const changedBase = {
      ...skill,
      observation: {
        ...skill.observation,
        nodes: skill.observation.nodes.map((node, index) =>
          index === 0 ? { ...node, name: "Wireless Mouse Updated" } : node,
        ),
      },
    } satisfies PreV1SkillInventoryAsset;
    const changed = {
      ...changedBase,
      declaredSourceHash: projector.sourceHash(changedBase),
    } satisfies PreV1SkillInventoryAsset;
    const second = await runner.run([changed], { now: NOW });

    expect(first.results[0]?.status).toBe("migrated");
    expect(second.results[0]?.status).toBe("migrated");
    expect(second.results[0]?.sourceHash).toBe(changed.declaredSourceHash);
    expect(second.results[0]?.sourceHash).not.toBe(first.results[0]?.sourceHash);
    expect(second.results[0]?.skillSourceHash).toBe(skill.previous.contentSha256);
    expect(await store.list()).toHaveLength(2);
  });

  it("classifies a changed Skill source Trace hash as failed before reverification", async () => {
    const skill = await loadFixture<PreV1SkillInventoryAsset>("m2-procedure-skill.json");
    const store = new InMemoryObservationMigrationStore();
    let reverified = false;
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler({
        async verify() {
          reverified = true;
          throw new Error("should not reverify a corrupted source Trace");
        },
      }),
    );

    const report = await runner.run(
      [{ ...skill, declaredSourceHash: "0".repeat(64) }],
      { now: NOW },
    );

    expect(report.results[0]).toMatchObject({
      assetId: skill.assetId,
      assetKind: "skill",
      status: "failed",
      reasonCode: "SourceAssetCorrupted",
      sourceHash: skill.declaredSourceHash,
      expectedSourceHash: "0".repeat(64),
      skillSourceHash: skill.previous.contentSha256,
    });
    expect(reverified).toBe(false);
    expect(await store.list()).toHaveLength(1);
  });

  it("does not return a prior Skill success when the source Trace changed but kept the old declared hash", async () => {
    const skill = await loadFixture<PreV1SkillInventoryAsset>("m2-procedure-skill.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler(
        new StandardReverifier(LocalSkillSigner.generate(), resolvingTargets),
      ),
    );

    const first = await runner.run([skill], { now: NOW });
    const firstSourceHash = first.results[0]!.sourceHash;
    let reverified = false;
    const noReverifyRunner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler({
        async verify() {
          reverified = true;
          throw new Error("should not reverify a corrupted source Trace");
        },
      }),
    );
    const corrupted = {
      ...skill,
      observation: {
        ...skill.observation,
        graphId: `${skill.observation.graphId}:corrupted`,
      },
      declaredSourceHash: firstSourceHash,
    } satisfies PreV1SkillInventoryAsset;

    const second = await noReverifyRunner.run([corrupted], { now: NOW });

    expect(first.results[0]?.status).toBe("migrated");
    expect(second.results[0]).toMatchObject({
      assetId: skill.assetId,
      assetKind: "skill",
      status: "failed",
      reasonCode: "SourceAssetCorrupted",
      expectedSourceHash: firstSourceHash,
      skillSourceHash: skill.previous.contentSha256,
    });
    expect(second.results[0]?.sourceHash).not.toBe(firstSourceHash);
    expect(reverified).toBe(false);
    expect(await store.list()).toHaveLength(2);
  });

  it("durably appends a changed Skill content hash classification after prior success", async () => {
    const skill = await loadFixture<PreV1SkillInventoryAsset>("m2-procedure-skill.json");
    const root = await mkdtemp(join(tmpdir(), "obs-skill-inventory-"));
    const ledgerPath = join(root, "ledger.jsonl");
    const store = new FileObservationMigrationStore(ledgerPath);
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler(
        new StandardReverifier(LocalSkillSigner.generate(), resolvingTargets),
      ),
    );

    try {
      const first = await runner.run([skill], { now: NOW });
      const changed = {
        ...skill,
        previous: { ...skill.previous, contentSha256: "0".repeat(64) },
      } satisfies PreV1SkillInventoryAsset;
      const second = await runner.run([changed], { now: NOW });

      expect(first.results[0]).toMatchObject({
        status: "migrated",
        skillSourceHash: skill.previous.contentSha256,
        skillVersion: skill.previous.version,
      });
      expect(second.results[0]).toMatchObject({
        assetId: skill.assetId,
        assetKind: "skill",
        sourceHash: first.results[0]?.sourceHash,
        status: "failed",
        reasonCode: "MigrationSourceChanged",
        skillSourceHash: "0".repeat(64),
        skillVersion: skill.previous.version,
        computedSkillSourceHash: skill.previous.contentSha256,
      });

      const stored = await new FileObservationMigrationStore(ledgerPath).list();
      expect(stored).toHaveLength(2);
      expect(stored.map((entry) => entry.result.status)).toEqual([
        "migrated",
        "failed",
      ]);
      expect(stored[1]?.result).toEqual(second.results[0]);
      const raw = await readFile(ledgerPath, "utf8");
      expect(raw.trim().split("\n")).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a changed Skill version as a new hash-bound identity", async () => {
    const skill = await loadFixture<PreV1SkillInventoryAsset>("m2-procedure-skill.json");
    const store = new InMemoryObservationMigrationStore();
    const reverifier = new StandardReverifier(
      LocalSkillSigner.generate(),
      resolvingTargets,
    );
    const verify = vi.spyOn(reverifier, "verify");
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler(reverifier),
    );

    const first = await runner.run([skill], { now: NOW });
    const changedVersion = {
      ...skill,
      previous: { ...skill.previous, version: skill.previous.version + 1 },
    } satisfies PreV1SkillInventoryAsset;
    const second = await runner.run([changedVersion], { now: NOW });

    expect(first.results[0]).toMatchObject({
      status: "migrated",
      sourceHash: second.results[0]?.sourceHash,
      skillSourceHash: skill.previous.contentSha256,
      skillVersion: skill.previous.version,
    });
    expect(second.results[0]).toMatchObject({
      status: "migrated",
      skillSourceHash: skill.previous.contentSha256,
      skillVersion: changedVersion.previous.version,
    });
    expect(verify).toHaveBeenCalledTimes(2);
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

  it("looks up an existing Skill result before side-effecting reverification", async () => {
    const skill = await loadFixture<PreV1SkillInventoryAsset>("m2-procedure-skill.json");
    const store = new InMemoryObservationMigrationStore();
    const reverifier = new StandardReverifier(
      LocalSkillSigner.generate(),
      resolvingTargets,
    );
    const verify = vi.spyOn(reverifier, "verify");
    const runner = new ObservationCandidateInventoryRunner(
      store,
      new SkillRecompiler(reverifier),
    );

    const first = await runner.run([skill], { now: NOW });
    verify.mockImplementation(async () => {
      throw new Error("reverified after durable lookup");
    });
    const second = await runner.run([skill], { now: NOW });

    expect(second.results).toEqual(first.results);
    expect(verify).toHaveBeenCalledTimes(1);
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
