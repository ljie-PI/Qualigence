import type { Kysely, SqlBool } from "kysely";
import { sql } from "kysely";
import type { Database } from "../schema.js";
import type { Migration } from "../migrations.js";

export const migration007: Migration = {
  version: 7,
  name: "local-run-intake",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("local_run_intakes")
      .addColumn("run_id", "text", (column) => column.primaryKey().notNull().references("execution_runs.run_id"))
      .addColumn("job_id", "text", (column) => column.notNull().unique())
      .addColumn("job_json", "text", (column) => column.notNull())
      .addColumn("job_sha256", "text", (column) => column.notNull())
      .addColumn("dispatch_state", "text", (column) => column.notNull())
      .addColumn("dispatch_attempt", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("dispatch_last_attempt_at", "text")
      .addColumn("dispatch_error_code", "text")
      .addColumn("completion_state", "text", (column) => column.notNull().defaultTo("awaiting"))
      .addColumn("completion_attempt", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("completion_last_attempt_at", "text")
      .addColumn("completion_next_attempt_at", "text", (column) => column.notNull())
      .addColumn("completion_error_code", "text")
      .addColumn("completion_sha256", "text")
      .addColumn("completion_applied_at", "text")
      .addColumn("completion_blocked_at", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint("local_run_intakes_job_sha256_check", sql`length(job_sha256) = 64 AND lower(job_sha256) = job_sha256 AND job_sha256 NOT GLOB '*[^0-9a-f]*'`)
      .addCheckConstraint("local_run_intakes_completion_sha256_check", sql`completion_sha256 IS NULL OR (length(completion_sha256) = 64 AND lower(completion_sha256) = completion_sha256 AND completion_sha256 NOT GLOB '*[^0-9a-f]*')`)
      .addCheckConstraint("local_run_intakes_dispatch_state_check", sql`dispatch_state IN ('pending_runner', 'dispatching', 'offer_outcome_unknown', 'offered')`)
      .addCheckConstraint("local_run_intakes_completion_state_check", sql`completion_state IN ('awaiting', 'applied', 'integrity_blocked', 'retry_exhausted')`)
      .addCheckConstraint("local_run_intakes_attempt_check", sql`typeof(dispatch_attempt) = 'integer' AND dispatch_attempt >= 0 AND typeof(completion_attempt) = 'integer' AND completion_attempt >= 0`)
      .execute();
    await db.schema.createIndex("local_run_intakes_pending_dispatch").on("local_run_intakes").columns(["updated_at", "run_id"]).where(sql<SqlBool>`dispatch_state = 'pending_runner'`).execute();
    await db.schema.createIndex("local_run_intakes_pending_completion").on("local_run_intakes").columns(["completion_next_attempt_at", "updated_at", "run_id"]).where(sql<SqlBool>`completion_state = 'awaiting' AND dispatch_state IN ('offered', 'offer_outcome_unknown')`).execute();
  },
};
