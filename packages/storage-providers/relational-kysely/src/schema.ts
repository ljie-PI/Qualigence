export interface SchemaMigrationsTable {
  version: number;
  name: string;
  applied_at: string;
}

export interface ExecutionRunsTable {
  run_id: string;
  job_id: string;
  target_kind: string;
  objective: string;
  status: string;
  next_sequence_number: number;
  created_at: string;
  completed_at: string | null;
  error_code: string | null;
}

export interface TraceEventsTable {
  run_id: string;
  sequence_number: number;
  message_id: string;
  idempotency_key: string;
  stage: string;
  occurred_at: string;
  payload_hash: string;
  envelope_json: string;
}

export interface FindingsTable {
  finding_id: string;
  run_id: string;
  payload_hash: string;
  envelope_json: string;
  created_at: string;
}

export interface ArtifactManifestsTable {
  artifact_id: string;
  run_id: string;
  kind: string;
  media_type: string;
  relative_path: string;
  sha256: string;
  size_bytes: number;
  created_at: string;
}

export interface ModelInvocationsTable {
  invocation_id: string;
  run_id: string;
  operation: string;
  model: string;
  status: string;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  provider_request_id: string | null;
  error_code: string | null;
  occurred_at: string;
}

export interface PrdDocumentsTable {
  prd_id: string;
  revision: number;
  project_id: string;
  title: string;
  content: string;
  content_sha256: string;
  ingested_at: string;
}

export interface TestPlanRevisionsTable {
  plan_id: string;
  project_id: string;
  prd_id: string;
  prd_revision: number;
  version: number;
  status: string;
  reviewer_id: string | null;
  approved_at: string | null;
  idempotency_key: string | null;
  plan_json: string;
  created_at: string;
}

export interface ExpectedClaimsTable {
  claim_id: string;
  plan_id: string;
  semantic_key: string;
  statement: string;
  confidence: number;
  source_refs_json: string;
}

export interface TestCasesTable {
  test_case_id: string;
  plan_id: string;
  title: string;
  objective: string;
  priority: string;
  source_refs_json: string;
  snapshot_json: string;
}

export interface MissionsTable {
  mission_id: string;
  revision: number;
  project_id: string;
  plan_id: string;
  prd_id: string;
  prd_revision: number;
  target_id: string;
  compiled_hash: string;
  status: string;
  dispatch_json: string;
  stop_on_blocked: number;
}

export interface MissionRevisionsTable {
  mission_id: string;
  revision: number;
  compiled_json: string;
  created_at: string;
}

export interface ExecutionJobsTable {
  job_id: string;
  mission_id: string;
  mission_revision: number;
  test_case_id: string;
  objective: string;
  required_capabilities_json: string;
  source_refs_json: string;
  snapshot_hash: string;
  snapshot_json: string;
  idempotency_key: string;
  status: string;
}

export interface ExecutionJobAttemptsTable {
  attempt_id: string;
  job_id: string;
  mission_id: string;
  run_id: string;
  status: string;
  error_code: string | null;
  created_at: string;
}

export interface RecordingsTable {
  recording_id: string;
  project_id: string;
  target_id: string;
  target_version: string;
  observation_schema_epoch: string;
  started_at: string;
  completed_at: string;
  source_trace_refs_json: string;
}

export interface RecordingStepsTable {
  recording_id: string;
  ordinal: number;
  step_json: string;
}

export interface SkillsTable {
  skill_id: string;
  project_id: string;
  target_id: string;
  current_version: number;
  current_state: string;
  created_at: string;
  updated_at: string;
}

export interface SkillVersionsTable {
  skill_id: string;
  version: number;
  state: string;
  project_id: string;
  source_recording_id: string;
  content_sha256: string;
  content_json: string;
  created_at: string;
}

export interface SkillEvaluationsTable {
  evaluation_id: string;
  skill_id: string;
  skill_version: number;
  outcome: string;
  signature_valid: number;
  oracles_json: string;
  created_at: string;
}

export interface SkillBundlesTable {
  skill_id: string;
  skill_version: number;
  bundle_id: string;
  signer_key_id: string;
  signature_algorithm: string;
  content_sha256: string;
  manifest_json: string;
  payload_json: string;
  issued_at: string;
}

export interface SkillRevocationsTable {
  revocation_id: string;
  skill_id: string;
  skill_version: number;
  reason: string;
  revoked_at: string;
}

export interface SkillLifecycleCommandsTable {
  idempotency_key: string;
  command_hash: string;
  command_type: string;
  skill_id: string;
  expected_version: number;
  result_version: number;
  result_json: string;
  created_at: string;
}

export interface SkillLifecycleAuditEventsTable {
  audit_id: string;
  skill_id: string;
  skill_version: number;
  operation: string;
  decision: string;
  actor_id: string;
  actor_tenant_id: string;
  actor_roles_json: string;
  reason: string;
  metadata_json: string;
  created_at: string;
}

export interface BenchmarkRunsTable {
  run_id: string;
  benchmark_version: string;
  manifest_sha256: string;
  profile_sha256: string;
  ground_truth_sha256: string;
  created_at: string;
}

export interface BenchmarkAttemptsTable {
  attempt_id: string;
  run_id: string;
  profile_sha256: string;
  scenario_id: string;
  mode: string;
  repetition: number;
  terminal_reason: string;
  findings_json: string;
  created_at: string;
}

export interface ExplorationCheckpointsTable {
  attempt_id: string;
  step: number;
  graph_fingerprint: string;
  remaining_json: string;
  terminal_reason: string | null;
}

export interface ExplorationAttemptProgressTable {
  attempt_id: string;
  run_id: string;
  source_binding_hash: string;
  policy_binding_hash: string;
  seed_binding_hash: string;
  phase: string;
  seed_cursor_json: string;
  last_safe_step: number;
  last_safe_graph_fingerprint: string | null;
  remaining_json: string;
  in_flight_action_json: string | null;
  terminal_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ExplorationLiveCheckpointsTable {
  attempt_id: string;
  step: number;
  graph_fingerprint: string;
  remaining_json: string;
  terminal_reason: string | null;
  created_at: string;
}

export interface BenchmarkReportsTable {
  report_id: string;
  run_id: string;
  profile_status: string;
  gate_status: string;
  failure_codes_json: string;
  report_json: string;
  created_at: string;
}

export interface InvestigationCasesTable {
  case_id: string;
  finding_id: string;
  project_id: string;
  status: string;
  version: number;
  plan_revision: number;
  budget_json: string;
  usage_json: string;
  bug_episode_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvestigationAttemptsTable {
  attempt_id: string;
  case_id: string;
  ordinal: number;
  plan_revision: number;
  outcome: string;
  attempt_json: string;
  created_at: string;
}

export interface InvestigationBugEpisodesTable {
  episode_id: string;
  case_id: string;
  finding_id: string;
  confidence: number;
  episode_json: string;
  created_at: string;
}

export interface InvestigationHandoffsTable {
  case_id: string;
  handoff_json: string;
  created_at: string;
}

export interface ReviewTasksTable {
  task_id: string;
  case_id: string;
  status: string;
  reason: string;
  priority: string;
  evidence_completeness: string;
  assignee_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ReviewClaimsTable {
  idempotency_key: string;
  task_id: string;
  reviewer_id: string;
  claimed_version: number;
  created_at: string;
}

export interface ReviewResolutionsTable {
  idempotency_key: string;
  task_id: string;
  case_id: string;
  reviewer_id: string;
  disposition: string;
  evidence_refs_json: string;
  resolved_version: number;
  created_at: string;
}

export interface IntelligenceJobsTable {
  job_id: string;
  job_type: string;
  schema_version: string;
  tenant_id: string;
  project_id: string;
  aggregate_type: string;
  aggregate_id: string;
  base_aggregate_version: number;
  model_profile_id: string;
  data_policy_id: string;
  priority: string;
  idempotency_key: string;
  causation_id: string;
  expected_result_schema: string;
  job_json: string;
  created_at: string;
}

export interface IntelligenceResultsTable {
  idempotency_key: string;
  job_id: string;
  terminal_status: string;
  confidence: number;
  result_json: string;
  created_at: string;
}

export interface IntelligenceAppliedResultsTable {
  idempotency_key: string;
  aggregate_type: string;
  aggregate_id: string;
  new_version: number;
  summary: string;
  created_at: string;
}

export interface EvidenceEncryptionProfilesTable {
  profile_id: string;
  tenant_id: string;
  case_id: string;
  recipient: string;
  region: string;
  purpose: string;
  policy_id: string;
  wrapping_key_id: string;
  wrapping_public_key_pem: string;
  content_encryption_algorithm: string;
  key_wrapping_algorithm: string;
  aad_schema_version: string;
  allowed_entry_kinds_json: string;
  maximum_entry_bytes: number;
  maximum_plaintext_bytes: number;
  maximum_ciphertext_bytes: number;
  expires_at: string;
  created_at: string;
}

export interface EvidenceCapsuleManifestsTable {
  capsule_id: string;
  revision: number;
  parent_revision: number | null;
  profile_id: string;
  payload_schema_version: string;
  aad_schema_version: string;
  tenant_id: string;
  case_id: string;
  recipient: string;
  region: string;
  purpose: string;
  policy_id: string;
  content_encryption_algorithm: string;
  key_wrapping_algorithm: string;
  wrapping_key_id: string;
  plaintext_sha256: string;
  plaintext_bytes: number;
  ciphertext_sha256: string;
  ciphertext_bytes: number;
  ciphertext: Uint8Array | null;
  wrapped_dek_base64: string;
  nonce_base64: string;
  auth_tag_base64: string;
  protected_header_json: string;
  revocation_state: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
  expires_at: string;
}

export interface EvidenceCapsuleEntriesTable {
  entry_id: string;
  capsule_id: string;
  revision: number;
  kind: string;
  media_type: string;
  plaintext_sha256: string;
  plaintext_bytes: number;
  created_at: string;
}

export interface EvidenceKeyRotationsTable {
  rotation_id: string;
  capsule_id: string;
  parent_revision: number;
  new_revision: number;
  actor_id: string;
  reason: string;
  old_key_id: string;
  new_key_id: string;
  occurred_at: string;
}

export interface EvidenceLocalOnlyRecordsTable {
  local_record_id: string;
  tenant_id: string;
  case_id: string;
  run_id: string;
  disposition: string;
  reason: string;
  local_content_refs_json: string;
  created_at: string;
  expires_at: string;
}

export interface EvidenceAuditEventsTable {
  audit_id: string;
  actor_type: string;
  actor_id: string;
  tenant_id: string;
  case_id: string;
  capsule_id: string;
  key_version: string;
  purpose: string;
  operation: string;
  decision: string;
  reason_code: string;
  correlation_id: string;
  occurred_at: string;
}

export interface RunnerSessionsTable {
  session_id: string;
  runner_id: string;
  certificate_fingerprint: string;
  capabilities_json: string;
  protocol_major: number;
  created_at: string;
  closed_at: string | null;
}

export interface RunnerResumeTokensTable {
  token_hash: string;
  runner_id: string;
  certificate_fingerprint: string;
  previous_session_id: string;
  protocol_major: number;
  expires_at: string;
  consumed_at: string | null;
}

export interface ExecutionLeasesTable {
  run_id: string;
  job_id: string;
  runner_id: string;
  session_id: string;
  lease_epoch: number;
  job_json: string;
  lease_token_hash: string;
  expires_at: string;
  lost_at: string | null;
  completed_at: string | null;
  recovery_of_run_id: string | null;
}

export interface ExecutionCompletionsTable {
  run_id: string;
  job_id: string;
  completion_json: string;
  completed_at: string;
}

export interface LocalRunIntakesTable {
  run_id: string;
  job_id: string;
  job_json: string;
  job_sha256: string;
  dispatch_state: string;
  dispatch_attempt: number;
  dispatch_last_attempt_at: string | null;
  dispatch_error_code: string | null;
  completion_state: string;
  completion_attempt: number;
  completion_last_attempt_at: string | null;
  completion_next_attempt_at: string;
  completion_error_code: string | null;
  completion_sha256: string | null;
  completion_applied_at: string | null;
  completion_blocked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectTargetsTable {
  target_id: string;
  project_id: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

export interface TargetRevisionsTable {
  target_id: string;
  version: number;
  project_id: string;
  display_name: string;
  runner_id: string;
  kind: string;
  snapshot_hash: string;
  configuration_json: string;
  idempotency_key: string;
  created_at: string;
}

export interface TestPlanHeadsTable {
  plan_id: string;
  project_id: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

export interface TestPlanVersionRevisionsTable {
  plan_id: string;
  version: number;
  project_id: string;
  prd_id: string;
  prd_revision: number;
  status: string;
  reviewer_id: string | null;
  approved_at: string | null;
  idempotency_key: string;
  plan_json: string;
  created_at: string;
}

export interface MissionStartCommandsTable {
  idempotency_key: string;
  command_hash: string;
  mission_id: string;
  expected_mission_version: number;
  mission_revision: number;
  mission_compiled_hash: string;
  mission_snapshot_json: string;
  result_json: string;
  created_at: string;
}

export interface MissionSchedulingHeadsTable {
  mission_id: string;
  mission_revision: number;
  version: number;
  compiled_hash: string;
}

export interface MissionJobAttemptsTable {
  attempt_id: string;
  mission_id: string;
  mission_revision: number;
  logical_job_id: string;
  runner_job_id: string;
  run_id: string;
  status: string;
  created_at: string;
}

export interface RunnerExecutionJobsTable {
  runner_job_id: string;
  attempt_id: string;
  runner_id: string;
  accepted_job_json: string;
  accepted_job_hash: string;
  created_at: string;
}

export interface MissionExecutionProvenanceTable {
  attempt_id: string;
  project_id: string;
  mission_id: string;
  mission_revision: number;
  mission_compiled_hash: string;
  mission_snapshot_json: string;
  logical_job_id: string;
  test_case_snapshot_json: string;
  test_case_snapshot_hash: string;
  plan_id: string;
  plan_version: number;
  plan_snapshot_hash: string;
  plan_snapshot_json: string;
  target_id: string;
  target_version: number;
  target_snapshot_hash: string;
  target_snapshot_json: string;
  runner_id: string;
  policy_json: string;
  policy_hash: string;
  created_at: string;
}

export interface MissionDispatchOutboxTable {
  attempt_id: string;
  mission_id: string;
  runner_id: string;
  runner_job_id: string;
  run_id: string;
  idempotency_key: string;
  required_capabilities_json: string;
  accepted_job_json: string;
  status: string;
  version: number;
  accepted_at: string | null;
  acceptance_receipt_json: string | null;
  created_at: string;
}

export interface MissionDispatchWakeupsTable {
  wakeup_id: string;
  generation: number;
  updated_at: string;
}

export interface SqliteMasterTable {
  type: string;
  name: string;
  tbl_name: string;
  rootpage: number;
  sql: string | null;
}

export interface Database {
  schema_migrations: SchemaMigrationsTable;
  execution_runs: ExecutionRunsTable;
  trace_events: TraceEventsTable;
  findings: FindingsTable;
  artifact_manifests: ArtifactManifestsTable;
  model_invocations: ModelInvocationsTable;
  prd_documents: PrdDocumentsTable;
  test_plan_revisions: TestPlanRevisionsTable;
  expected_claims: ExpectedClaimsTable;
  test_cases: TestCasesTable;
  missions: MissionsTable;
  mission_revisions: MissionRevisionsTable;
  execution_jobs: ExecutionJobsTable;
  execution_job_attempts: ExecutionJobAttemptsTable;
  recordings: RecordingsTable;
  recording_steps: RecordingStepsTable;
  skills: SkillsTable;
  skill_versions: SkillVersionsTable;
  skill_evaluations: SkillEvaluationsTable;
  skill_bundles: SkillBundlesTable;
  skill_revocations: SkillRevocationsTable;
  skill_lifecycle_commands: SkillLifecycleCommandsTable;
  skill_lifecycle_audit_events: SkillLifecycleAuditEventsTable;
  benchmark_runs: BenchmarkRunsTable;
  benchmark_attempts: BenchmarkAttemptsTable;
  exploration_checkpoints: ExplorationCheckpointsTable;
  benchmark_reports: BenchmarkReportsTable;
  exploration_attempt_progress: ExplorationAttemptProgressTable;
  exploration_live_checkpoints: ExplorationLiveCheckpointsTable;
  investigation_cases: InvestigationCasesTable;
  investigation_attempts: InvestigationAttemptsTable;
  investigation_bug_episodes: InvestigationBugEpisodesTable;
  investigation_handoffs: InvestigationHandoffsTable;
  review_tasks: ReviewTasksTable;
  review_claims: ReviewClaimsTable;
  review_resolutions: ReviewResolutionsTable;
  intelligence_jobs: IntelligenceJobsTable;
  intelligence_results: IntelligenceResultsTable;
  intelligence_applied_results: IntelligenceAppliedResultsTable;
  evidence_encryption_profiles: EvidenceEncryptionProfilesTable;
  evidence_capsule_manifests: EvidenceCapsuleManifestsTable;
  evidence_capsule_entries: EvidenceCapsuleEntriesTable;
  evidence_key_rotations: EvidenceKeyRotationsTable;
  evidence_local_only_records: EvidenceLocalOnlyRecordsTable;
  evidence_audit_events: EvidenceAuditEventsTable;
  runner_sessions: RunnerSessionsTable;
  runner_resume_tokens: RunnerResumeTokensTable;
  execution_leases: ExecutionLeasesTable;
  execution_completions: ExecutionCompletionsTable;
  local_run_intakes: LocalRunIntakesTable;
  project_targets: ProjectTargetsTable;
  target_revisions: TargetRevisionsTable;
  test_plan_heads: TestPlanHeadsTable;
  test_plan_version_revisions: TestPlanVersionRevisionsTable;
  mission_scheduling_heads: MissionSchedulingHeadsTable;
  mission_start_commands: MissionStartCommandsTable;
  mission_job_attempts: MissionJobAttemptsTable;
  runner_execution_jobs: RunnerExecutionJobsTable;
  mission_execution_provenance: MissionExecutionProvenanceTable;
  mission_dispatch_outbox: MissionDispatchOutboxTable;
  mission_dispatch_wakeups: MissionDispatchWakeupsTable;
  sqlite_master: SqliteMasterTable;
}
