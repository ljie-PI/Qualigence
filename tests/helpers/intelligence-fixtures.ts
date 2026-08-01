import pg from "pg";
import type {
  IntelligenceJob,
  IntelligenceJobType,
  IntelligenceResult,
} from "@qualigence/intelligence";
import type { PostgresConnectionConfig } from "@qualigence/postgres-runtime";

const { Client } = pg;

export interface JobPairOptions {
  readonly tenantId: string;
  readonly caseId: string;
  readonly jobId: string;
  readonly baseAggregateVersion: number;
  readonly idempotencyKey?: string;
  readonly jobType?: IntelligenceJobType;
}

/** Build a valid Intelligence Job + a matching succeeded Result for tests. */
export function buildJobPair(options: JobPairOptions): {
  readonly job: IntelligenceJob;
  readonly result: IntelligenceResult;
} {
  const idempotencyKey = options.idempotencyKey ?? `idem-${options.jobId}`;
  const job: IntelligenceJob = {
    jobId: options.jobId,
    jobType: options.jobType ?? "investigation.reproduction-planning",
    schemaVersion: "intelligence-job/v1",
    tenantId: options.tenantId,
    projectId: "project-1",
    aggregateRef: { type: "investigation", id: options.caseId },
    baseAggregateVersion: options.baseAggregateVersion,
    inputRefs: ["evidence-1"],
    modelProfileId: "profile-1",
    dataPolicyId: "policy-1",
    budget: { maximumTokens: 10_000, maximumCostMicros: 1_000_000, timeoutMs: 60_000 },
    priority: "normal",
    idempotencyKey,
    causationId: "cause-1",
    expectedResultSchema: "intelligence-result/v1",
  };
  const result: IntelligenceResult = {
    jobId: options.jobId,
    resultSchemaVersion: "intelligence-result/v1",
    proposals: [{ kind: "reproduction-plan", steps: [] }],
    evidenceRefs: ["evidence-1"],
    confidence: 0.9,
    provenance: ["model:test"],
    usage: { inputTokens: 100, outputTokens: 50, costMicros: 1000 },
    terminalStatus: "succeeded",
    idempotencyKey,
  };
  return { job, result };
}

/** Insert an Intelligence Job as the owner role (RLS-bypassing), for tests. */
export async function seedJob(admin: PostgresConnectionConfig, job: IntelligenceJob): Promise<void> {
  const client = new Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into intelligence_jobs
        (tenant_id, job_id, job_type, schema_version, project_id, aggregate_type, aggregate_id,
         base_aggregate_version, model_profile_id, data_policy_id, priority, idempotency_key,
         causation_id, expected_result_schema, job_json, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        job.tenantId,
        job.jobId,
        job.jobType,
        job.schemaVersion,
        job.projectId,
        job.aggregateRef.type,
        job.aggregateRef.id,
        job.baseAggregateVersion,
        job.modelProfileId,
        job.dataPolicyId,
        job.priority,
        job.idempotencyKey,
        job.causationId,
        job.expectedResultSchema,
        JSON.stringify(job),
        new Date().toISOString(),
      ],
    );
  } finally {
    await client.end();
  }
}

/** Insert a minimal investigation_cases row as the owner role, for tests. */
export async function seedInvestigationCase(
  admin: PostgresConnectionConfig,
  input: { readonly tenantId: string; readonly caseId: string; readonly version: number },
): Promise<void> {
  const client = new Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into investigation_cases
        (tenant_id, case_id, finding_id, project_id, status, version, plan_revision,
         budget_json, usage_json, bug_episode_id, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.tenantId,
        input.caseId,
        `finding-${input.caseId}`,
        "project-1",
        "investigating",
        input.version,
        1,
        "{}",
        "{}",
        null,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
  } finally {
    await client.end();
  }
}

/** Read an investigation case version as the owner role, for assertions. */
export async function readCaseVersion(
  admin: PostgresConnectionConfig,
  caseId: string,
): Promise<number | undefined> {
  const client = new Client(admin);
  await client.connect();
  try {
    const result = await client.query(`select version from investigation_cases where case_id = $1`, [
      caseId,
    ]);
    return (result.rows[0] as { version: number } | undefined)?.version;
  } finally {
    await client.end();
  }
}
