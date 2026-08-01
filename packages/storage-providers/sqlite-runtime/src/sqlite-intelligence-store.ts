import type {
  AppliedEffect,
  AppliedResultLedger,
  IntelligenceJob,
  IntelligenceResult,
} from "@qualigence/intelligence";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

/**
 * SQLite-backed persistence for Intelligence Jobs, their Results, and the
 * applied-result ledger that guarantees a validated Result is applied at most
 * once. {@link find}/{@link record} implement the {@link AppliedResultLedger}
 * port: recording is keyed by the result's idempotency key, so replaying the
 * same Result is a no-op de-duplicated by the primary key — a Result is never
 * double-applied.
 */
export class SqliteIntelligenceStore implements AppliedResultLedger {
  constructor(private readonly runtime: SqliteRuntime) {}

  async saveJob(job: IntelligenceJob): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .insertInto("intelligence_jobs")
        .values({
          job_id: job.jobId,
          job_type: job.jobType,
          schema_version: job.schemaVersion,
          tenant_id: job.tenantId,
          project_id: job.projectId,
          aggregate_type: job.aggregateRef.type,
          aggregate_id: job.aggregateRef.id,
          base_aggregate_version: job.baseAggregateVersion,
          model_profile_id: job.modelProfileId,
          data_policy_id: job.dataPolicyId,
          priority: job.priority,
          idempotency_key: job.idempotencyKey,
          causation_id: job.causationId,
          expected_result_schema: job.expectedResultSchema,
          job_json: JSON.stringify(job),
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.column("job_id").doNothing())
        .execute();
    });
  }

  async saveResult(result: IntelligenceResult): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .insertInto("intelligence_results")
        .values({
          idempotency_key: result.idempotencyKey,
          job_id: result.jobId,
          terminal_status: result.terminalStatus,
          confidence: result.confidence,
          result_json: JSON.stringify(result),
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.column("idempotency_key").doNothing())
        .execute();
    });
  }

  async job(jobId: string): Promise<IntelligenceJob | undefined> {
    const row = await this.runtime.db
      .selectFrom("intelligence_jobs")
      .select("job_json")
      .where("job_id", "=", jobId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : (JSON.parse(row.job_json) as IntelligenceJob);
  }

  async find(idempotencyKey: string): Promise<AppliedEffect | undefined> {
    const row = await this.runtime.db
      .selectFrom("intelligence_applied_results")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    return {
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      newVersion: row.new_version,
      summary: row.summary,
    };
  }

  async record(idempotencyKey: string, effect: AppliedEffect): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .insertInto("intelligence_applied_results")
        .values({
          idempotency_key: idempotencyKey,
          aggregate_type: effect.aggregateType,
          aggregate_id: effect.aggregateId,
          new_version: effect.newVersion,
          summary: effect.summary,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.column("idempotency_key").doNothing())
        .execute();
    });
  }
}
