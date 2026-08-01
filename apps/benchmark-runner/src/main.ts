import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SqliteBenchmarkStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import { loadBenchmark } from "./loader.js";
import { runBenchmark, type BenchmarkStore } from "./run.js";

interface CliOptions {
  readonly manifestDir: string;
  readonly outputPath?: string;
  readonly databasePath?: string;
}

class CliUsageError extends Error {}

function parseArgs(argv: readonly string[]): CliOptions {
  if (argv[0] !== "run") {
    throw new CliUsageError('Usage: qualigence-benchmark run --manifest <dir> [--output <report.json>] [--db <path>]');
  }
  let manifestDir: string | undefined;
  let outputPath: string | undefined;
  let databasePath: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--manifest":
      case "--manifest-dir":
        manifestDir = requireValue(flag, value);
        index += 1;
        break;
      case "--output":
        outputPath = requireValue(flag, value);
        index += 1;
        break;
      case "--db":
      case "--database":
        databasePath = requireValue(flag, value);
        index += 1;
        break;
      default:
        throw new CliUsageError(`Unknown argument "${String(flag)}".`);
    }
  }
  if (manifestDir === undefined) {
    throw new CliUsageError("--manifest <dir> is required.");
  }
  return {
    manifestDir,
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(databasePath === undefined ? {} : { databasePath }),
  };
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value.`);
  }
  return value;
}

/**
 * Run the Detection Benchmark from the command line. Loads and validates the
 * frozen manifest/fixtures/ground truth, drives real bounded exploration, scores
 * with the frozen scorer, optionally persists into a SQLite database, writes the
 * hash-linked report, and returns the release-gate exit code (0 = passed).
 */
export async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const loaded = await loadBenchmark(options.manifestDir);

  let runtime: SqliteRuntime | undefined;
  let store: BenchmarkStore | undefined;
  if (options.databasePath !== undefined) {
    runtime = await SqliteRuntime.open({ filename: options.databasePath, busyTimeoutMs: 5_000 });
    store = new SqliteBenchmarkStore(runtime);
  }

  try {
    const outcome = await runBenchmark({
      manifest: loaded.manifest,
      groundTruth: loaded.groundTruth,
      scenarios: loaded.scenarios,
      ...(store === undefined ? {} : { store }),
      createdAt: new Date().toISOString(),
    });

    const serialized = `${JSON.stringify(outcome.report, null, 2)}\n`;
    if (options.outputPath !== undefined) {
      await mkdir(dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, serialized, "utf8");
    } else {
      process.stdout.write(serialized);
    }
    process.stderr.write(
      `benchmark ${outcome.report.benchmarkVersion} profile=${outcome.report.profileStatus} gate=${outcome.report.gate.status}\n`,
    );
    return outcome.exitCode;
  } finally {
    if (runtime !== undefined) {
      await runtime.close();
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
