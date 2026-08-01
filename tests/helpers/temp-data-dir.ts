import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { LocalArtifactStore } from "@qualigence/artifact-fs";
import type {
  ArtifactManifest,
  ExecutionRunRecord,
  ModelInvocationSummary,
} from "@qualigence/evidence";
import type { TraceEvent } from "@qualigence/runner-protocol";
import { SystemClock } from "@qualigence/shared-kernel";
import {
  SqliteArtifactManifestStore,
  SqliteModelInvocationStore,
  SqliteRunStore,
  SqliteRuntime,
  SqliteTraceStore,
} from "@qualigence/sqlite-runtime";

const DATABASE_FILE = "qualigence.db";
const ARTIFACT_DIR = "artifacts";
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface PersistedRunState {
  readonly run: ExecutionRunRecord | undefined;
  readonly traceEvents: readonly TraceEvent[];
  readonly traceStages: readonly string[];
  readonly manifests: readonly ArtifactManifest[];
  readonly modelInvocations: readonly ModelInvocationSummary[];
}

export interface TempDataDir {
  /** Absolute path passed to the CLI as `QUALIGENCE_DATA_DIR`. */
  readonly path: string;
  /** Marks the directory to be kept by {@link cleanup} for failure diagnostics. */
  preserve(): void;
  /** Reopens the persisted SQLite state for a Run through public store readers. */
  readPersistedRun(runId: string): Promise<PersistedRunState>;
  /** Verifies every Artifact's on-disk bytes match its manifest size and SHA-256. */
  verifyArtifacts(runId: string): Promise<boolean>;
  /** Lists every file written under the data directory (recursively). */
  listFiles(): Promise<readonly string[]>;
  /** Removes the directory unless {@link preserve} was called; prints its path if kept. */
  cleanup(): Promise<void>;
}

/**
 * Creates an isolated SQLite + Artifact data directory under the project (never
 * `/tmp`). A passing test calls {@link TempDataDir.cleanup} to delete it; a
 * failing test calls {@link TempDataDir.preserve} first so the absolute path is
 * printed and the evidence is kept for diagnosis.
 */
export async function withTempDataDir(testName: string): Promise<TempDataDir> {
  const safeName = testName.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 40);
  const path = await mkdtemp(join(process.cwd(), `.tmp-e2e-${safeName}-`));
  let preserved = false;

  async function openRuntime(): Promise<SqliteRuntime> {
    return SqliteRuntime.open({
      filename: join(path, DATABASE_FILE),
      busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
      clock: new SystemClock(),
    });
  }

  return {
    path,
    preserve() {
      preserved = true;
    },
    async readPersistedRun(runId: string): Promise<PersistedRunState> {
      const runtime = await openRuntime();
      try {
        const run = await new SqliteRunStore(runtime).get(runId);
        const traceStore = new SqliteTraceStore(runtime, new SystemClock());
        const next = await traceStore.nextTraceSequenceNumber(runId);
        const traceEvents: TraceEvent[] = [];
        for (let sequence = 1; sequence < next; sequence += 1) {
          const event = await traceStore.eventAt(runId, sequence);
          if (event !== undefined) {
            traceEvents.push(event);
          }
        }
        const manifests = await new SqliteArtifactManifestStore(runtime).listForRun(
          runId,
        );
        const modelInvocations = await new SqliteModelInvocationStore(
          runtime,
        ).listForRun(runId);
        return {
          run,
          traceEvents,
          traceStages: traceEvents.map((event) => event.stage),
          manifests,
          modelInvocations,
        };
      } finally {
        await runtime.close();
      }
    },
    async verifyArtifacts(runId: string): Promise<boolean> {
      const runtime = await openRuntime();
      let manifests: readonly ArtifactManifest[];
      try {
        manifests = await new SqliteArtifactManifestStore(runtime).listForRun(runId);
      } finally {
        await runtime.close();
      }
      const artifacts = new LocalArtifactStore(join(path, ARTIFACT_DIR), new SystemClock());
      for (const manifest of manifests) {
        if (!/^[0-9a-f]{64}$/.test(manifest.sha256) || manifest.size <= 0) {
          return false;
        }
        if (!(await artifacts.verify(manifest))) {
          return false;
        }
      }
      return manifests.length > 0;
    },
    async listFiles(): Promise<readonly string[]> {
      return collectFiles(path);
    },
    async cleanup(): Promise<void> {
      if (preserved) {
        process.stderr.write(`[e2e] preserved diagnostics at ${path}\n`);
        return;
      }
      await rm(path, { recursive: true, force: true });
    },
  };
}

async function collectFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else {
      const info = await stat(full);
      if (info.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}
