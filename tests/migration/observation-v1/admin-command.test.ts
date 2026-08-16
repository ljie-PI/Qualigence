import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { runMigrateObservation } from "@qualigence/admin-cli";
import { AdminCliError } from "@qualigence/admin-cli";
import type { PreV1ObservationAsset } from "@qualigence/observation-migration";
import { run } from "../../../apps/admin-cli/src/main.js";
import { runDoctor } from "../../../apps/admin-cli/src/commands/doctor.js";
import type { SelfHostedAdminConfig } from "@qualigence/admin-cli";

vi.mock("pg", () => {
  class Client {
    async connect(): Promise<void> {}
    async end(): Promise<void> {}
    async query<T>(query: string): Promise<{ rows: T[] }> {
      if (query.includes("pg_roles")) {
        return { rows: [{ rolsuper: false, rolbypassrls: false } as T] };
      }
      if (query.includes("count")) {
        return { rows: [{ count: "0" } as T] };
      }
      return { rows: [] };
    }
  }
  return { default: { Client } };
});

vi.mock("../../../apps/admin-cli/src/s3-ops.js", () => ({
  createS3Client: () => ({ destroy: () => undefined }),
  headBucket: async () => undefined,
}));

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

describe("qualigence admin command parsing", () => {
  it("renders every operator command through injected output", async () => {
    const lines: string[] = [];
    const exits: number[] = [];

    await run(
      ["--help"],
      {
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
        exit: (code) => exits.push(code),
      },
      {},
    );

    expect(lines.join("\n")).toContain("migrate");
    expect(lines.join("\n")).toContain("doctor");
    expect(lines.join("\n")).toContain("backup");
    expect(lines.join("\n")).toContain("restore");
    expect(exits).toEqual([]);
  });

  it("requests a non-zero exit for an unknown command", async () => {
    const exits: number[] = [];

    await run(
      ["unknown-command"],
      { out: () => undefined, err: () => undefined, exit: (code) => exits.push(code) },
      {},
    );

    expect(exits.some((code) => code !== 0)).toBe(true);
  });
});

describe("qualigence doctor KMS health check", () => {
  it("fails closed when the KMS is unavailable", async () => {
    const config: SelfHostedAdminConfig = {
      postgres: {
        admin: { host: "localhost", port: 5432, database: "qualigence", user: "admin", password: "admin" },
        server: { name: "server", password: "server" },
        worker: { name: "worker", password: "worker" },
      },
      s3: {
        region: "us-east-1",
        bucket: "qualigence",
        accessKeyId: "access",
        secretAccessKey: "secret",
        forcePathStyle: true,
      },
      kms: { rootKey: new Uint8Array(32) },
      server: { baseUrl: "http://server.test" },
      backupDir: ".",
      productVersion: "0.1.0-test",
      secretFiles: [],
    };

    const report = await runDoctor(config, {
      kmsAvailable: false,
      httpProbe: async () => ({ ok: true, status: 200 }),
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "kms", status: "fail", code: "KmsUnavailable" }),
    );
    expect(report.status).toBe("unhealthy");
  });
});
