import type { Kysely, SqlBool } from "kysely";
import { sql } from "kysely";
import type { Database } from "../schema.js";
import type { Migration } from "../migrations.js";

/**
 * Migration 006: durable Runner control state. Strictly additive relative to
 * migrations 001–005: it never alters an existing table. Only token hashes are
 * stored; raw lease and resume tokens never appear in a column.
 */
export const migration006: Migration = {
  version: 6,
  name: "runner-control",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("runner_sessions")
      .ifNotExists()
      .addColumn("session_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("runner_id", "text", (column) => column.notNull())
      .addColumn("certificate_fingerprint", "text", (column) => column.notNull())
      .addColumn("capabilities_json", "text", (column) => column.notNull())
      .addColumn("protocol_major", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("closed_at", "text")
      .execute();

    await db.schema
      .createIndex("runner_sessions_active_runner_id")
      .ifNotExists()
      .on("runner_sessions")
      .column("runner_id")
      .where(sql<SqlBool>`closed_at IS NULL`)
      .execute();

    await db.schema
      .createTable("runner_resume_tokens")
      .ifNotExists()
      .addColumn("token_hash", "text", (column) => column.primaryKey().notNull())
      .addColumn("runner_id", "text", (column) => column.notNull())
      .addColumn("certificate_fingerprint", "text", (column) => column.notNull())
      .addColumn("previous_session_id", "text", (column) => column.notNull())
      .addColumn("protocol_major", "integer", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("consumed_at", "text")
      .execute();

    await db.schema
      .createIndex("runner_resume_tokens_unconsumed_expiry")
      .ifNotExists()
      .on("runner_resume_tokens")
      .column("expires_at")
      .where(sql<SqlBool>`consumed_at IS NULL`)
      .execute();

    await db.schema
      .createTable("execution_leases")
      .ifNotExists()
      .addColumn("run_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("job_id", "text", (column) => column.notNull())
      .addColumn("runner_id", "text", (column) => column.notNull())
      .addColumn("session_id", "text", (column) => column.notNull())
      .addColumn("lease_epoch", "integer", (column) => column.notNull())
      .addColumn("job_json", "text", (column) => column.notNull())
      .addColumn("lease_token_hash", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("lost_at", "text")
      .addColumn("completed_at", "text")
      .addColumn("recovery_of_run_id", "text")
      .execute();

    await db.schema
      .createTable("execution_completions")
      .ifNotExists()
      .addColumn("run_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("job_id", "text", (column) => column.notNull())
      .addColumn("completion_json", "text", (column) => column.notNull())
      .addColumn("completed_at", "text", (column) => column.notNull())
      .execute();
  },
};
