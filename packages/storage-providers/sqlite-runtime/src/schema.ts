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

export interface BenchmarkReportsTable {
  report_id: string;
  run_id: string;
  profile_status: string;
  gate_status: string;
  failure_codes_json: string;
  report_json: string;
  created_at: string;
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
  benchmark_runs: BenchmarkRunsTable;
  benchmark_attempts: BenchmarkAttemptsTable;
  exploration_checkpoints: ExplorationCheckpointsTable;
  benchmark_reports: BenchmarkReportsTable;
  sqlite_master: SqliteMasterTable;
}
