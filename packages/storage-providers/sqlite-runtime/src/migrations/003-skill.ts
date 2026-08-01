import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../schema.js";
import type { Migration } from "../migrations.js";

/**
 * Migration 003 (LS-08): Recording capture and the Skill lifecycle. Strictly
 * additive relative to migrations 001 and 002 — it never alters an existing
 * table. It introduces the seven logical tables that persist immutable
 * Recordings and their steps, the Skill aggregate head, immutable versioned
 * Skill snapshots, replay evaluations, signed Bundles (public signature bytes
 * only — never a private key) and append-only revocations.
 */
export const migration003: Migration = {
  version: 3,
  name: "recording-skill-lifecycle",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("recordings")
      .addColumn("recording_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("target_id", "text", (column) => column.notNull())
      .addColumn("target_version", "text", (column) => column.notNull())
      .addColumn("observation_schema_epoch", "text", (column) =>
        column.notNull(),
      )
      .addColumn("started_at", "text", (column) => column.notNull())
      .addColumn("completed_at", "text", (column) => column.notNull())
      .addColumn("source_trace_refs_json", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("recording_steps")
      .addColumn("recording_id", "text", (column) =>
        column.notNull().references("recordings.recording_id"),
      )
      .addColumn("ordinal", "integer", (column) => column.notNull())
      .addColumn("step_json", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("recording_steps_pk", [
        "recording_id",
        "ordinal",
      ])
      .execute();

    await db.schema
      .createTable("skills")
      .addColumn("skill_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("target_id", "text", (column) => column.notNull())
      .addColumn("current_version", "integer", (column) => column.notNull())
      .addColumn("current_state", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("skill_versions")
      .addColumn("skill_id", "text", (column) =>
        column.notNull().references("skills.skill_id"),
      )
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("state", "text", (column) => column.notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("source_recording_id", "text", (column) => column.notNull())
      .addColumn("content_sha256", "text", (column) => column.notNull())
      .addColumn("content_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("skill_versions_pk", ["skill_id", "version"])
      .addCheckConstraint(
        "skill_versions_state_check",
        sql`state IN ('draft', 'candidate', 'verified', 'promoted', 'deprecated')`,
      )
      .execute();

    await db.schema
      .createTable("skill_evaluations")
      .addColumn("evaluation_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("skill_id", "text", (column) => column.notNull())
      .addColumn("skill_version", "integer", (column) => column.notNull())
      .addColumn("outcome", "text", (column) => column.notNull())
      .addColumn("signature_valid", "integer", (column) => column.notNull())
      .addColumn("oracles_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "skill_evaluations_outcome_check",
        sql`outcome IN ('passed', 'failed')`,
      )
      .execute();

    await db.schema
      .createTable("skill_bundles")
      .addColumn("skill_id", "text", (column) => column.notNull())
      .addColumn("skill_version", "integer", (column) => column.notNull())
      .addColumn("bundle_id", "text", (column) => column.notNull().unique())
      .addColumn("signer_key_id", "text", (column) => column.notNull())
      .addColumn("signature_algorithm", "text", (column) => column.notNull())
      .addColumn("content_sha256", "text", (column) => column.notNull())
      .addColumn("manifest_json", "text", (column) => column.notNull())
      .addColumn("payload_json", "text", (column) => column.notNull())
      .addColumn("issued_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("skill_bundles_pk", ["skill_id", "skill_version"])
      .execute();

    await db.schema
      .createTable("skill_revocations")
      .addColumn("revocation_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("skill_id", "text", (column) => column.notNull())
      .addColumn("skill_version", "integer", (column) => column.notNull())
      .addColumn("reason", "text", (column) => column.notNull())
      .addColumn("revoked_at", "text", (column) => column.notNull())
      .execute();
  },
};
