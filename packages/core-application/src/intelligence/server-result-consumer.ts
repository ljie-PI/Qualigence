import type { Transaction } from "kysely";
import type { PostgresDatabase, TenantTransactionProvider } from "@qualigence/postgres-runtime";
import {
  IntelligenceResultApplier,
  type AggregateVersionReader,
  type AppliedEffect,
  type AppliedResultLedger,
  type ApplyResult,
  type IntelligenceAggregateRef,
  type IntelligenceCommandExecutor,
  type IntelligenceJob,
  type IntelligenceResult,
} from "@qualigence/intelligence";

/**
 * Maps an Intelligence aggregate type to the tenant-owned table that stores its
 * optimistic-concurrency version. Extend this as new aggregate types gain
 * server-applied Intelligence Results.
 */
const AGGREGATE_TABLES: Readonly<
  Record<string, { readonly table: "investigation_cases"; readonly idColumn: "case_id" }>
> = {
  investigation: { table: "investigation_cases", idColumn: "case_id" },
};

export interface ConsumeSummary {
  readonly applied: number;
  readonly duplicate: number;
  readonly recompute: number;
  readonly rejected: number;
  readonly dispositions: readonly ApplyResult["status"][];
}

/**
 * The Server-only consumer of the Intelligence Result Inbox. It is the SINGLE
 * source of truth for how a model-produced Result mutates an aggregate: it runs
 * inside the correct tenant's RLS-scoped transaction and drives LS-10's
 * deterministic {@link IntelligenceResultApplier}, which validates the envelope,
 * deduplicates by idempotency key, rejects stale/over-budget/policy-violating
 * results and only then bumps the aggregate version. The Worker never imports
 * this class or the applier — it can only append Results to the inbox.
 */
export class ServerIntelligenceResultConsumer {
  constructor(private readonly provider: TenantTransactionProvider) {}

  /**
   * Apply every not-yet-applied Result belonging to `tenantId`. Runs entirely
   * within one RLS-scoped transaction so it can never read or write another
   * tenant's rows.
   */
  async consumeForTenant(tenantId: string): Promise<ConsumeSummary> {
    return this.provider.withTenant(tenantId, async ({ db }) => {
      const pending = await db
        .selectFrom("intelligence_results as r")
        .innerJoin("intelligence_jobs as j", "j.job_id", "r.job_id")
        .leftJoin(
          "intelligence_applied_results as a",
          "a.idempotency_key",
          "r.idempotency_key",
        )
        .where("a.idempotency_key", "is", null)
        .select(["r.result_json as resultJson", "j.job_json as jobJson"])
        .orderBy("r.created_at", "asc")
        .execute();

      const ledger = new TransactionAppliedResultLedger(db, tenantId);
      const versions = new TransactionAggregateVersionReader(db);
      const executor = new TransactionCommandExecutor(db);
      const applier = new IntelligenceResultApplier({ ledger, versions, executor });

      const dispositions: ApplyResult["status"][] = [];
      const counts = { applied: 0, duplicate: 0, recompute: 0, rejected: 0 };
      for (const row of pending) {
        const job = JSON.parse(row.jobJson) as IntelligenceJob;
        const result = JSON.parse(row.resultJson) as IntelligenceResult;
        const outcome = await applier.apply(job, result);
        dispositions.push(outcome.status);
        counts[outcome.status] += 1;
      }
      return { ...counts, dispositions };
    });
  }
}

class TransactionAppliedResultLedger implements AppliedResultLedger {
  constructor(
    private readonly db: Transaction<PostgresDatabase>,
    private readonly tenantId: string,
  ) {}

  async find(idempotencyKey: string): Promise<AppliedEffect | undefined> {
    const row = await this.db
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
    await this.db
      .insertInto("intelligence_applied_results")
      .values({
        tenant_id: this.tenantId,
        idempotency_key: idempotencyKey,
        aggregate_type: effect.aggregateType,
        aggregate_id: effect.aggregateId,
        new_version: effect.newVersion,
        summary: effect.summary,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.columns(["tenant_id", "idempotency_key"]).doNothing())
      .execute();
  }
}

class TransactionAggregateVersionReader implements AggregateVersionReader {
  constructor(private readonly db: Transaction<PostgresDatabase>) {}

  async currentVersion(ref: IntelligenceAggregateRef): Promise<number | undefined> {
    const mapping = AGGREGATE_TABLES[ref.type];
    if (mapping === undefined) {
      return undefined;
    }
    const row = await this.db
      .selectFrom(mapping.table)
      .select("version")
      .where(mapping.idColumn, "=", ref.id)
      .executeTakeFirst();
    return row?.version;
  }
}

class TransactionCommandExecutor implements IntelligenceCommandExecutor {
  constructor(private readonly db: Transaction<PostgresDatabase>) {}

  async execute(job: IntelligenceJob, result: IntelligenceResult): Promise<AppliedEffect> {
    const mapping = AGGREGATE_TABLES[job.aggregateRef.type];
    if (mapping === undefined) {
      throw new Error(`No aggregate table mapping for type ${job.aggregateRef.type}`);
    }
    const newVersion = job.baseAggregateVersion + 1;
    const updated = await this.db
      .updateTable(mapping.table)
      .set({ version: newVersion, updated_at: new Date().toISOString() })
      .where(mapping.idColumn, "=", job.aggregateRef.id)
      .where("version", "=", job.baseAggregateVersion)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      throw new Error(
        `Aggregate ${job.aggregateRef.type}/${job.aggregateRef.id} was not at base version ${job.baseAggregateVersion}`,
      );
    }
    return {
      aggregateType: job.aggregateRef.type,
      aggregateId: job.aggregateRef.id,
      newVersion,
      summary: `Applied ${job.jobType} result with confidence ${result.confidence}`,
    };
  }
}
