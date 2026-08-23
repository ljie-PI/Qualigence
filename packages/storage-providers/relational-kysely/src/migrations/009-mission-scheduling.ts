import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../schema.js";
import type { Migration } from "../migrations.js";

export const migration009: Migration = {
  version: 9,
  name: "mission-scheduling",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("mission_scheduling_heads")
      .addColumn("mission_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("mission_revision", "integer", (column) => column.notNull())
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("compiled_hash", "text", (column) => column.notNull())
      .addForeignKeyConstraint("mission_scheduling_heads_mission_fk", ["mission_id", "mission_revision"], "missions", ["mission_id", "revision"])
      .execute();
    await sql`
      insert into mission_scheduling_heads (mission_id, mission_revision, version, compiled_hash)
      select current.mission_id, current.revision, 1, current.compiled_hash
      from missions current
      where not exists (
        select 1 from missions newer
        where newer.mission_id = current.mission_id and newer.revision > current.revision
      )
    `.execute(db);

    await db.schema
      .createTable("mission_start_commands")
      .addColumn("idempotency_key", "text", (column) => column.primaryKey().notNull())
      .addColumn("command_hash", "text", (column) => column.notNull())
      .addColumn("mission_id", "text", (column) => column.notNull())
      .addColumn("expected_mission_version", "integer", (column) => column.notNull())
      .addColumn("mission_revision", "integer", (column) => column.notNull())
      .addColumn("mission_compiled_hash", "text", (column) => column.notNull())
      .addColumn("mission_snapshot_json", "text", (column) => column.notNull())
      .addColumn("result_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addUniqueConstraint("mission_start_commands_mission_unique", ["mission_id"])
      .addForeignKeyConstraint("mission_start_commands_mission_fk", ["mission_id", "mission_revision"], "missions", ["mission_id", "revision"])
      .execute();

    await db.schema
      .createTable("mission_job_attempts")
      .addColumn("attempt_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("mission_id", "text", (column) => column.notNull())
      .addColumn("mission_revision", "integer", (column) => column.notNull())
      .addColumn("logical_job_id", "text", (column) => column.notNull().references("execution_jobs.job_id"))
      .addColumn("runner_job_id", "text", (column) => column.notNull().unique())
      .addColumn("run_id", "text", (column) => column.notNull().unique().references("execution_runs.run_id"))
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addForeignKeyConstraint("mission_job_attempts_mission_fk", ["mission_id", "mission_revision"], "missions", ["mission_id", "revision"])
      .addCheckConstraint("mission_job_attempts_status_check", sql`status IN ('pending_dispatch', 'accepted', 'passed', 'finding', 'blocked', 'error')`)
      .execute();

    await db.schema
      .createTable("runner_execution_jobs")
      .addColumn("runner_job_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("attempt_id", "text", (column) => column.notNull().unique().references("mission_job_attempts.attempt_id"))
      .addColumn("runner_id", "text", (column) => column.notNull())
      .addColumn("accepted_job_json", "text", (column) => column.notNull())
      .addColumn("accepted_job_hash", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("mission_execution_provenance")
      .addColumn("attempt_id", "text", (column) => column.primaryKey().notNull().references("mission_job_attempts.attempt_id"))
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("mission_id", "text", (column) => column.notNull())
      .addColumn("mission_revision", "integer", (column) => column.notNull())
      .addColumn("mission_compiled_hash", "text", (column) => column.notNull())
      .addColumn("mission_snapshot_json", "text", (column) => column.notNull())
      .addColumn("logical_job_id", "text", (column) => column.notNull())
      .addColumn("test_case_snapshot_json", "text", (column) => column.notNull())
      .addColumn("test_case_snapshot_hash", "text", (column) => column.notNull())
      .addColumn("plan_id", "text", (column) => column.notNull())
      .addColumn("plan_version", "integer", (column) => column.notNull())
      .addColumn("plan_snapshot_hash", "text", (column) => column.notNull())
      .addColumn("plan_snapshot_json", "text", (column) => column.notNull())
      .addColumn("target_id", "text", (column) => column.notNull())
      .addColumn("target_version", "integer", (column) => column.notNull())
      .addColumn("target_snapshot_hash", "text", (column) => column.notNull())
      .addColumn("target_snapshot_json", "text", (column) => column.notNull())
      .addColumn("runner_id", "text", (column) => column.notNull())
      .addColumn("policy_json", "text", (column) => column.notNull())
      .addColumn("policy_hash", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("mission_dispatch_outbox")
      .addColumn("attempt_id", "text", (column) => column.primaryKey().notNull().references("mission_job_attempts.attempt_id"))
      .addColumn("mission_id", "text", (column) => column.notNull())
      .addColumn("runner_id", "text", (column) => column.notNull())
      .addColumn("runner_job_id", "text", (column) => column.notNull().unique())
      .addColumn("run_id", "text", (column) => column.notNull().unique())
      .addColumn("idempotency_key", "text", (column) => column.notNull())
      .addColumn("required_capabilities_json", "text", (column) => column.notNull())
      .addColumn("accepted_job_json", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("accepted_at", "text")
      .addColumn("acceptance_receipt_json", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint("mission_dispatch_outbox_status_check", sql`status IN ('pending', 'accepted', 'blocked')`)
      .addCheckConstraint("mission_dispatch_outbox_version_check", sql`version > 0`)
      .addCheckConstraint("mission_dispatch_outbox_acceptance_check", sql`(status = 'accepted' AND accepted_at IS NOT NULL AND acceptance_receipt_json IS NOT NULL) OR (status <> 'accepted' AND accepted_at IS NULL AND acceptance_receipt_json IS NULL)`)
      .execute();
    await db.schema.createIndex("mission_dispatch_outbox_pending").on("mission_dispatch_outbox").columns(["status", "created_at", "attempt_id"]).execute();

    await db.schema
      .createTable("mission_dispatch_wakeups")
      .addColumn("wakeup_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("generation", "integer", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint("mission_dispatch_wakeups_generation_check", sql`generation > 0`)
      .execute();
  },
};
