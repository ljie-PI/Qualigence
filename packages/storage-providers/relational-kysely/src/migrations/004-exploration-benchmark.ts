import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../schema.js";
import type { Migration } from "../migrations.js";

/**
 * Migration 004 (LS-09): durable exploration/benchmark storage. Strictly
 * additive relative to migrations 001, 002 and 003 — it never alters an existing
 * table. It introduces the tables that persist a benchmark run's identity, its
 * append-only attempts (one scenario x one repetition, with the detection
 * findings), the per-attempt exploration checkpoints committed alongside budget
 * consumption, and the immutable, hash-linked benchmark reports. Reports record
 * the derived `profile_status` so an Unverified run is never persisted as a
 * Reference-Profile pass.
 */
export const migration004: Migration = {
  version: 4,
  name: "exploration-benchmark",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("benchmark_runs")
      .addColumn("run_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("benchmark_version", "text", (column) => column.notNull())
      .addColumn("manifest_sha256", "text", (column) => column.notNull())
      .addColumn("profile_sha256", "text", (column) => column.notNull())
      .addColumn("ground_truth_sha256", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("benchmark_attempts")
      .addColumn("attempt_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("run_id", "text", (column) =>
        column.notNull().references("benchmark_runs.run_id"),
      )
      .addColumn("profile_sha256", "text", (column) => column.notNull())
      .addColumn("scenario_id", "text", (column) => column.notNull())
      .addColumn("mode", "text", (column) => column.notNull())
      .addColumn("repetition", "integer", (column) => column.notNull())
      .addColumn("terminal_reason", "text", (column) => column.notNull())
      .addColumn("findings_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "benchmark_attempts_mode_check",
        sql`mode IN ('normal', 'fault')`,
      )
      .execute();

    await db.schema
      .createTable("exploration_checkpoints")
      .addColumn("attempt_id", "text", (column) =>
        column.notNull().references("benchmark_attempts.attempt_id"),
      )
      .addColumn("step", "integer", (column) => column.notNull())
      .addColumn("graph_fingerprint", "text", (column) => column.notNull())
      .addColumn("remaining_json", "text", (column) => column.notNull())
      .addColumn("terminal_reason", "text")
      .addPrimaryKeyConstraint("exploration_checkpoints_pk", [
        "attempt_id",
        "step",
      ])
      .execute();

    await db.schema
      .createTable("benchmark_reports")
      .addColumn("report_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("run_id", "text", (column) =>
        column.notNull().references("benchmark_runs.run_id"),
      )
      .addColumn("profile_status", "text", (column) => column.notNull())
      .addColumn("gate_status", "text", (column) => column.notNull())
      .addColumn("failure_codes_json", "text", (column) => column.notNull())
      .addColumn("report_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "benchmark_reports_profile_status_check",
        sql`profile_status IN ('reference', 'unverified')`,
      )
      .addCheckConstraint(
        "benchmark_reports_gate_status_check",
        sql`gate_status IN ('passed', 'failed', 'unverified')`,
      )
      .execute();
  },
};
