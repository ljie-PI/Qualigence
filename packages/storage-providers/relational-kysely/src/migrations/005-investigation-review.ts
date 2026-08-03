import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../schema.js";
import type { Migration } from "../migrations.js";

/**
 * Migration 005 (LS-10): durable storage for the Investigation / Human Review /
 * Intelligence-Job domain, plus the schema-only Evidence Capsule metadata tables
 * reserved for LS-10's Evidence Capsule crypto layer (implemented separately —
 * this migration only defines the tables so that layer never needs its own
 * migration). Strictly additive relative to migrations 001–004: it never alters
 * an existing table.
 *
 * Investigation cases carry an optimistic-concurrency `version`; Reproduction
 * Attempts, Bug Episodes and Human Handoffs are append-only. Review Tasks also
 * carry a `version`; claims/resolutions are applied by atomic conditional writes
 * and recorded by idempotency key. Intelligence Jobs and Results are immutable,
 * and applied results are recorded once by idempotency key so a replayed Result
 * is never double-applied.
 *
 * The Evidence Capsule metadata tables keep remote encrypted manifests and
 * local-only records in SEPARATE tables: a local-only record never carries a
 * manifest, ciphertext or wrapped key, and can never appear in a remote upload
 * query.
 */
export const migration005: Migration = {
  version: 5,
  name: "investigation-review-evidence",
  async up(db: Kysely<Database>) {
    // ---- Investigation aggregate ---------------------------------------
    await db.schema
      .createTable("investigation_cases")
      .addColumn("case_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("finding_id", "text", (column) => column.notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("plan_revision", "integer", (column) => column.notNull())
      .addColumn("budget_json", "text", (column) => column.notNull())
      .addColumn("usage_json", "text", (column) => column.notNull())
      .addColumn("bug_episode_id", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "investigation_cases_status_check",
        sql`status IN ('candidate', 'investigating', 'reproducing', 'confirmed', 'refuted', 'flaky', 'needs_human', 'resolved', 'regression_verified')`,
      )
      .execute();

    await db.schema
      .createTable("investigation_attempts")
      .addColumn("attempt_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("case_id", "text", (column) =>
        column.notNull().references("investigation_cases.case_id"),
      )
      .addColumn("ordinal", "integer", (column) => column.notNull())
      .addColumn("plan_revision", "integer", (column) => column.notNull())
      .addColumn("outcome", "text", (column) => column.notNull())
      .addColumn("attempt_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "investigation_attempts_outcome_check",
        sql`outcome IN ('reproduced', 'not_reproduced', 'diverged', 'environment_failed', 'blocked')`,
      )
      .addUniqueConstraint("investigation_attempts_ordinal_unique", [
        "case_id",
        "ordinal",
      ])
      .execute();

    await db.schema
      .createTable("investigation_bug_episodes")
      .addColumn("episode_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("case_id", "text", (column) =>
        column.notNull().references("investigation_cases.case_id"),
      )
      .addColumn("finding_id", "text", (column) => column.notNull())
      .addColumn("confidence", "real", (column) => column.notNull())
      .addColumn("episode_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("investigation_handoffs")
      .addColumn("case_id", "text", (column) =>
        column.primaryKey().notNull().references("investigation_cases.case_id"),
      )
      .addColumn("handoff_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    // ---- Human Review queue --------------------------------------------
    await db.schema
      .createTable("review_tasks")
      .addColumn("task_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("case_id", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("reason", "text", (column) => column.notNull())
      .addColumn("priority", "text", (column) => column.notNull())
      .addColumn("evidence_completeness", "text", (column) => column.notNull())
      .addColumn("assignee_id", "text")
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "review_tasks_status_check",
        sql`status IN ('open', 'claimed', 'resolved')`,
      )
      .addCheckConstraint(
        "review_tasks_priority_check",
        sql`priority IN ('low', 'medium', 'high', 'urgent')`,
      )
      .addCheckConstraint(
        "review_tasks_evidence_completeness_check",
        sql`evidence_completeness IN ('complete', 'limited', 'unavailable')`,
      )
      .execute();

    await db.schema
      .createTable("review_claims")
      .addColumn("idempotency_key", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("task_id", "text", (column) =>
        column.notNull().references("review_tasks.task_id"),
      )
      .addColumn("reviewer_id", "text", (column) => column.notNull())
      .addColumn("claimed_version", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("review_resolutions")
      .addColumn("idempotency_key", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("task_id", "text", (column) =>
        column.notNull().references("review_tasks.task_id"),
      )
      .addColumn("case_id", "text", (column) => column.notNull())
      .addColumn("reviewer_id", "text", (column) => column.notNull())
      .addColumn("disposition", "text", (column) => column.notNull())
      .addColumn("evidence_refs_json", "text", (column) => column.notNull())
      .addColumn("resolved_version", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    // ---- Intelligence Jobs / Results -----------------------------------
    await db.schema
      .createTable("intelligence_jobs")
      .addColumn("job_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("job_type", "text", (column) => column.notNull())
      .addColumn("schema_version", "text", (column) => column.notNull())
      .addColumn("tenant_id", "text", (column) => column.notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("aggregate_type", "text", (column) => column.notNull())
      .addColumn("aggregate_id", "text", (column) => column.notNull())
      .addColumn("base_aggregate_version", "integer", (column) =>
        column.notNull(),
      )
      .addColumn("model_profile_id", "text", (column) => column.notNull())
      .addColumn("data_policy_id", "text", (column) => column.notNull())
      .addColumn("priority", "text", (column) => column.notNull())
      .addColumn("idempotency_key", "text", (column) =>
        column.notNull().unique(),
      )
      .addColumn("causation_id", "text", (column) => column.notNull())
      .addColumn("expected_result_schema", "text", (column) => column.notNull())
      .addColumn("job_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("intelligence_results")
      .addColumn("idempotency_key", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("job_id", "text", (column) =>
        column.notNull().references("intelligence_jobs.job_id"),
      )
      .addColumn("terminal_status", "text", (column) => column.notNull())
      .addColumn("confidence", "real", (column) => column.notNull())
      .addColumn("result_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("intelligence_applied_results")
      .addColumn("idempotency_key", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("aggregate_type", "text", (column) => column.notNull())
      .addColumn("aggregate_id", "text", (column) => column.notNull())
      .addColumn("new_version", "integer", (column) => column.notNull())
      .addColumn("summary", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    // ---- Evidence Capsule metadata (schema-only, reserved) -------------
    await db.schema
      .createTable("evidence_encryption_profiles")
      .addColumn("profile_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("tenant_id", "text", (column) => column.notNull())
      .addColumn("case_id", "text", (column) => column.notNull())
      .addColumn("recipient", "text", (column) => column.notNull())
      .addColumn("region", "text", (column) => column.notNull())
      .addColumn("purpose", "text", (column) => column.notNull())
      .addColumn("policy_id", "text", (column) => column.notNull())
      .addColumn("wrapping_key_id", "text", (column) => column.notNull())
      .addColumn("wrapping_public_key_pem", "text", (column) =>
        column.notNull(),
      )
      .addColumn("content_encryption_algorithm", "text", (column) =>
        column.notNull(),
      )
      .addColumn("key_wrapping_algorithm", "text", (column) => column.notNull())
      .addColumn("aad_schema_version", "text", (column) => column.notNull())
      .addColumn("allowed_entry_kinds_json", "text", (column) =>
        column.notNull(),
      )
      .addColumn("maximum_entry_bytes", "integer", (column) => column.notNull())
      .addColumn("maximum_plaintext_bytes", "integer", (column) =>
        column.notNull(),
      )
      .addColumn("maximum_ciphertext_bytes", "integer", (column) =>
        column.notNull(),
      )
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("evidence_capsule_manifests")
      .addColumn("capsule_id", "text", (column) => column.notNull())
      .addColumn("revision", "integer", (column) => column.notNull())
      .addColumn("parent_revision", "integer")
      .addColumn("profile_id", "text", (column) =>
        column.notNull().references("evidence_encryption_profiles.profile_id"),
      )
      .addColumn("payload_schema_version", "text", (column) => column.notNull())
      .addColumn("aad_schema_version", "text", (column) => column.notNull())
      .addColumn("tenant_id", "text", (column) => column.notNull())
      .addColumn("case_id", "text", (column) => column.notNull())
      .addColumn("recipient", "text", (column) => column.notNull())
      .addColumn("region", "text", (column) => column.notNull())
      .addColumn("purpose", "text", (column) => column.notNull())
      .addColumn("policy_id", "text", (column) => column.notNull())
      .addColumn("content_encryption_algorithm", "text", (column) =>
        column.notNull(),
      )
      .addColumn("key_wrapping_algorithm", "text", (column) => column.notNull())
      .addColumn("wrapping_key_id", "text", (column) => column.notNull())
      .addColumn("plaintext_sha256", "text", (column) => column.notNull())
      .addColumn("plaintext_bytes", "integer", (column) => column.notNull())
      .addColumn("ciphertext_sha256", "text", (column) => column.notNull())
      .addColumn("ciphertext_bytes", "integer", (column) => column.notNull())
      .addColumn("ciphertext", "blob")
      .addColumn("wrapped_dek_base64", "text", (column) => column.notNull())
      .addColumn("nonce_base64", "text", (column) => column.notNull())
      .addColumn("auth_tag_base64", "text", (column) => column.notNull())
      .addColumn("protected_header_json", "text", (column) => column.notNull())
      .addColumn("revocation_state", "text", (column) => column.notNull())
      .addColumn("revoked_at", "text")
      .addColumn("revoked_reason", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("evidence_capsule_manifests_pk", [
        "capsule_id",
        "revision",
      ])
      .addCheckConstraint(
        "evidence_capsule_manifests_revocation_state_check",
        sql`revocation_state IN ('active', 'revoked')`,
      )
      .execute();

    await db.schema
      .createTable("evidence_capsule_entries")
      .addColumn("entry_id", "text", (column) => column.notNull())
      .addColumn("capsule_id", "text", (column) => column.notNull())
      .addColumn("revision", "integer", (column) => column.notNull())
      .addColumn("kind", "text", (column) => column.notNull())
      .addColumn("media_type", "text", (column) => column.notNull())
      .addColumn("plaintext_sha256", "text", (column) => column.notNull())
      .addColumn("plaintext_bytes", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("evidence_capsule_entries_pk", [
        "capsule_id",
        "revision",
        "entry_id",
      ])
      .addCheckConstraint(
        "evidence_capsule_entries_kind_check",
        sql`kind IN ('trace', 'semantic_graph', 'screenshot', 'log_summary')`,
      )
      .execute();

    await db.schema
      .createTable("evidence_key_rotations")
      .addColumn("rotation_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("capsule_id", "text", (column) => column.notNull())
      .addColumn("parent_revision", "integer", (column) => column.notNull())
      .addColumn("new_revision", "integer", (column) => column.notNull())
      .addColumn("actor_id", "text", (column) => column.notNull())
      .addColumn("reason", "text", (column) => column.notNull())
      .addColumn("old_key_id", "text", (column) => column.notNull())
      .addColumn("new_key_id", "text", (column) => column.notNull())
      .addColumn("occurred_at", "text", (column) => column.notNull())
      .execute();

    // Local-only records live in their OWN table and never carry a manifest,
    // ciphertext or wrapped key — they can never enter a remote upload query.
    await db.schema
      .createTable("evidence_local_only_records")
      .addColumn("local_record_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("tenant_id", "text", (column) => column.notNull())
      .addColumn("case_id", "text", (column) => column.notNull())
      .addColumn("run_id", "text", (column) => column.notNull())
      .addColumn("disposition", "text", (column) => column.notNull())
      .addColumn("reason", "text", (column) => column.notNull())
      .addColumn("local_content_refs_json", "text", (column) =>
        column.notNull(),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "evidence_local_only_records_disposition_check",
        sql`disposition IN ('local_only')`,
      )
      .execute();

    await db.schema
      .createTable("evidence_audit_events")
      .addColumn("audit_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("actor_type", "text", (column) => column.notNull())
      .addColumn("actor_id", "text", (column) => column.notNull())
      .addColumn("tenant_id", "text", (column) => column.notNull())
      .addColumn("case_id", "text", (column) => column.notNull())
      .addColumn("capsule_id", "text", (column) => column.notNull())
      .addColumn("key_version", "text", (column) => column.notNull())
      .addColumn("purpose", "text", (column) => column.notNull())
      .addColumn("operation", "text", (column) => column.notNull())
      .addColumn("decision", "text", (column) => column.notNull())
      .addColumn("reason_code", "text", (column) => column.notNull())
      .addColumn("correlation_id", "text", (column) => column.notNull())
      .addColumn("occurred_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "evidence_audit_events_actor_type_check",
        sql`actor_type IN ('user', 'service')`,
      )
      .addCheckConstraint(
        "evidence_audit_events_operation_check",
        sql`operation IN ('profile', 'wrap', 'unwrap', 'rewrap', 'revoke', 'delete')`,
      )
      .addCheckConstraint(
        "evidence_audit_events_decision_check",
        sql`decision IN ('allowed', 'denied', 'failed')`,
      )
      .execute();
  },
};
