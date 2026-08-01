import type {
  BenchmarkAttempt,
  DetectionBenchmarkReport,
} from "@qualigence/benchmarking-detection";
import type { ExplorationCheckpoint } from "@qualigence/mission";
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
  constructor(private readonly runtime: SqliteRuntime) {}

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
}
