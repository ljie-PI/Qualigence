import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Migration } from "../migrations.js";
import type { Database } from "../schema.js";

/**
 * Migration 010: durable Skill lifecycle command idempotency and audit evidence.
 * Skill aggregate state remains owned by `skills`/`skill_versions`; command and
 * audit rows record successful promote/deprecate effects without `last_*` fields.
 */
export const migration010: Migration = {
  version: 10,
  name: "skill-lifecycle-commands",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("skill_lifecycle_commands")
      .addColumn("idempotency_key", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("command_hash", "text", (column) => column.notNull())
      .addColumn("command_type", "text", (column) => column.notNull())
      .addColumn("skill_id", "text", (column) =>
        column.notNull().references("skills.skill_id"),
      )
      .addColumn("expected_version", "integer", (column) => column.notNull())
      .addColumn("result_version", "integer", (column) => column.notNull())
      .addColumn("result_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "skill_lifecycle_commands_type_check",
        sql`command_type IN ('promote', 'deprecate')`,
      )
      .execute();

    await db.schema
      .createTable("skill_lifecycle_audit_events")
      .addColumn("audit_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("skill_id", "text", (column) => column.notNull())
      .addColumn("skill_version", "integer", (column) => column.notNull())
      .addColumn("operation", "text", (column) => column.notNull())
      .addColumn("decision", "text", (column) => column.notNull())
      .addColumn("actor_id", "text", (column) => column.notNull())
      .addColumn("actor_tenant_id", "text", (column) => column.notNull())
      .addColumn("actor_roles_json", "text", (column) => column.notNull())
      .addColumn("reason", "text", (column) => column.notNull())
      .addColumn("metadata_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addForeignKeyConstraint(
        "skill_lifecycle_audit_events_skill_version_fk",
        ["skill_id", "skill_version"],
        "skill_versions",
        ["skill_id", "version"],
      )
      .addCheckConstraint(
        "skill_lifecycle_audit_events_operation_check",
        sql`operation IN ('promote', 'deprecate')`,
      )
      .addCheckConstraint(
        "skill_lifecycle_audit_events_decision_check",
        sql`decision IN ('allowed', 'rejected')`,
      )
      .execute();
  },
};
