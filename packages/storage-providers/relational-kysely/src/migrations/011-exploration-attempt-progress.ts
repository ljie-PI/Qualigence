import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Migration } from "../migrations.js";
import type { Database } from "../schema.js";

/**
 * Migration 011: live exploration attempt progress and append-only live
 * checkpoint history. The original migration-004 `exploration_checkpoints`
 * table remains terminal-attempt history with its historical FK intact; this
 * additive table pair is the restart authority before a terminal
 * `benchmark_attempts` row exists.
 */
export const migration011: Migration = {
  version: 11,
  name: "exploration-attempt-progress",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("exploration_attempt_progress")
      .addColumn("attempt_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("run_id", "text", (column) =>
        column.notNull().references("benchmark_runs.run_id"),
      )
      .addColumn("source_binding_hash", "text", (column) => column.notNull())
      .addColumn("policy_binding_hash", "text", (column) => column.notNull())
      .addColumn("seed_binding_hash", "text", (column) => column.notNull())
      .addColumn("phase", "text", (column) => column.notNull())
      .addColumn("seed_cursor_json", "text", (column) => column.notNull())
      .addColumn("last_safe_step", "integer", (column) => column.notNull())
      .addColumn("last_safe_graph_fingerprint", "text")
      .addColumn("remaining_json", "text", (column) => column.notNull())
      .addColumn("in_flight_action_json", "text")
      .addColumn("terminal_reason", "text")
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "exploration_attempt_progress_phase_check",
        sql`phase IN ('seed_replay', 'exploring', 'action_in_flight', 'terminal')`,
      )
      .addCheckConstraint(
        "exploration_attempt_progress_terminal_check",
        sql`terminal_reason IS NULL OR terminal_reason IN ('objective_satisfied', 'no_safe_action', 'state_repeated', 'budget_exhausted', 'policy_denied', 'plan_diverged', 'finding_created', 'error')`,
      )
      .addCheckConstraint(
        "exploration_attempt_progress_version_check",
        sql`version >= 1`,
      )
      .execute();

    await db.schema
      .createTable("exploration_live_checkpoints")
      .addColumn("attempt_id", "text", (column) =>
        column.notNull().references("exploration_attempt_progress.attempt_id"),
      )
      .addColumn("step", "integer", (column) => column.notNull())
      .addColumn("graph_fingerprint", "text", (column) => column.notNull())
      .addColumn("remaining_json", "text", (column) => column.notNull())
      .addColumn("terminal_reason", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("exploration_live_checkpoints_pk", [
        "attempt_id",
        "step",
      ])
      .addCheckConstraint(
        "exploration_live_checkpoints_terminal_check",
        sql`terminal_reason IS NULL OR terminal_reason IN ('objective_satisfied', 'no_safe_action', 'state_repeated', 'budget_exhausted', 'policy_denied', 'plan_diverged', 'finding_created', 'error')`,
      )
      .execute();
  },
};
