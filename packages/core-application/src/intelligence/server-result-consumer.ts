import type { Transaction } from "kysely";
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

interface IntelligenceDatabase {
  intelligence_result_inbox: {
    tenant_id: string;
    idempotency_key: string;
    job_id: string;
    worker_id: string;
    lease_attempt: number;
    lease_token_hash: string;
    lease_expires_at: string;
    base_aggregate_version: number;
    result_hash: string;
    result_json: string;
    accepted_at: string;
  };
  intelligence_jobs: {
    tenant_id: string;
    job_id: string;
    base_aggregate_version: number;
    job_json: string;
  };
  intelligence_leases: {
    tenant_id: string;
    job_id: string;
    attempt: number;
    worker_id: string;
    lease_token_hash: string;
    expires_at: string;
    released_at: string | null;
    completed_at: string | null;
  };
  intelligence_applied_results: {
    tenant_id: string;
    idempotency_key: string;
    aggregate_type: string;
    aggregate_id: string;
    new_version: number;
    summary: string;
    created_at: string;
  };
  investigation_cases: {
    tenant_id: string;
    case_id: string;
    version: number;
    updated_at: string;
  };
}

interface IntelligenceTransactionProvider<Database extends IntelligenceDatabase> {
  withTenant<T>(
    tenantId: string,
    operation: (stores: { readonly db: Transaction<Database> }) => Promise<T>,
  ): Promise<T>;
}

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
export class ServerIntelligenceResultConsumer<Database extends IntelligenceDatabase> {
  constructor(private readonly provider: IntelligenceTransactionProvider<Database>) {}

  /**
   * Apply every not-yet-applied Result belonging to `tenantId`. Runs entirely
   * within one RLS-scoped transaction so it can never read or write another
   * tenant's rows.
   */
  async consumeForTenant(tenantId: string): Promise<ConsumeSummary> {
    return this.provider.withTenant(tenantId, async ({ db }) => {
      const intelligenceDb = db as Transaction<IntelligenceDatabase>;
      const pending = await intelligenceDb
        .selectFrom("intelligence_result_inbox as i")
        .innerJoin("intelligence_jobs as j", (join) =>
          join
            .onRef("j.tenant_id", "=", "i.tenant_id")
            .onRef("j.job_id", "=", "i.job_id"),
        )
        .innerJoin("intelligence_leases as l", (join) =>
          join
            .onRef("l.tenant_id", "=", "i.tenant_id")
            .onRef("l.job_id", "=", "i.job_id")
            .onRef("l.attempt", "=", "i.lease_attempt")
            .onRef("l.worker_id", "=", "i.worker_id")
            .onRef("l.lease_token_hash", "=", "i.lease_token_hash")
            .onRef("l.expires_at", "=", "i.lease_expires_at"),
        )
        .leftJoin("intelligence_applied_results as a", (join) =>
          join
            .onRef("a.tenant_id", "=", "i.tenant_id")
            .onRef("a.idempotency_key", "=", "i.idempotency_key"),
        )
        .where("i.tenant_id", "=", tenantId)
        .where("a.idempotency_key", "is", null)
        .where("l.released_at", "is", null)
        .where("l.completed_at", "is not", null)
        .whereRef("j.base_aggregate_version", "=", "i.base_aggregate_version")
        .select(["i.result_json as resultJson", "j.job_json as jobJson"])
        .orderBy("i.accepted_at", "asc")
        .execute();

      const ledger = new TransactionAppliedResultLedger(intelligenceDb, tenantId);
      const versions = new TransactionAggregateVersionReader(intelligenceDb);
      const executor = new TransactionCommandExecutor(intelligenceDb);
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
    private readonly db: Transaction<IntelligenceDatabase>,
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
  constructor(private readonly db: Transaction<IntelligenceDatabase>) {}

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
  constructor(private readonly db: Transaction<IntelligenceDatabase>) {}

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
