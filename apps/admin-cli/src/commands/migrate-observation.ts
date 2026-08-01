import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ObservationMigrationRunner,
  InMemoryObservationMigrationStore,
  FileObservationMigrationStore,
  buildFreezeReport,
  type ObservationMigrationStore,
  type ObservationMigrationResult,
  type ObservationFreezeReportV1,
  type PreV1ObservationAsset,
} from "@qualigence/observation-migration";
import { AdminCliError } from "./../errors.js";

/** The set of pre-v1 assets a migration run must process. */
export interface ObservationMigrationSource {
  inventory(): Promise<readonly PreV1ObservationAsset[]>;
}

export interface MigrateObservationOptions {
  /** When true, project and classify but persist nothing. */
  readonly dryRun: boolean;
  /** Durable JSONL ledger path (required for an executed, resumable run). */
  readonly ledgerPath?: string;
  /** Directory of pre-v1 asset JSON envelopes to inventory. */
  readonly inputDir?: string;
  /** Where to atomically write the candidate Freeze Report JSON. */
  readonly reportPath?: string;
}

export interface MigrateObservationDeps {
  /** Overrides the default directory-backed inventory source. */
  readonly source?: ObservationMigrationSource;
  /** Overrides the default ledger-backed durable store. */
  readonly store?: ObservationMigrationStore;
  readonly now?: () => string;
}

export interface MigrateObservationResult {
  /** Number of NEW ledger entries persisted (always 0 for a dry-run). */
  readonly writes: number;
  readonly report: ObservationFreezeReportV1;
}

/**
 * A real, filesystem-backed inventory source: every `*.json` file in a directory
 * is read as a {@link PreV1ObservationAsset} envelope. This lets an operator
 * point the command at an exported dump of historical pre-v1 assets without the
 * migration package depending on any particular storage provider.
 */
export class DirectoryObservationMigrationSource
  implements ObservationMigrationSource
{
  constructor(private readonly inputDir: string) {}

  async inventory(): Promise<readonly PreV1ObservationAsset[]> {
    let entries: string[];
    try {
      entries = await readdir(this.inputDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AdminCliError(
          "MigrationBlocked",
          `observation inventory directory not found: ${this.inputDir}`,
        );
      }
      throw error;
    }
    const files = entries.filter((name) => name.endsWith(".json")).sort();
    const assets: PreV1ObservationAsset[] = [];
    for (const file of files) {
      const raw = await readFile(join(this.inputDir, file), "utf8");
      assets.push(JSON.parse(raw) as PreV1ObservationAsset);
    }
    return assets;
  }
}

/**
 * Run the Observation Graph v1 candidate migration across a full pre-v1
 * inventory and produce an immutable candidate Freeze Report.
 *
 * An executed run refuses to proceed without a durable ledger (`--ledger`) so a
 * migration can always resume after a crash and never silently loses its record.
 * Each asset is projected/classified idempotently by the runner; the report
 * tallies every outcome and pins the status to `candidate` — this command can
 * never emit a `frozen` report, which is reserved for the LS-13 M3 Gate.
 */
export async function runMigrateObservation(
  options: MigrateObservationOptions,
  deps: MigrateObservationDeps = {},
): Promise<MigrateObservationResult> {
  const source =
    deps.source ??
    new DirectoryObservationMigrationSource(
      requireOption(options.inputDir, "--input <dir> is required"),
    );

  let store: ObservationMigrationStore;
  if (deps.store !== undefined) {
    store = deps.store;
  } else if (options.dryRun) {
    store = new InMemoryObservationMigrationStore();
  } else {
    // A durable, resumable run must be backed by a ledger; refuse otherwise.
    store = new FileObservationMigrationStore(
      requireOption(
        options.ledgerPath,
        "--ledger <path> is required to execute a durable migration",
      ),
    );
  }

  const runner = new ObservationMigrationRunner(store);
  const inventory = await source.inventory();
  const before = (await store.list()).length;

  const results: ObservationMigrationResult[] = [];
  for (const asset of inventory) {
    results.push(await runner.migrate(asset, { dryRun: options.dryRun }));
  }

  const after = (await store.list()).length;
  const report = buildFreezeReport(results, deps.now);

  if (options.reportPath !== undefined) {
    await writeAtomicJson(options.reportPath, report);
  }

  return { writes: options.dryRun ? 0 : after - before, report };
}

function requireOption(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") {
    throw new AdminCliError("MigrationBlocked", message);
  }
  return value;
}

/** Write JSON to a path via temp-file + atomic rename, so readers never see a torn report. */
async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
