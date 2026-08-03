import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../schema.js";
import type { Migration } from "../migrations.js";

/**
 * Migration 002 (LS-07): the PRD → Mission bridge. Strictly additive relative to
 * migration 001 — it never alters an existing table. It introduces the eight
 * logical tables that persist immutable PRD revisions, versioned test plans,
 * source-grounded claims/test cases, compiled missions and their execution
 * attempts. Every claim/test case/job retains a JSON provenance snapshot linking
 * back to the originating PRD source ranges and hashes.
 */
export const migration002: Migration = {
  version: 2,
  name: "prd-mission-bridge",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("prd_documents")
      .addColumn("prd_id", "text", (column) => column.notNull())
      .addColumn("revision", "integer", (column) => column.notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("title", "text", (column) => column.notNull())
      .addColumn("content", "text", (column) => column.notNull())
      .addColumn("content_sha256", "text", (column) => column.notNull())
      .addColumn("ingested_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("prd_documents_pk", ["prd_id", "revision"])
      .execute();

    await db.schema
      .createTable("test_plan_revisions")
      .addColumn("plan_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("prd_id", "text", (column) => column.notNull())
      .addColumn("prd_revision", "integer", (column) => column.notNull())
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("reviewer_id", "text")
      .addColumn("approved_at", "text")
      .addColumn("idempotency_key", "text")
      .addColumn("plan_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "test_plan_revisions_status_check",
        sql`status IN ('draft', 'approved')`,
      )
      .execute();

    await db.schema
      .createTable("expected_claims")
      .addColumn("claim_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("plan_id", "text", (column) =>
        column.notNull().references("test_plan_revisions.plan_id"),
      )
      .addColumn("semantic_key", "text", (column) => column.notNull())
      .addColumn("statement", "text", (column) => column.notNull())
      .addColumn("confidence", "real", (column) => column.notNull())
      .addColumn("source_refs_json", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("test_cases")
      .addColumn("test_case_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("plan_id", "text", (column) =>
        column.notNull().references("test_plan_revisions.plan_id"),
      )
      .addColumn("title", "text", (column) => column.notNull())
      .addColumn("objective", "text", (column) => column.notNull())
      .addColumn("priority", "text", (column) => column.notNull())
      .addColumn("source_refs_json", "text", (column) => column.notNull())
      .addColumn("snapshot_json", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("missions")
      .addColumn("mission_id", "text", (column) => column.notNull())
      .addColumn("revision", "integer", (column) => column.notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("plan_id", "text", (column) => column.notNull())
      .addColumn("prd_id", "text", (column) => column.notNull())
      .addColumn("prd_revision", "integer", (column) => column.notNull())
      .addColumn("target_id", "text", (column) => column.notNull())
      .addColumn("compiled_hash", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("dispatch_json", "text", (column) => column.notNull())
      .addColumn("stop_on_blocked", "integer", (column) => column.notNull())
      .addPrimaryKeyConstraint("missions_pk", ["mission_id", "revision"])
      .addCheckConstraint(
        "missions_status_check",
        sql`status IN ('draft', 'approved', 'running', 'completed', 'blocked')`,
      )
      .execute();

    await db.schema
      .createTable("mission_revisions")
      .addColumn("mission_id", "text", (column) => column.notNull())
      .addColumn("revision", "integer", (column) => column.notNull())
      .addColumn("compiled_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("mission_revisions_pk", [
        "mission_id",
        "revision",
      ])
      .execute();

    await db.schema
      .createTable("execution_jobs")
      .addColumn("job_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("mission_id", "text", (column) => column.notNull())
      .addColumn("mission_revision", "integer", (column) => column.notNull())
      .addColumn("test_case_id", "text", (column) => column.notNull())
      .addColumn("objective", "text", (column) => column.notNull())
      .addColumn("required_capabilities_json", "text", (column) =>
        column.notNull(),
      )
      .addColumn("source_refs_json", "text", (column) => column.notNull())
      .addColumn("snapshot_hash", "text", (column) => column.notNull())
      .addColumn("snapshot_json", "text", (column) => column.notNull())
      .addColumn("idempotency_key", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addCheckConstraint(
        "execution_jobs_status_check",
        sql`status IN ('queued', 'leased', 'completed', 'blocked', 'failed')`,
      )
      .execute();

    await db.schema
      .createTable("execution_job_attempts")
      .addColumn("attempt_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("job_id", "text", (column) =>
        column.notNull().references("execution_jobs.job_id"),
      )
      .addColumn("mission_id", "text", (column) => column.notNull())
      .addColumn("run_id", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("error_code", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "execution_job_attempts_status_check",
        sql`status IN ('passed', 'finding', 'blocked', 'error')`,
      )
      .execute();
  },
};
