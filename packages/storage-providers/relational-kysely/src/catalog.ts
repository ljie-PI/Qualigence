/**
 * Shared relational table catalog.
 *
 * This catalog is the single source of truth for the *tenant metadata* of the
 * logical relational schema shared by the SQLite and PostgreSQL runtimes: which
 * tables are tenant-owned, their columns, primary keys, intra-tenant foreign
 * keys and check constraints.
 *
 * The SQLite runtime does NOT generate its DDL from this catalog — it keeps the
 * original, byte-for-byte migration builders (see `./migrations`) so its
 * observable behaviour is provably unchanged. The catalog is consumed by the
 * PostgreSQL runtime to emit the tenant-scoped schema: every tenant-owned table
 * receives a `tenant_id` column that participates in a composite primary key,
 * intra-tenant references become tenant-inclusive composite foreign keys, and
 * forced Row-Level Security policies isolate tenants at the database level.
 *
 * A conformance test asserts the SQLite migrations and this catalog agree on the
 * logical table inventory and schema version, guarding against drift.
 */

export type LogicalColumnType = "text" | "integer" | "real" | "blob";

export interface ColumnSpec {
  readonly name: string;
  readonly type: LogicalColumnType;
  readonly notNull: boolean;
}

export interface ForeignKeySpec {
  readonly columns: readonly string[];
  readonly references: {
    readonly table: string;
    readonly columns: readonly string[];
  };
}

export interface UniqueSpec {
  readonly name: string;
  readonly columns: readonly string[];
}

export interface CheckSpec {
  readonly name: string;
  /** Raw, dialect-neutral SQL predicate over the table's columns. */
  readonly predicate: string;
}

export interface PartialIndexSpec {
  readonly name: string;
  readonly columns: readonly string[];
  /** Raw, dialect-neutral SQL predicate; rows excluded from the index. */
  readonly predicate: string;
  readonly unique?: boolean;
}

export interface RelationalTableSpec {
  readonly name: string;
  /** Whether rows belong to a single tenant and must be RLS-isolated. */
  readonly tenantOwned: boolean;
  /** True when the base schema already defines a `tenant_id` column. */
  readonly hasNativeTenantColumn: boolean;
  /** True when the dedicated Worker role may read/append this table. */
  readonly workerAccessible: boolean;
  readonly columns: readonly ColumnSpec[];
  readonly primaryKey: readonly string[];
  readonly uniques: readonly UniqueSpec[];
  readonly foreignKeys: readonly ForeignKeySpec[];
  readonly checks: readonly CheckSpec[];
  /** Partial indexes emitted by the PostgreSQL schema generator. */
  readonly partialIndexes?: readonly PartialIndexSpec[];
}

export interface RelationalSchemaVersion {
  readonly version: number;
  readonly name: string;
  readonly tables: readonly string[];
}

const t = (name: string, notNull = true): ColumnSpec => ({
  name,
  type: "text",
  notNull,
});
const i = (name: string, notNull = true): ColumnSpec => ({
  name,
  type: "integer",
  notNull,
});
const r = (name: string, notNull = true): ColumnSpec => ({
  name,
  type: "real",
  notNull,
});
const b = (name: string, notNull = false): ColumnSpec => ({
  name,
  type: "blob",
  notNull,
});

export const RELATIONAL_TABLES: readonly RelationalTableSpec[] = [
  // ---- Migration 001: execution runtime ------------------------------
  {
    name: "schema_migrations",
    tenantOwned: false,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [i("version"), t("name"), t("applied_at")],
    primaryKey: ["version"],
    uniques: [{ name: "schema_migrations_name_unique", columns: ["name"] }],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "execution_runs",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("run_id"),
      t("job_id"),
      t("target_kind"),
      t("objective"),
      t("status"),
      i("next_sequence_number"),
      t("created_at"),
      t("completed_at", false),
      t("error_code", false),
    ],
    primaryKey: ["run_id"],
    uniques: [],
    foreignKeys: [],
    checks: [
      {
        name: "execution_runs_status_check",
        predicate:
          "status IN ('running', 'passed', 'finding', 'blocked', 'error')",
      },
      {
        name: "execution_runs_target_kind_check",
        predicate: "target_kind IN ('web', 'app')",
      },
    ],
  },
  {
    name: "trace_events",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("run_id"),
      i("sequence_number"),
      t("message_id"),
      t("idempotency_key"),
      t("stage"),
      t("occurred_at"),
      t("payload_hash"),
      t("envelope_json"),
    ],
    primaryKey: ["run_id", "sequence_number"],
    uniques: [
      { name: "trace_events_message_id_unique", columns: ["message_id"] },
      {
        name: "trace_events_idempotency_key_unique",
        columns: ["idempotency_key"],
      },
    ],
    foreignKeys: [
      { columns: ["run_id"], references: { table: "execution_runs", columns: ["run_id"] } },
    ],
    checks: [],
  },
  {
    name: "findings",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("finding_id"),
      t("run_id"),
      t("payload_hash"),
      t("envelope_json"),
      t("created_at"),
    ],
    primaryKey: ["finding_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["run_id"], references: { table: "execution_runs", columns: ["run_id"] } },
    ],
    checks: [],
  },
  {
    name: "artifact_manifests",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("artifact_id"),
      t("run_id"),
      t("kind"),
      t("media_type"),
      t("relative_path"),
      t("sha256"),
      i("size_bytes"),
      t("created_at"),
    ],
    primaryKey: ["artifact_id"],
    uniques: [
      {
        name: "artifact_manifests_relative_path_unique",
        columns: ["relative_path"],
      },
    ],
    foreignKeys: [
      { columns: ["run_id"], references: { table: "execution_runs", columns: ["run_id"] } },
    ],
    checks: [],
  },
  {
    name: "model_invocations",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("invocation_id"),
      t("run_id"),
      t("operation"),
      t("model"),
      t("status"),
      i("latency_ms"),
      i("input_tokens", false),
      i("output_tokens", false),
      t("provider_request_id", false),
      t("error_code", false),
      t("occurred_at"),
    ],
    primaryKey: ["invocation_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["run_id"], references: { table: "execution_runs", columns: ["run_id"] } },
    ],
    checks: [
      {
        name: "model_invocations_status_check",
        predicate: "status IN ('succeeded', 'failed')",
      },
    ],
  },
  // ---- Migration 002: PRD -> Mission bridge ---------------------------
  {
    name: "prd_documents",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("prd_id"),
      i("revision"),
      t("project_id"),
      t("title"),
      t("content"),
      t("content_sha256"),
      t("ingested_at"),
    ],
    primaryKey: ["prd_id", "revision"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "test_plan_revisions",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("plan_id"),
      t("project_id"),
      t("prd_id"),
      i("prd_revision"),
      i("version"),
      t("status"),
      t("reviewer_id", false),
      t("approved_at", false),
      t("idempotency_key", false),
      t("plan_json"),
      t("created_at"),
    ],
    primaryKey: ["plan_id"],
    uniques: [],
    foreignKeys: [],
    checks: [
      {
        name: "test_plan_revisions_status_check",
        predicate: "status IN ('draft', 'approved')",
      },
    ],
  },
  {
    name: "expected_claims",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("claim_id"),
      t("plan_id"),
      t("semantic_key"),
      t("statement"),
      r("confidence"),
      t("source_refs_json"),
    ],
    primaryKey: ["claim_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["plan_id"], references: { table: "test_plan_revisions", columns: ["plan_id"] } },
    ],
    checks: [],
  },
  {
    name: "test_cases",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("test_case_id"),
      t("plan_id"),
      t("title"),
      t("objective"),
      t("priority"),
      t("source_refs_json"),
      t("snapshot_json"),
    ],
    primaryKey: ["test_case_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["plan_id"], references: { table: "test_plan_revisions", columns: ["plan_id"] } },
    ],
    checks: [],
  },
  {
    name: "missions",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("mission_id"),
      i("revision"),
      t("project_id"),
      t("plan_id"),
      t("prd_id"),
      i("prd_revision"),
      t("target_id"),
      t("compiled_hash"),
      t("status"),
      t("dispatch_json"),
      i("stop_on_blocked"),
    ],
    primaryKey: ["mission_id", "revision"],
    uniques: [],
    foreignKeys: [],
    checks: [
      {
        name: "missions_status_check",
        predicate:
          "status IN ('draft', 'approved', 'running', 'completed', 'blocked')",
      },
    ],
  },
  {
    name: "mission_revisions",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [t("mission_id"), i("revision"), t("compiled_json"), t("created_at")],
    primaryKey: ["mission_id", "revision"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "execution_jobs",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("job_id"),
      t("mission_id"),
      i("mission_revision"),
      t("test_case_id"),
      t("objective"),
      t("required_capabilities_json"),
      t("source_refs_json"),
      t("snapshot_hash"),
      t("snapshot_json"),
      t("idempotency_key"),
      t("status"),
    ],
    primaryKey: ["job_id"],
    uniques: [],
    foreignKeys: [],
    checks: [
      {
        name: "execution_jobs_status_check",
        predicate:
          "status IN ('queued', 'leased', 'completed', 'blocked', 'failed')",
      },
    ],
  },
  {
    name: "execution_job_attempts",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("attempt_id"),
      t("job_id"),
      t("mission_id"),
      t("run_id"),
      t("status"),
      t("error_code", false),
      t("created_at"),
    ],
    primaryKey: ["attempt_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["job_id"], references: { table: "execution_jobs", columns: ["job_id"] } },
    ],
    checks: [
      {
        name: "execution_job_attempts_status_check",
        predicate: "status IN ('passed', 'finding', 'blocked', 'error')",
      },
    ],
  },
  // ---- Migration 003: Recording + Skill lifecycle ---------------------
  {
    name: "recordings",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("recording_id"),
      t("project_id"),
      t("target_id"),
      t("target_version"),
      t("observation_schema_epoch"),
      t("started_at"),
      t("completed_at"),
      t("source_trace_refs_json"),
    ],
    primaryKey: ["recording_id"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "recording_steps",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [t("recording_id"), i("ordinal"), t("step_json")],
    primaryKey: ["recording_id", "ordinal"],
    uniques: [],
    foreignKeys: [
      { columns: ["recording_id"], references: { table: "recordings", columns: ["recording_id"] } },
    ],
    checks: [],
  },
  {
    name: "skills",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("skill_id"),
      t("project_id"),
      t("target_id"),
      i("current_version"),
      t("current_state"),
      t("created_at"),
      t("updated_at"),
    ],
    primaryKey: ["skill_id"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "skill_versions",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("skill_id"),
      i("version"),
      t("state"),
      t("project_id"),
      t("source_recording_id"),
      t("content_sha256"),
      t("content_json"),
      t("created_at"),
    ],
    primaryKey: ["skill_id", "version"],
    uniques: [],
    foreignKeys: [
      { columns: ["skill_id"], references: { table: "skills", columns: ["skill_id"] } },
    ],
    checks: [
      {
        name: "skill_versions_state_check",
        predicate:
          "state IN ('draft', 'candidate', 'verified', 'promoted', 'deprecated')",
      },
    ],
  },
  {
    name: "skill_evaluations",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("evaluation_id"),
      t("skill_id"),
      i("skill_version"),
      t("outcome"),
      i("signature_valid"),
      t("oracles_json"),
      t("created_at"),
    ],
    primaryKey: ["evaluation_id"],
    uniques: [],
    foreignKeys: [],
    checks: [
      {
        name: "skill_evaluations_outcome_check",
        predicate: "outcome IN ('passed', 'failed')",
      },
    ],
  },
  {
    name: "skill_bundles",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("skill_id"),
      i("skill_version"),
      t("bundle_id"),
      t("signer_key_id"),
      t("signature_algorithm"),
      t("content_sha256"),
      t("manifest_json"),
      t("payload_json"),
      t("issued_at"),
    ],
    primaryKey: ["skill_id", "skill_version"],
    uniques: [{ name: "skill_bundles_bundle_id_unique", columns: ["bundle_id"] }],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "skill_revocations",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("revocation_id"),
      t("skill_id"),
      i("skill_version"),
      t("reason"),
      t("revoked_at"),
    ],
    primaryKey: ["revocation_id"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  // ---- Migration 004: exploration + benchmark -------------------------
  {
    name: "benchmark_runs",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("run_id"),
      t("benchmark_version"),
      t("manifest_sha256"),
      t("profile_sha256"),
      t("ground_truth_sha256"),
      t("created_at"),
    ],
    primaryKey: ["run_id"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "benchmark_attempts",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("attempt_id"),
      t("run_id"),
      t("profile_sha256"),
      t("scenario_id"),
      t("mode"),
      i("repetition"),
      t("terminal_reason"),
      t("findings_json"),
      t("created_at"),
    ],
    primaryKey: ["attempt_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["run_id"], references: { table: "benchmark_runs", columns: ["run_id"] } },
    ],
    checks: [
      {
        name: "benchmark_attempts_mode_check",
        predicate: "mode IN ('normal', 'fault')",
      },
    ],
  },
  {
    name: "exploration_checkpoints",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("attempt_id"),
      i("step"),
      t("graph_fingerprint"),
      t("remaining_json"),
      t("terminal_reason", false),
    ],
    primaryKey: ["attempt_id", "step"],
    uniques: [],
    foreignKeys: [
      { columns: ["attempt_id"], references: { table: "benchmark_attempts", columns: ["attempt_id"] } },
    ],
    checks: [],
  },
  {
    name: "benchmark_reports",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("report_id"),
      t("run_id"),
      t("profile_status"),
      t("gate_status"),
      t("failure_codes_json"),
      t("report_json"),
      t("created_at"),
    ],
    primaryKey: ["report_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["run_id"], references: { table: "benchmark_runs", columns: ["run_id"] } },
    ],
    checks: [
      {
        name: "benchmark_reports_profile_status_check",
        predicate: "profile_status IN ('reference', 'unverified')",
      },
      {
        name: "benchmark_reports_gate_status_check",
        predicate: "gate_status IN ('passed', 'failed', 'unverified')",
      },
    ],
  },
  // ---- Migration 005: investigation / review / intelligence / evidence
  {
    name: "investigation_cases",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("case_id"),
      t("finding_id"),
      t("project_id"),
      t("status"),
      i("version"),
      i("plan_revision"),
      t("budget_json"),
      t("usage_json"),
      t("bug_episode_id", false),
      t("created_at"),
      t("updated_at"),
    ],
    primaryKey: ["case_id"],
    uniques: [],
    foreignKeys: [],
    checks: [
      {
        name: "investigation_cases_status_check",
        predicate:
          "status IN ('candidate', 'investigating', 'reproducing', 'confirmed', 'refuted', 'flaky', 'needs_human', 'resolved', 'regression_verified')",
      },
    ],
  },
  {
    name: "investigation_attempts",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("attempt_id"),
      t("case_id"),
      i("ordinal"),
      i("plan_revision"),
      t("outcome"),
      t("attempt_json"),
      t("created_at"),
    ],
    primaryKey: ["attempt_id"],
    uniques: [
      {
        name: "investigation_attempts_ordinal_unique",
        columns: ["case_id", "ordinal"],
      },
    ],
    foreignKeys: [
      { columns: ["case_id"], references: { table: "investigation_cases", columns: ["case_id"] } },
    ],
    checks: [
      {
        name: "investigation_attempts_outcome_check",
        predicate:
          "outcome IN ('reproduced', 'not_reproduced', 'diverged', 'environment_failed', 'blocked')",
      },
    ],
  },
  {
    name: "investigation_bug_episodes",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("episode_id"),
      t("case_id"),
      t("finding_id"),
      r("confidence"),
      t("episode_json"),
      t("created_at"),
    ],
    primaryKey: ["episode_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["case_id"], references: { table: "investigation_cases", columns: ["case_id"] } },
    ],
    checks: [],
  },
  {
    name: "investigation_handoffs",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [t("case_id"), t("handoff_json"), t("created_at")],
    primaryKey: ["case_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["case_id"], references: { table: "investigation_cases", columns: ["case_id"] } },
    ],
    checks: [],
  },
  {
    name: "review_tasks",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("task_id"),
      t("case_id"),
      t("status"),
      t("reason"),
      t("priority"),
      t("evidence_completeness"),
      t("assignee_id", false),
      i("version"),
      t("created_at"),
      t("updated_at"),
    ],
    primaryKey: ["task_id"],
    uniques: [],
    foreignKeys: [],
    checks: [
      {
        name: "review_tasks_status_check",
        predicate: "status IN ('open', 'claimed', 'resolved')",
      },
      {
        name: "review_tasks_priority_check",
        predicate: "priority IN ('low', 'medium', 'high', 'urgent')",
      },
      {
        name: "review_tasks_evidence_completeness_check",
        predicate:
          "evidence_completeness IN ('complete', 'limited', 'unavailable')",
      },
    ],
  },
  {
    name: "review_claims",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("idempotency_key"),
      t("task_id"),
      t("reviewer_id"),
      i("claimed_version"),
      t("created_at"),
    ],
    primaryKey: ["idempotency_key"],
    uniques: [],
    foreignKeys: [
      { columns: ["task_id"], references: { table: "review_tasks", columns: ["task_id"] } },
    ],
    checks: [],
  },
  {
    name: "review_resolutions",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("idempotency_key"),
      t("task_id"),
      t("case_id"),
      t("reviewer_id"),
      t("disposition"),
      t("evidence_refs_json"),
      i("resolved_version"),
      t("created_at"),
    ],
    primaryKey: ["idempotency_key"],
    uniques: [],
    foreignKeys: [
      { columns: ["task_id"], references: { table: "review_tasks", columns: ["task_id"] } },
    ],
    checks: [],
  },
  {
    name: "intelligence_jobs",
    tenantOwned: true,
    hasNativeTenantColumn: true,
    workerAccessible: false,
    columns: [
      t("job_id"),
      t("job_type"),
      t("schema_version"),
      t("tenant_id"),
      t("project_id"),
      t("aggregate_type"),
      t("aggregate_id"),
      i("base_aggregate_version"),
      t("model_profile_id"),
      t("data_policy_id"),
      t("priority"),
      t("idempotency_key"),
      t("causation_id"),
      t("expected_result_schema"),
      t("job_json"),
      t("created_at"),
    ],
    primaryKey: ["job_id"],
    uniques: [
      {
        name: "intelligence_jobs_idempotency_key_unique",
        columns: ["idempotency_key"],
      },
    ],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "intelligence_results",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("idempotency_key"),
      t("job_id"),
      t("terminal_status"),
      r("confidence"),
      t("result_json"),
      t("created_at"),
    ],
    primaryKey: ["idempotency_key"],
    uniques: [],
    foreignKeys: [
      { columns: ["job_id"], references: { table: "intelligence_jobs", columns: ["job_id"] } },
    ],
    checks: [],
  },
  {
    name: "intelligence_applied_results",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("idempotency_key"),
      t("aggregate_type"),
      t("aggregate_id"),
      i("new_version"),
      t("summary"),
      t("created_at"),
    ],
    primaryKey: ["idempotency_key"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "evidence_encryption_profiles",
    tenantOwned: true,
    hasNativeTenantColumn: true,
    workerAccessible: false,
    columns: [
      t("profile_id"),
      t("tenant_id"),
      t("case_id"),
      t("recipient"),
      t("region"),
      t("purpose"),
      t("policy_id"),
      t("wrapping_key_id"),
      t("wrapping_public_key_pem"),
      t("content_encryption_algorithm"),
      t("key_wrapping_algorithm"),
      t("aad_schema_version"),
      t("allowed_entry_kinds_json"),
      i("maximum_entry_bytes"),
      i("maximum_plaintext_bytes"),
      i("maximum_ciphertext_bytes"),
      t("expires_at"),
      t("created_at"),
    ],
    primaryKey: ["profile_id"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "evidence_capsule_manifests",
    tenantOwned: true,
    hasNativeTenantColumn: true,
    workerAccessible: false,
    columns: [
      t("capsule_id"),
      i("revision"),
      i("parent_revision", false),
      t("profile_id"),
      t("payload_schema_version"),
      t("aad_schema_version"),
      t("tenant_id"),
      t("case_id"),
      t("recipient"),
      t("region"),
      t("purpose"),
      t("policy_id"),
      t("content_encryption_algorithm"),
      t("key_wrapping_algorithm"),
      t("wrapping_key_id"),
      t("plaintext_sha256"),
      i("plaintext_bytes"),
      t("ciphertext_sha256"),
      i("ciphertext_bytes"),
      b("ciphertext", false),
      t("wrapped_dek_base64"),
      t("nonce_base64"),
      t("auth_tag_base64"),
      t("protected_header_json"),
      t("revocation_state"),
      t("revoked_at", false),
      t("revoked_reason", false),
      t("created_at"),
      t("expires_at"),
    ],
    primaryKey: ["capsule_id", "revision"],
    uniques: [],
    foreignKeys: [
      { columns: ["profile_id"], references: { table: "evidence_encryption_profiles", columns: ["profile_id"] } },
    ],
    checks: [
      {
        name: "evidence_capsule_manifests_revocation_state_check",
        predicate: "revocation_state IN ('active', 'revoked')",
      },
    ],
  },
  {
    name: "evidence_capsule_entries",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("entry_id"),
      t("capsule_id"),
      i("revision"),
      t("kind"),
      t("media_type"),
      t("plaintext_sha256"),
      i("plaintext_bytes"),
      t("created_at"),
    ],
    primaryKey: ["capsule_id", "revision", "entry_id"],
    uniques: [],
    foreignKeys: [],
    checks: [
      {
        name: "evidence_capsule_entries_kind_check",
        predicate:
          "kind IN ('trace', 'semantic_graph', 'screenshot', 'log_summary')",
      },
    ],
  },
  {
    name: "evidence_key_rotations",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("rotation_id"),
      t("capsule_id"),
      i("parent_revision"),
      i("new_revision"),
      t("actor_id"),
      t("reason"),
      t("old_key_id"),
      t("new_key_id"),
      t("occurred_at"),
    ],
    primaryKey: ["rotation_id"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "evidence_local_only_records",
    tenantOwned: true,
    hasNativeTenantColumn: true,
    workerAccessible: false,
    columns: [
      t("local_record_id"),
      t("tenant_id"),
      t("case_id"),
      t("run_id"),
      t("disposition"),
      t("reason"),
      t("local_content_refs_json"),
      t("created_at"),
      t("expires_at"),
    ],
    primaryKey: ["local_record_id"],
    uniques: [],
    foreignKeys: [],
    checks: [
      {
        name: "evidence_local_only_records_disposition_check",
        predicate: "disposition IN ('local_only')",
      },
    ],
  },
  {
    name: "evidence_audit_events",
    tenantOwned: true,
    hasNativeTenantColumn: true,
    workerAccessible: false,
    columns: [
      t("audit_id"),
      t("actor_type"),
      t("actor_id"),
      t("tenant_id"),
      t("case_id"),
      t("capsule_id"),
      t("key_version"),
      t("purpose"),
      t("operation"),
      t("decision"),
      t("reason_code"),
      t("correlation_id"),
      t("occurred_at"),
    ],
    primaryKey: ["audit_id"],
    uniques: [],
    foreignKeys: [],
    checks: [
      {
        name: "evidence_audit_events_actor_type_check",
        predicate: "actor_type IN ('user', 'service')",
      },
      {
        name: "evidence_audit_events_operation_check",
        predicate:
          "operation IN ('profile', 'wrap', 'unwrap', 'rewrap', 'revoke', 'delete')",
      },
      {
        name: "evidence_audit_events_decision_check",
        predicate: "decision IN ('allowed', 'denied', 'failed')",
      },
    ],
  },
  // ---- Migration 006: runner control --------------------------------
  {
    name: "runner_sessions",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("session_id"),
      t("runner_id"),
      t("certificate_fingerprint"),
      t("capabilities_json"),
      i("protocol_major"),
      t("created_at"),
      t("closed_at", false),
    ],
    primaryKey: ["session_id"],
    uniques: [],
    foreignKeys: [],
    checks: [],
    partialIndexes: [
      {
        name: "runner_sessions_active_runner_id",
        columns: ["runner_id"],
        predicate: "closed_at IS NULL",
      },
    ],
  },
  {
    name: "runner_resume_tokens",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("token_hash"),
      t("runner_id"),
      t("certificate_fingerprint"),
      t("previous_session_id"),
      i("protocol_major"),
      t("expires_at"),
      t("consumed_at", false),
    ],
    primaryKey: ["token_hash"],
    uniques: [],
    foreignKeys: [],
    checks: [],
    partialIndexes: [
      {
        name: "runner_resume_tokens_unconsumed_expiry",
        columns: ["expires_at"],
        predicate: "consumed_at IS NULL",
      },
    ],
  },
  {
    name: "execution_leases",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("run_id"),
      t("job_id"),
      t("runner_id"),
      t("session_id"),
      i("lease_epoch"),
      t("job_json"),
      t("lease_token_hash"),
      t("expires_at"),
      t("lost_at", false),
      t("completed_at", false),
      t("recovery_of_run_id", false),
    ],
    primaryKey: ["run_id"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  {
    name: "execution_completions",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("run_id"),
      t("job_id"),
      t("completion_json"),
      t("completed_at"),
    ],
    primaryKey: ["run_id"],
    uniques: [],
    foreignKeys: [],
    checks: [],
  },
  // ---- Migration 007: Local run intake -------------------------------
  {
    name: "local_run_intakes",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("run_id"), t("job_id"), t("job_json"), t("job_sha256"), t("dispatch_state"),
      i("dispatch_attempt"), t("dispatch_last_attempt_at", false), t("dispatch_error_code", false),
      t("completion_state"), i("completion_attempt"), t("completion_last_attempt_at", false),
      t("completion_next_attempt_at"), t("completion_error_code", false), t("completion_sha256", false),
      t("completion_applied_at", false), t("completion_blocked_at", false), t("created_at"), t("updated_at"),
    ],
    primaryKey: ["run_id"],
    uniques: [{ name: "local_run_intakes_job_id_unique", columns: ["job_id"] }],
    foreignKeys: [{ columns: ["run_id"], references: { table: "execution_runs", columns: ["run_id"] } }],
    checks: [
      { name: "local_run_intakes_dispatch_state_check", predicate: "dispatch_state IN ('pending_runner', 'dispatching', 'offer_outcome_unknown', 'offered')" },
      { name: "local_run_intakes_completion_state_check", predicate: "completion_state IN ('awaiting', 'applied', 'integrity_blocked', 'retry_exhausted')" },
      { name: "local_run_intakes_attempt_check", predicate: "dispatch_attempt >= 0 AND completion_attempt >= 0" },
    ],
  },
  // ---- Migration 008: Target and Test Plan revisions -----------------
  {
    name: "project_targets", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("target_id"), t("project_id"), i("current_version"), t("created_at"), t("updated_at")],
    primaryKey: ["target_id"], uniques: [], foreignKeys: [], checks: [],
  },
  {
    name: "target_revisions", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("target_id"), i("version"), t("project_id"), t("display_name"), t("runner_id"), t("kind"), t("snapshot_hash"), t("configuration_json"), t("idempotency_key"), t("created_at")],
    primaryKey: ["target_id", "version"],
    uniques: [{ name: "target_revisions_idempotency_key_unique", columns: ["idempotency_key"] }],
    foreignKeys: [{ columns: ["target_id"], references: { table: "project_targets", columns: ["target_id"] } }],
    checks: [{ name: "target_revisions_kind_check", predicate: "kind IN ('web', 'desktop')" }],
  },
  {
    name: "test_plan_heads", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("plan_id"), t("project_id"), i("current_version"), t("created_at"), t("updated_at")],
    primaryKey: ["plan_id"], uniques: [], foreignKeys: [], checks: [],
  },
  {
    name: "test_plan_version_revisions", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("plan_id"), i("version"), t("project_id"), t("prd_id"), i("prd_revision"), t("status"), t("reviewer_id", false), t("approved_at", false), t("idempotency_key"), t("plan_json"), t("created_at")],
    primaryKey: ["plan_id", "version"],
    uniques: [{ name: "test_plan_version_revisions_idempotency_key_unique", columns: ["idempotency_key"] }],
    foreignKeys: [{ columns: ["plan_id"], references: { table: "test_plan_heads", columns: ["plan_id"] } }],
    checks: [{ name: "test_plan_version_revisions_status_check", predicate: "status IN ('draft', 'approved')" }],
  },
  // ---- Migration 009: Mission scheduling ------------------------------
  {
    name: "mission_scheduling_heads", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("mission_id"), i("mission_revision"), i("version"), t("compiled_hash")],
    primaryKey: ["mission_id"], uniques: [],
    foreignKeys: [{ columns: ["mission_id", "mission_revision"], references: { table: "missions", columns: ["mission_id", "revision"] } }], checks: [],
  },
  {
    name: "mission_start_commands", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("idempotency_key"), t("command_hash"), t("mission_id"), i("expected_mission_version"), i("mission_revision"), t("mission_compiled_hash"), t("mission_snapshot_json"), t("result_json"), t("created_at")],
    primaryKey: ["idempotency_key"],
    uniques: [{ name: "mission_start_commands_mission_unique", columns: ["mission_id"] }],
    foreignKeys: [{ columns: ["mission_id", "mission_revision"], references: { table: "missions", columns: ["mission_id", "revision"] } }], checks: [],
  },
  {
    name: "mission_job_attempts", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("attempt_id"), t("mission_id"), i("mission_revision"), t("logical_job_id"), t("runner_job_id"), t("run_id"), t("status"), t("created_at")],
    primaryKey: ["attempt_id"],
    uniques: [
      { name: "mission_job_attempts_runner_job_unique", columns: ["runner_job_id"] },
      { name: "mission_job_attempts_run_unique", columns: ["run_id"] },
    ],
    foreignKeys: [
      { columns: ["mission_id", "mission_revision"], references: { table: "missions", columns: ["mission_id", "revision"] } },
      { columns: ["logical_job_id"], references: { table: "execution_jobs", columns: ["job_id"] } },
      { columns: ["run_id"], references: { table: "execution_runs", columns: ["run_id"] } },
    ],
    checks: [{ name: "mission_job_attempts_status_check", predicate: "status IN ('pending_dispatch', 'accepted', 'passed', 'finding', 'blocked', 'error')" }],
  },
  {
    name: "runner_execution_jobs", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("runner_job_id"), t("attempt_id"), t("runner_id"), t("accepted_job_json"), t("accepted_job_hash"), t("created_at")],
    primaryKey: ["runner_job_id"],
    uniques: [{ name: "runner_execution_jobs_attempt_unique", columns: ["attempt_id"] }],
    foreignKeys: [{ columns: ["attempt_id"], references: { table: "mission_job_attempts", columns: ["attempt_id"] } }], checks: [],
  },
  {
    name: "mission_execution_provenance", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("attempt_id"), t("project_id"), t("mission_id"), i("mission_revision"), t("mission_compiled_hash"), t("mission_snapshot_json"), t("logical_job_id"), t("test_case_snapshot_json"), t("test_case_snapshot_hash"), t("plan_id"), i("plan_version"), t("plan_snapshot_hash"), t("plan_snapshot_json"), t("target_id"), i("target_version"), t("target_snapshot_hash"), t("target_snapshot_json"), t("runner_id"), t("policy_json"), t("policy_hash"), t("created_at")],
    primaryKey: ["attempt_id"], uniques: [],
    foreignKeys: [{ columns: ["attempt_id"], references: { table: "mission_job_attempts", columns: ["attempt_id"] } }], checks: [],
  },
  {
    name: "mission_dispatch_outbox", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("attempt_id"), t("mission_id"), t("runner_id"), t("runner_job_id"), t("run_id"), t("idempotency_key"), t("required_capabilities_json"), t("accepted_job_json"), t("status"), i("version"), t("accepted_at", false), t("acceptance_receipt_json", false), t("created_at")],
    primaryKey: ["attempt_id"],
    uniques: [
      { name: "mission_dispatch_outbox_runner_job_unique", columns: ["runner_job_id"] },
      { name: "mission_dispatch_outbox_run_unique", columns: ["run_id"] },
      { name: "mission_dispatch_outbox_command_job_unique", columns: ["idempotency_key", "runner_job_id"] },
    ],
    foreignKeys: [{ columns: ["attempt_id"], references: { table: "mission_job_attempts", columns: ["attempt_id"] } }],
    checks: [
      { name: "mission_dispatch_outbox_status_check", predicate: "status IN ('pending', 'accepted', 'blocked')" },
      { name: "mission_dispatch_outbox_version_check", predicate: "version > 0" },
      { name: "mission_dispatch_outbox_acceptance_check", predicate: "(status = 'accepted' AND accepted_at IS NOT NULL AND acceptance_receipt_json IS NOT NULL) OR (status <> 'accepted' AND accepted_at IS NULL AND acceptance_receipt_json IS NULL)" },
    ],
    partialIndexes: [{ name: "mission_dispatch_outbox_pending", columns: ["status", "created_at", "attempt_id"], predicate: "status = 'pending'" }],
  },
  {
    name: "mission_dispatch_wakeups", tenantOwned: true, hasNativeTenantColumn: false, workerAccessible: false,
    columns: [t("wakeup_id"), i("generation"), t("updated_at")],
    primaryKey: ["wakeup_id"], uniques: [], foreignKeys: [],
    checks: [{ name: "mission_dispatch_wakeups_generation_check", predicate: "generation > 0" }],
  },
  // ---- Migration 010: Skill lifecycle command idempotency + audit ------
  {
    name: "skill_lifecycle_commands",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("idempotency_key"),
      t("command_hash"),
      t("command_type"),
      t("skill_id"),
      i("expected_version"),
      i("result_version"),
      t("result_json"),
      t("created_at"),
    ],
    primaryKey: ["idempotency_key"],
    uniques: [],
    foreignKeys: [
      { columns: ["skill_id"], references: { table: "skills", columns: ["skill_id"] } },
    ],
    checks: [
      { name: "skill_lifecycle_commands_type_check", predicate: "command_type IN ('promote', 'deprecate')" },
    ],
  },
  {
    name: "skill_lifecycle_audit_events",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("audit_id"),
      t("skill_id"),
      i("skill_version"),
      t("operation"),
      t("decision"),
      t("actor_id"),
      t("actor_tenant_id"),
      t("actor_roles_json"),
      t("reason"),
      t("metadata_json"),
      t("created_at"),
    ],
    primaryKey: ["audit_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["skill_id", "skill_version"], references: { table: "skill_versions", columns: ["skill_id", "version"] } },
    ],
    checks: [
      { name: "skill_lifecycle_audit_events_operation_check", predicate: "operation IN ('promote', 'deprecate')" },
      { name: "skill_lifecycle_audit_events_decision_check", predicate: "decision IN ('allowed', 'rejected')" },
    ],
  },
  // ---- Migration 011: live exploration progress -----------------------
  {
    name: "exploration_attempt_progress",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("attempt_id"),
      t("run_id"),
      t("source_binding_hash"),
      t("policy_binding_hash"),
      t("seed_binding_hash"),
      t("phase"),
      t("seed_cursor_json"),
      i("last_safe_step"),
      t("last_safe_graph_fingerprint", false),
      t("remaining_json"),
      t("in_flight_action_json", false),
      t("terminal_reason", false),
      i("version"),
      t("created_at"),
      t("updated_at"),
    ],
    primaryKey: ["attempt_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["run_id"], references: { table: "benchmark_runs", columns: ["run_id"] } },
    ],
    checks: [
      {
        name: "exploration_attempt_progress_phase_check",
        predicate: "phase IN ('seed_replay', 'exploring', 'action_in_flight', 'terminal')",
      },
      {
        name: "exploration_attempt_progress_terminal_check",
        predicate: "terminal_reason IS NULL OR terminal_reason IN ('objective_satisfied', 'no_safe_action', 'state_repeated', 'budget_exhausted', 'policy_denied', 'plan_diverged', 'finding_created', 'error')",
      },
      { name: "exploration_attempt_progress_version_check", predicate: "version >= 1" },
    ],
  },
  {
    name: "exploration_live_checkpoints",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("attempt_id"),
      i("step"),
      t("graph_fingerprint"),
      t("remaining_json"),
      t("terminal_reason", false),
      t("created_at"),
    ],
    primaryKey: ["attempt_id", "step"],
    uniques: [],
    foreignKeys: [
      { columns: ["attempt_id"], references: { table: "exploration_attempt_progress", columns: ["attempt_id"] } },
    ],
    checks: [
      {
        name: "exploration_live_checkpoints_terminal_check",
        predicate: "terminal_reason IS NULL OR terminal_reason IN ('objective_satisfied', 'no_safe_action', 'state_repeated', 'budget_exhausted', 'policy_denied', 'plan_diverged', 'finding_created', 'error')",
      },
    ],
  },
  // ---- Migration 012: durable Intelligence leases and Result inbox -----
  {
    name: "intelligence_leases",
    tenantOwned: true,
    hasNativeTenantColumn: true,
    workerAccessible: false,
    columns: [
      t("tenant_id"),
      t("job_id"),
      i("attempt"),
      t("worker_id"),
      t("lease_token_hash"),
      t("lease_started_at"),
      t("expires_at"),
      t("last_renewed_at", false),
      i("renewal_count"),
      t("released_at", false),
      t("completed_at", false),
    ],
    primaryKey: ["tenant_id", "job_id", "attempt"],
    uniques: [],
    foreignKeys: [
      { columns: ["job_id"], references: { table: "intelligence_jobs", columns: ["job_id"] } },
    ],
    checks: [
      { name: "intelligence_leases_attempt_check", predicate: "attempt >= 1" },
      { name: "intelligence_leases_renewal_count_check", predicate: "renewal_count >= 0" },
    ],
    partialIndexes: [
      {
        name: "intelligence_leases_live_unique",
        columns: ["tenant_id", "job_id"],
        predicate: "released_at IS NULL AND completed_at IS NULL",
        unique: true,
      },
    ],
  },
  {
    name: "intelligence_result_inbox",
    tenantOwned: true,
    hasNativeTenantColumn: true,
    workerAccessible: false,
    columns: [
      t("tenant_id"),
      t("idempotency_key"),
      t("job_id"),
      t("worker_id"),
      i("lease_attempt"),
      t("lease_token_hash"),
      t("lease_expires_at"),
      i("base_aggregate_version"),
      t("result_hash"),
      t("result_json"),
      t("accepted_at"),
    ],
    primaryKey: ["tenant_id", "idempotency_key"],
    uniques: [],
    foreignKeys: [
      { columns: ["job_id"], references: { table: "intelligence_jobs", columns: ["job_id"] } },
      { columns: ["tenant_id", "job_id", "lease_attempt"], references: { table: "intelligence_leases", columns: ["tenant_id", "job_id", "attempt"] } },
    ],
    checks: [
      { name: "intelligence_result_inbox_lease_attempt_check", predicate: "lease_attempt >= 1" },
    ],
  },
  // ---- Migration 013: Result wakeups and durable dispositions ----------
  {
    name: "intelligence_result_wakeups",
    tenantOwned: true,
    hasNativeTenantColumn: true,
    workerAccessible: false,
    columns: [
      t("tenant_id"),
      i("generation"),
      t("status"),
      t("available_at"),
      t("lease_owner", false),
      i("lease_generation", false),
      t("lease_expires_at", false),
      t("last_claimed_at", false),
      t("last_completed_at", false),
      i("failure_count"),
      t("last_error", false),
      t("created_at"),
      t("updated_at"),
    ],
    primaryKey: ["tenant_id"],
    uniques: [],
    foreignKeys: [],
    checks: [
      { name: "intelligence_result_wakeups_generation_check", predicate: "generation >= 0" },
      { name: "intelligence_result_wakeups_status_check", predicate: "status IN ('pending', 'idle')" },
      { name: "intelligence_result_wakeups_failure_count_check", predicate: "failure_count >= 0" },
    ],
    partialIndexes: [
      {
        name: "intelligence_result_wakeups_due",
        columns: ["status", "available_at", "tenant_id"],
        predicate: "status = 'pending'",
      },
    ],
  },
  {
    name: "intelligence_result_dispositions",
    tenantOwned: true,
    hasNativeTenantColumn: true,
    workerAccessible: false,
    columns: [
      t("tenant_id"),
      t("idempotency_key"),
      t("job_id"),
      t("result_hash"),
      t("status"),
      t("code", false),
      t("reason", false),
      t("aggregate_type", false),
      t("aggregate_id", false),
      i("new_version", false),
      t("summary", false),
      t("follow_up_job_id", false),
      t("created_at"),
    ],
    primaryKey: ["tenant_id", "idempotency_key"],
    uniques: [],
    foreignKeys: [
      { columns: ["tenant_id", "idempotency_key"], references: { table: "intelligence_result_inbox", columns: ["tenant_id", "idempotency_key"] } },
      { columns: ["follow_up_job_id"], references: { table: "intelligence_jobs", columns: ["job_id"] } },
    ],
    checks: [
      { name: "intelligence_result_dispositions_status_check", predicate: "status IN ('applied', 'duplicate', 'rejected', 'recompute')" },
    ],
  },
  // ---- Migration 014: resumable artifact upload ----------------------
  {
    name: "artifact_upload_manifests",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("artifact_id"),
      t("project_id"),
      t("run_id"),
      t("job_id"),
      i("size_bytes"),
      t("sha256"),
      t("media_type"),
      t("sensitivity"),
      i("chunk_size_bytes"),
      i("total_chunks"),
      t("registered_by_runner_id"),
      i("registered_lease_epoch"),
      t("status"),
      t("relative_path", false),
      t("created_at"),
      t("verified_at", false),
    ],
    primaryKey: ["artifact_id"],
    uniques: [],
    foreignKeys: [
      { columns: ["run_id"], references: { table: "execution_runs", columns: ["run_id"] } },
    ],
    checks: [
      { name: "artifact_upload_manifests_status_check", predicate: "status IN ('registered', 'verified')" },
      { name: "artifact_upload_manifests_size_check", predicate: "size_bytes >= 0" },
      { name: "artifact_upload_manifests_chunk_size_check", predicate: "chunk_size_bytes = 262144" },
      { name: "artifact_upload_manifests_total_chunks_check", predicate: "total_chunks >= 0" },
    ],
  },
  {
    name: "artifact_upload_chunks",
    tenantOwned: true,
    hasNativeTenantColumn: false,
    workerAccessible: false,
    columns: [
      t("artifact_id"),
      i("offset_bytes"),
      i("size_bytes"),
      t("sha256"),
      b("bytes", true),
      t("created_at"),
    ],
    primaryKey: ["artifact_id", "offset_bytes"],
    uniques: [],
    foreignKeys: [
      { columns: ["artifact_id"], references: { table: "artifact_upload_manifests", columns: ["artifact_id"] } },
    ],
    checks: [
      { name: "artifact_upload_chunks_offset_check", predicate: "offset_bytes >= 0" },
      { name: "artifact_upload_chunks_size_check", predicate: "size_bytes > 0 AND size_bytes <= 262144" },
    ],
  },
];

export const RELATIONAL_SCHEMA_VERSIONS: readonly RelationalSchemaVersion[] = [
  { version: 1, name: "initial-schema", tables: tablesThrough("model_invocations") },
  { version: 2, name: "prd-mission", tables: tablesFromTo("prd_documents", "execution_job_attempts") },
  { version: 3, name: "skill", tables: tablesFromTo("recordings", "skill_revocations") },
  { version: 4, name: "exploration-benchmark", tables: tablesFromTo("benchmark_runs", "benchmark_reports") },
  { version: 5, name: "investigation-review", tables: tablesFromTo("investigation_cases", "evidence_audit_events") },
  { version: 6, name: "runner-control", tables: tablesFromTo("runner_sessions", "execution_completions") },
  { version: 7, name: "local-run-intake", tables: tablesFromTo("local_run_intakes", "local_run_intakes") },
  { version: 8, name: "target-test-plan-revisions", tables: tablesFromTo("project_targets", "test_plan_version_revisions") },
  { version: 9, name: "mission-scheduling", tables: tablesFromTo("mission_scheduling_heads", "mission_dispatch_wakeups") },
  { version: 10, name: "skill-lifecycle-commands", tables: tablesFromTo("skill_lifecycle_commands", "skill_lifecycle_audit_events") },
  { version: 11, name: "exploration-attempt-progress", tables: tablesFromTo("exploration_attempt_progress", "exploration_live_checkpoints") },
  { version: 12, name: "intelligence-leases-results", tables: tablesFromTo("intelligence_leases", "intelligence_result_inbox") },
  { version: 13, name: "intelligence-result-wakeups-dispositions", tables: tablesFromTo("intelligence_result_wakeups", "intelligence_result_dispositions") },
  { version: 14, name: "artifact-upload", tables: tablesFromTo("artifact_upload_manifests", "artifact_upload_chunks") },
  { version: 15, name: "evidence-lifecycle", tables: [] },
];

function tablesThrough(last: string): readonly string[] {
  return RELATIONAL_TABLES.slice(0, tableIndex(last) + 1).map(({ name }) => name);
}

function tablesFrom(first: string): readonly string[] {
  return RELATIONAL_TABLES.slice(tableIndex(first)).map(({ name }) => name);
}

function tablesFromTo(first: string, last: string): readonly string[] {
  return RELATIONAL_TABLES.slice(tableIndex(first), tableIndex(last) + 1).map(({ name }) => name);
}

function tableIndex(name: string): number {
  const index = RELATIONAL_TABLES.findIndex((table) => table.name === name);
  if (index < 0) throw new Error(`Unknown relational table ${name}`);
  return index;
}

export const TENANT_OWNED_TABLES: readonly RelationalTableSpec[] =
  RELATIONAL_TABLES.filter((table) => table.tenantOwned);

export const WORKER_ACCESSIBLE_TABLES: readonly RelationalTableSpec[] =
  RELATIONAL_TABLES.filter((table) => table.workerAccessible);

export function relationalTableNames(): readonly string[] {
  return RELATIONAL_TABLES.map((table) => table.name);
}

export function tenantOwnedTableNames(): readonly string[] {
  return TENANT_OWNED_TABLES.map((table) => table.name);
}

export function tenantOwnedTableNamesThroughVersion(version: number): readonly string[] {
  const present = new Set(
    RELATIONAL_SCHEMA_VERSIONS
      .filter((schemaVersion) => schemaVersion.version <= version)
      .flatMap((schemaVersion) => schemaVersion.tables),
  );
  return TENANT_OWNED_TABLES
    .filter((table) => present.has(table.name))
    .map((table) => table.name);
}
