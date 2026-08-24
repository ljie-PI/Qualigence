import type {
  BenchmarkAttempt,
  DetectionBenchmarkReport,
} from "@qualigence/benchmarking-detection";
import type {
  ExplorationAttemptProgress,
  ExplorationBudgetSnapshot,
  ExplorationCheckpoint,
  ExplorationInFlightAction,
  ExplorationProgressPhase,
  ExplorationSeedCursor,
  ExplorationTerminalReason,
} from "@qualigence/mission";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

/** The immutable identity of one benchmark run, saved before any attempt. */
export interface BenchmarkRunRecord {
  readonly runId: string;
  readonly benchmarkVersion: string;
  readonly manifestSha256: string;
  readonly profileSha256: string;
  readonly groundTruthSha256: string;
  readonly createdAt: string;
}

/** One append-only attempt together with its exploration terminal reason. */
export interface PersistedAttempt {
  readonly attempt: BenchmarkAttempt;
  readonly terminalReason: string;
  readonly checkpoints: readonly ExplorationCheckpoint[];
  readonly createdAt: string;
}

export interface NewExplorationAttemptProgressRecord {
  readonly attemptId: string;
  readonly runId: string;
  readonly sourceBindingHash: string;
  readonly policyBindingHash: string;
  readonly seedBindingHash: string;
  readonly phase: ExplorationProgressPhase;
  readonly seedCursor: ExplorationSeedCursor;
  readonly lastSafeStep: number;
  readonly lastSafeGraphFingerprint?: string | undefined;
  readonly remaining: ExplorationBudgetSnapshot;
  readonly inFlightAction?: ExplorationInFlightAction | undefined;
  readonly terminalReason?: ExplorationTerminalReason | undefined;
}

export interface ExplorationAttemptProgressUpdate {
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly phase: ExplorationProgressPhase;
  readonly seedCursor: ExplorationSeedCursor;
  readonly lastSafeStep: number;
  readonly lastSafeGraphFingerprint?: string | undefined;
  readonly remaining: ExplorationBudgetSnapshot;
  readonly inFlightAction?: ExplorationInFlightAction | undefined;
  readonly terminalReason?: ExplorationTerminalReason | undefined;
  readonly checkpoint?: ExplorationCheckpoint | undefined;
}

export type ExplorationAttemptProgressUpdateResult =
  | { readonly status: "updated"; readonly progress: ExplorationAttemptProgress }
  | { readonly status: "conflict"; readonly current?: ExplorationAttemptProgress | undefined };

export interface SqliteBenchmarkStoreOptions {
  readonly now?: () => string;
}

/**
 * SQLite-backed durable storage for exploration/benchmark runs (LS-09). It
 * writes into the migration-004 tables: a run's identity, its append-only
 * attempts with detection findings, the per-attempt exploration checkpoints, and
 * the immutable hash-linked report. Attempts and checkpoints are append-only
 * (`onConflict` does nothing) so re-running an identical, deterministic
 * benchmark never rewrites history. The persisted report always carries the
 * scorer-derived `profileStatus`, so an Unverified run can never be stored as a
 * Reference-Profile pass.
 */
export class SqliteBenchmarkStore {
  constructor(
    private readonly runtime: SqliteRuntime,
    private readonly options: SqliteBenchmarkStoreOptions = {},
  ) {}

  async saveRun(run: BenchmarkRunRecord): Promise<void> {
    await this.runtime.db
      .insertInto("benchmark_runs")
      .values({
        run_id: run.runId,
        benchmark_version: run.benchmarkVersion,
        manifest_sha256: run.manifestSha256,
        profile_sha256: run.profileSha256,
        ground_truth_sha256: run.groundTruthSha256,
        created_at: run.createdAt,
      })
      .onConflict((oc) => oc.column("run_id").doNothing())
      .execute();
  }

  async appendAttempt(runId: string, persisted: PersistedAttempt): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      const db = this.runtime.db;
      await db
        .insertInto("benchmark_attempts")
        .values({
          attempt_id: persisted.attempt.attemptId,
          run_id: runId,
          profile_sha256: persisted.attempt.profileSha256,
          scenario_id: persisted.attempt.scenarioId,
          mode: persisted.attempt.mode,
          repetition: persisted.attempt.repetition,
          terminal_reason: persisted.terminalReason,
          findings_json: JSON.stringify(persisted.attempt.findings),
          created_at: persisted.createdAt,
        })
        .onConflict((oc) => oc.column("attempt_id").doNothing())
        .execute();

      for (const checkpoint of persisted.checkpoints) {
        await db
          .insertInto("exploration_checkpoints")
          .values({
            attempt_id: persisted.attempt.attemptId,
            step: checkpoint.step,
            graph_fingerprint: checkpoint.graphFingerprint,
            remaining_json: JSON.stringify(checkpoint.remaining),
            terminal_reason: checkpoint.terminalReason ?? null,
          })
          .onConflict((oc) => oc.columns(["attempt_id", "step"]).doNothing())
          .execute();
      }
    });
  }

  async loadAttemptProgress(attemptId: string): Promise<ExplorationAttemptProgress | undefined> {
    const row = await this.runtime.db
      .selectFrom("exploration_attempt_progress")
      .selectAll()
      .where("attempt_id", "=", attemptId)
      .executeTakeFirst();
    return row === undefined ? undefined : mapProgress(row);
  }

  async initializeAttemptProgress(
    progress: NewExplorationAttemptProgressRecord,
  ): Promise<ExplorationAttemptProgress> {
    const now = this.now();
    await this.runtime.db
      .insertInto("exploration_attempt_progress")
      .values({
        attempt_id: progress.attemptId,
        run_id: progress.runId,
        source_binding_hash: progress.sourceBindingHash,
        policy_binding_hash: progress.policyBindingHash,
        seed_binding_hash: progress.seedBindingHash,
        phase: progress.phase,
        seed_cursor_json: JSON.stringify(progress.seedCursor),
        last_safe_step: progress.lastSafeStep,
        last_safe_graph_fingerprint: progress.lastSafeGraphFingerprint ?? null,
        remaining_json: JSON.stringify(progress.remaining),
        in_flight_action_json: progress.inFlightAction === undefined ? null : JSON.stringify(progress.inFlightAction),
        terminal_reason: progress.terminalReason ?? null,
        version: 1,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column("attempt_id").doNothing())
      .execute();

    const loaded = await this.loadAttemptProgress(progress.attemptId);
    if (loaded === undefined) {
      throw new Error("ExplorationProgressInitializationFailed");
    }
    return loaded;
  }

  async compareAndSetAttemptProgress(
    update: ExplorationAttemptProgressUpdate,
  ): Promise<ExplorationAttemptProgressUpdateResult> {
    return runInImmediateTransaction(this.runtime, async () => {
      const current = await this.loadAttemptProgress(update.attemptId);
      if (current === undefined || current.version !== update.expectedVersion) {
        return { status: "conflict", current };
      }

      const now = this.now();
      if (update.checkpoint !== undefined) {
        await this.runtime.db
          .insertInto("exploration_live_checkpoints")
          .values({
            attempt_id: update.attemptId,
            step: update.checkpoint.step,
            graph_fingerprint: update.checkpoint.graphFingerprint,
            remaining_json: JSON.stringify(update.checkpoint.remaining),
            terminal_reason: update.checkpoint.terminalReason ?? null,
            created_at: now,
          })
          .onConflict((oc) => oc.columns(["attempt_id", "step"]).doNothing())
          .execute();
      }

      await this.runtime.db
        .updateTable("exploration_attempt_progress")
        .set({
          phase: update.phase,
          seed_cursor_json: JSON.stringify(update.seedCursor),
          last_safe_step: update.lastSafeStep,
          last_safe_graph_fingerprint: update.lastSafeGraphFingerprint ?? null,
          remaining_json: JSON.stringify(update.remaining),
          in_flight_action_json: update.inFlightAction === undefined ? null : JSON.stringify(update.inFlightAction),
          terminal_reason: update.terminalReason ?? null,
          version: current.version + 1,
          updated_at: now,
        })
        .where("attempt_id", "=", update.attemptId)
        .where("version", "=", update.expectedVersion)
        .executeTakeFirstOrThrow();

      const saved = await this.loadAttemptProgress(update.attemptId);
      if (saved === undefined) {
        throw new Error("ExplorationProgressUpdateLost");
      }
      return { status: "updated", progress: saved };
    });
  }

  async liveCheckpointsForAttempt(attemptId: string): Promise<readonly ExplorationCheckpoint[]> {
    const rows = await this.runtime.db
      .selectFrom("exploration_live_checkpoints")
      .selectAll()
      .where("attempt_id", "=", attemptId)
      .orderBy("step", "asc")
      .execute();
    return rows.map((row) => ({
      step: row.step,
      graphFingerprint: row.graph_fingerprint,
      remaining: JSON.parse(row.remaining_json) as ExplorationBudgetSnapshot,
      ...(row.terminal_reason === null ? {} : { terminalReason: row.terminal_reason as ExplorationTerminalReason }),
    }));
  }

  async saveReport(runId: string, report: DetectionBenchmarkReport): Promise<void> {
    await this.runtime.db
      .insertInto("benchmark_reports")
      .values({
        report_id: report.reportId,
        run_id: runId,
        profile_status: report.profileStatus,
        gate_status: report.gate.status,
        failure_codes_json: JSON.stringify(report.gate.failureCodes),
        report_json: JSON.stringify(report),
        created_at: report.createdAt,
      })
      .onConflict((oc) => oc.column("report_id").doNothing())
      .execute();
  }

  async attemptsForRun(runId: string): Promise<readonly BenchmarkAttempt[]> {
    const rows = await this.runtime.db
      .selectFrom("benchmark_attempts")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("attempt_id", "asc")
      .execute();
    return rows.map((row) => ({
      attemptId: row.attempt_id,
      profileSha256: row.profile_sha256,
      scenarioId: row.scenario_id,
      mode: row.mode === "normal" ? "normal" : "fault",
      repetition: row.repetition,
      findings: JSON.parse(row.findings_json) as BenchmarkAttempt["findings"],
    }));
  }

  async reportForRun(runId: string): Promise<DetectionBenchmarkReport | undefined> {
    const row = await this.runtime.db
      .selectFrom("benchmark_reports")
      .select("report_json")
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : (JSON.parse(row.report_json) as DetectionBenchmarkReport);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

interface ProgressRow {
  readonly attempt_id: string;
  readonly run_id: string;
  readonly source_binding_hash: string;
  readonly policy_binding_hash: string;
  readonly seed_binding_hash: string;
  readonly phase: string;
  readonly seed_cursor_json: string;
  readonly last_safe_step: number;
  readonly last_safe_graph_fingerprint: string | null;
  readonly remaining_json: string;
  readonly in_flight_action_json: string | null;
  readonly terminal_reason: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function mapProgress(row: ProgressRow): ExplorationAttemptProgress {
  return {
    attemptId: row.attempt_id,
    runId: row.run_id,
    sourceBindingHash: row.source_binding_hash,
    policyBindingHash: row.policy_binding_hash,
    seedBindingHash: row.seed_binding_hash,
    phase: row.phase as ExplorationProgressPhase,
    seedCursor: JSON.parse(row.seed_cursor_json) as ExplorationSeedCursor,
    lastSafeStep: row.last_safe_step,
    ...(row.last_safe_graph_fingerprint === null ? {} : { lastSafeGraphFingerprint: row.last_safe_graph_fingerprint }),
    remaining: JSON.parse(row.remaining_json) as ExplorationBudgetSnapshot,
    ...(row.in_flight_action_json === null ? {} : { inFlightAction: JSON.parse(row.in_flight_action_json) as ExplorationInFlightAction }),
    ...(row.terminal_reason === null ? {} : { terminalReason: row.terminal_reason as ExplorationTerminalReason }),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
