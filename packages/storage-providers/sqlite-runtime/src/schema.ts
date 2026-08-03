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
  sqlite_master: SqliteMasterTable;
}
