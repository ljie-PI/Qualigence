import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../schema.js";
import type { Migration } from "../migrations.js";

export const migration008: Migration = {
  version: 8,
  name: "target-test-plan-revisions",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("project_targets")
      .addColumn("target_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("current_version", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("target_revisions")
      .addColumn("target_id", "text", (column) => column.notNull().references("project_targets.target_id"))
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("display_name", "text", (column) => column.notNull())
      .addColumn("runner_id", "text", (column) => column.notNull())
      .addColumn("kind", "text", (column) => column.notNull())
      .addColumn("snapshot_hash", "text", (column) => column.notNull())
      .addColumn("configuration_json", "text", (column) => column.notNull())
      .addColumn("idempotency_key", "text", (column) => column.notNull().unique())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("target_revisions_pk", ["target_id", "version"])
      .addCheckConstraint("target_revisions_kind_check", sql`kind IN ('web', 'desktop')`)
      .execute();

    await db.schema
      .createTable("test_plan_heads")
      .addColumn("plan_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("current_version", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("test_plan_version_revisions")
      .addColumn("plan_id", "text", (column) => column.notNull().references("test_plan_heads.plan_id"))
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("prd_id", "text", (column) => column.notNull())
      .addColumn("prd_revision", "integer", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("reviewer_id", "text")
      .addColumn("approved_at", "text")
      .addColumn("idempotency_key", "text", (column) => column.notNull().unique())
      .addColumn("plan_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("test_plan_version_revisions_pk", ["plan_id", "version"])
      .addCheckConstraint("test_plan_version_revisions_status_check", sql`status IN ('draft', 'approved')`)
      .execute();
  },
};
