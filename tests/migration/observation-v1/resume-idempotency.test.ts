import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
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

  it("records a hash mismatch as a failed attempt instead of returning a prior migrated result", async () => {
    const asset = await loadAsset("m1-web-observation.json");
    const store = new InMemoryObservationMigrationStore();
    const runner = new ObservationMigrationRunner(store);

    const first = await runner.migrate(asset);
    const corrupted = { ...asset, declaredSourceHash: "0".repeat(64) };
    const second = await runner.migrate(corrupted);

    expect(first.status).toBe("migrated");
    expect(second.status).toBe("failed");
    expect(second.reasonCode).toBe("SourceAssetCorrupted");
    expect(second.sourceHash).toBe("0".repeat(64));
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
});
