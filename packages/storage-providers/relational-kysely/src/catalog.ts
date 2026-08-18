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
    workerAccessible: true,
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
    workerAccessible: true,
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
];

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
