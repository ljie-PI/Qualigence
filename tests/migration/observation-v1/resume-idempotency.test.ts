import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  FileObservationMigrationStore,
  InMemoryObservationMigrationStore,
  ObservationMigrationRunner,
  type PreV1ObservationAsset,
} from "@qualigence/observation-migration";

const FIXTURES = new URL("../../fixtures/migration/pre-v1/", import.meta.url);

async function loadAsset(name: string): Promise<PreV1ObservationAsset> {
  const path = fileURLToPath(new URL(name, FIXTURES));
  return JSON.parse(await readFile(path, "utf8")) as PreV1ObservationAsset;
}

describe("migration runner idempotency and resume", () => {
  it("migrates a pre-v1 asset to a persisted v1 projection", async () => {
    const asset = await loadAsset("m1-web-observation.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationMigrationRunner(store);

    const result = await runner.migrate(asset);
    expect(result.status).toBe("migrated");
    expect(result.migratorVersion).toBe(runner.migratorVersion);
    expect(result.outputRef).toHaveLength(64);

    const stored = await store.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.projection?.schema.version).toBe("observation-graph/v1");
    expect(stored[0]?.metadata?.observationSchemaEpoch).toBe("pre-v1");
  });

  it("records a changed payload with a stale declared hash as failed instead of returning a prior migrated result", async () => {
    const asset = await loadAsset("m1-web-observation.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationMigrationRunner(store);

    const first = await runner.migrate(asset);
    const corrupted = {
      ...asset,
      observation: {
        ...asset.observation,
        graphId: `${asset.observation.graphId}:corrupted`,
      },
      declaredSourceHash: first.sourceHash,
    } satisfies PreV1ObservationAsset;
    const second = await runner.migrate(corrupted);

    expect(first.status).toBe("migrated");
    expect(second.status).toBe("failed");
    expect(second.reasonCode).toBe("SourceAssetCorrupted");
    expect(second.sourceHash).not.toBe(first.sourceHash);
    expect(second.expectedSourceHash).toBe(first.sourceHash);
    expect(await store.list()).toHaveLength(2);
  });

  it("is idempotent for an unchanged source (same hash + migrator)", async () => {
    const asset = await loadAsset("m1-web-observation.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationMigrationRunner(store);

    const first = await runner.migrate(asset);
    const second = await runner.migrate(asset);
    expect(second).toEqual(first);
    expect(await store.list()).toHaveLength(1);
  });

  it("treats a changed source as a new attempt", async () => {
    const asset = await loadAsset("m1-web-observation.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationMigrationRunner(store);

    const first = await runner.migrate(asset);

    const { declaredSourceHash: _omit, ...rest } = asset;
    const mutated: PreV1ObservationAsset = {
      ...rest,
      observation: {
        ...asset.observation,
        nodes: asset.observation.nodes.map((node, index) =>
          index === 0 ? { ...node, name: "Sign in NOW" } : node,
        ),
      },
    };
    const second = await runner.migrate(mutated);

    expect(second.sourceHash).not.toBe(first.sourceHash);
    expect(await store.list()).toHaveLength(2);
  });

  it("keys idempotency by migrator version as well as asset and source", async () => {
    const store = new InMemoryObservationMigrationStore();
    await store.append({
      result: {
        assetId: "asset-versioned",
        sourceHash: "hash-versioned",
        status: "migrated",
        outputRef: "output-v1",
        migratorVersion: "observation-migrator/v1",
      },
    });

    expect(
      await store.find(
        "asset-versioned",
        "hash-versioned",
        "observation-migrator/v1",
      ),
    ).toBeDefined();
    expect(
      await store.find(
        "asset-versioned",
        "hash-versioned",
        "observation-migrator/v2",
      ),
    ).toBeUndefined();
  });

  it("does not persist during a dry run", async () => {
    const asset = await loadAsset("m1-web-observation.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationMigrationRunner(store);

    const result = await runner.migrate(asset, { dryRun: true });
    expect(result.status).toBe("migrated");
    expect(await store.list()).toHaveLength(0);
  });

  it("does not report Skill assets as graph-only migrated through the trace runner", async () => {
    const skill = await loadAsset("m2-procedure-skill.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationMigrationRunner(store);

    const result = await runner.migrate(skill);

    expect(result).toMatchObject({
      assetKind: "skill",
      status: "needs_human",
      reasonCode: "SkillInventoryRunnerRequired",
      migratorVersion: runner.migratorVersion,
    });
    expect(result.outputRef).toBeUndefined();
    expect(await store.list()).toHaveLength(1);
  });

  it("serializes concurrent file-backed appends for the same binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "obs-migration-store-"));
    const ledgerPath = join(root, "ledger.jsonl");
    const record = {
      result: {
        assetId: "asset-concurrent",
        sourceHash: "hash-concurrent",
        status: "migrated" as const,
        outputRef: "output-concurrent",
        migratorVersion: "observation-migrator/v1",
      },
    };

    try {
      await Promise.all(
        Array.from({ length: 12 }, () =>
          new FileObservationMigrationStore(ledgerPath).append(record),
        ),
      );

      const raw = await readFile(ledgerPath, "utf8");
      expect(raw.trim().split("\n")).toHaveLength(1);
      const stored = await new FileObservationMigrationStore(ledgerPath).list();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toEqual(record);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a stale file-backed ledger lock left by a crashed process", async () => {
    const root = await mkdtemp(join(tmpdir(), "obs-migration-store-"));
    const ledgerPath = join(root, "ledger.jsonl");
    const record = {
      result: {
        assetId: "asset-after-crash",
        sourceHash: "hash-after-crash",
        status: "migrated" as const,
        outputRef: "output-after-crash",
        migratorVersion: "observation-migrator/v1",
      },
    };

    try {
      await writeFile(`${ledgerPath}.lock`, "999999999\n", "utf8");

      await new FileObservationMigrationStore(ledgerPath).append(record);

      const stored = await new FileObservationMigrationStore(ledgerPath).list();
      expect(stored).toEqual([record]);
      const raw = await readFile(ledgerPath, "utf8");
      expect(raw.trim().split("\n")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
