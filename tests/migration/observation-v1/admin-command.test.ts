import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { runMigrateObservation } from "@qualigence/admin-cli";
import { AdminCliError } from "@qualigence/admin-cli";
import type { PreV1ObservationAsset } from "@qualigence/observation-migration";

const NOW = () => "2026-08-01T12:00:00.000Z";

async function loadGoodAsset(): Promise<PreV1ObservationAsset> {
  const path = fileURLToPath(
    new URL(
      "../../fixtures/migration/pre-v1/m1-web-observation.json",
      import.meta.url,
    ),
  );
  return JSON.parse(await readFile(path, "utf8")) as PreV1ObservationAsset;
}

/** Clone a good asset under a fresh id so the inventory has distinct entries. */
function withId(asset: PreV1ObservationAsset, assetId: string): PreV1ObservationAsset {
  const { declaredSourceHash: _drop, ...rest } = asset;
  return {
    ...rest,
    assetId,
    observation: {
      ...asset.observation,
      graphId: `${assetId}:observation:0`,
    },
  };
}

describe("qualigence migrate-observation admin command", () => {
  let root: string;
  let inputDir: string;
  let ledgerPath: string;
  let reportPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), ".tmp-migrate-obs-"));
    inputDir = join(root, "input");
    ledgerPath = join(root, "ledger.jsonl");
    reportPath = join(root, "freeze-report.json");
    await mkdir(inputDir, { recursive: true });
    const base = await loadGoodAsset();
    for (const id of ["asset-a", "asset-b", "asset-c"]) {
      await writeFile(
        join(inputDir, `${id}.json`),
        JSON.stringify(withId(base, id)),
        "utf8",
      );
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("dry-run projects the full inventory but persists nothing", async () => {
    const result = await runMigrateObservation(
      { dryRun: true, inputDir, reportPath },
      { now: NOW },
    );

    expect(result.writes).toBe(0);
    expect(result.report.counts.inventory).toBe(3);
    // A dry-run writes no durable ledger.
    await expect(readFile(ledgerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("executes, persists a durable ledger and resumes idempotently", async () => {
    const first = await runMigrateObservation(
      { dryRun: false, inputDir, ledgerPath, reportPath },
      { now: NOW },
    );
    expect(first.writes).toBe(3);

    const ledger = await readFile(ledgerPath, "utf8");
    expect(ledger.trim().split("\n")).toHaveLength(3);

    // A second run over the unchanged inventory resumes and re-writes nothing.
    const second = await runMigrateObservation(
      { dryRun: false, inputDir, ledgerPath, reportPath },
      { now: NOW },
    );
    expect(second.writes).toBe(0);
    expect(second.report.counts).toEqual(first.report.counts);
  });

  it("produces a candidate Freeze Report with zero unexplained failures", async () => {
    const result = await runMigrateObservation(
      { dryRun: false, inputDir, ledgerPath, reportPath },
      { now: NOW },
    );

    const report = result.report;
    expect(report.status).toBe("candidate");
    expect(report.counts.failed).toBe(0);
    expect(report.counts.inventory).toBe(
      report.counts.migrated + report.counts.deprecated + report.counts.needsHuman,
    );
    expect(report.unexplainedFailures).toEqual([]);
    expect(report.gate.zeroUnexplainedFailures).toBe(true);
    expect(report.gate.allAssetsClassified).toBe(true);
  });

  it("never emits a frozen report — status stays candidate on disk", async () => {
    await runMigrateObservation(
      { dryRun: false, inputDir, ledgerPath, reportPath },
      { now: NOW },
    );

    const raw = await readFile(reportPath, "utf8");
    const parsed = JSON.parse(raw) as { status: string; gate: { frozen: boolean } };
    expect(parsed.status).toBe("candidate");
    expect(parsed.gate.frozen).toBe(false);
    expect(raw).not.toContain('"status": "frozen"');
  });

  it("refuses an executed migration with no durable ledger", async () => {
    await expect(
      runMigrateObservation({ dryRun: false, inputDir }, { now: NOW }),
    ).rejects.toBeInstanceOf(AdminCliError);
  });
});
