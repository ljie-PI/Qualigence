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
  type IntelligencePolicyGate,
  type IntelligenceResult,
} from "@qualigence/intelligence";
import {
  InvestigationCase,
  InvestigationError,
  ReproductionPlanError,
  bugEpisodeDraftFromResult,
  reproductionPlanFromResult,
  type BugEpisode,
  type HumanHandoff,
  type InvestigationBudget,
  type InvestigationBudgetUsage,
  type InvestigationStatus,
  type InvestigationTransition,
  type ReproductionAttempt,
} from "@qualigence/investigation";

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
  intelligence_result_dispositions: {
    tenant_id: string;
    idempotency_key: string;
    job_id: string;
    result_hash: string;
    status: ApplyResult["status"];
    code: string | null;
    reason: string | null;
    aggregate_type: string | null;
    aggregate_id: string | null;
    new_version: number | null;
    summary: string | null;
    created_at: string;
  };
  investigation_cases: {
    tenant_id: string;
    case_id: string;
    finding_id: string;
    project_id: string;
    status: string;
    version: number;
    plan_revision: number;
    budget_json: string;
    usage_json: string;
    bug_episode_id: string | null;
    updated_at: string;
  };
  investigation_attempts: {
    tenant_id: string;
    attempt_id: string;
    case_id: string;
    ordinal: number;
    plan_revision: number;
    outcome: string;
    attempt_json: string;
    created_at: string;
  };
  investigation_bug_episodes: {
    tenant_id: string;
    episode_id: string;
    case_id: string;
    finding_id: string;
    confidence: number;
    episode_json: string;
    created_at: string;
  };
  investigation_handoffs: {
    tenant_id: string;
    case_id: string;
    handoff_json: string;
    created_at: string;
  };
}

interface IntelligenceTransactionProvider {
  withTenant<T>(
    tenantId: string,
    operation: (stores: { readonly db: Transaction<any> }) => Promise<T>,
  ): Promise<T>;
}

export interface ConsumeSummary {
  readonly applied: number;
  readonly duplicate: number;
  readonly recompute: number;
  readonly rejected: number;
  readonly processed: number;
  readonly hasMore: boolean;
  readonly dispositions: readonly ApplyResult["status"][];
}

export interface ConsumeForTenantOptions {
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
}

export interface ServerIntelligenceResultConsumerOptions {
  readonly policy?: IntelligencePolicyGate;
}

const DEFAULT_RESULT_BATCH_SIZE = 32;
const MAX_RESULT_BATCH_SIZE = 256;

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
  private readonly policy: IntelligencePolicyGate;

  constructor(
    private readonly provider: IntelligenceTransactionProvider,
    options: ServerIntelligenceResultConsumerOptions = {},
  ) {
    this.policy = options.policy ?? new ProductionIntelligencePolicyGate();
  }

  /**
   * Apply a bounded batch of not-yet-dispositioned Results belonging to
   * `tenantId`. Runs entirely within one RLS-scoped transaction so it can never
   * read or write another tenant's rows, and records every applied, duplicate,
   * rejected, or recompute outcome in the same transaction as any aggregate
   * effect.
   */
  async consumeForTenant(
    tenantId: string,
    options: ConsumeForTenantOptions = {},
  ): Promise<ConsumeSummary> {
    throwIfAborted(options.signal);
    const batchSize = boundedPositive(options.batchSize ?? DEFAULT_RESULT_BATCH_SIZE, "batchSize", MAX_RESULT_BATCH_SIZE);
    return this.provider.withTenant(tenantId, async ({ db }) => {
      const intelligenceDb = db as Transaction<IntelligenceDatabase>;
      const pending = await pendingResultQuery(intelligenceDb, tenantId)
        .select([
          "i.idempotency_key as idempotencyKey",
          "i.job_id as jobId",
          "i.result_hash as resultHash",
          "i.result_json as resultJson",
          "j.job_json as jobJson",
        ])
        .orderBy("i.accepted_at", "asc")
        .limit(batchSize)
        .execute();

      const ledger = new TransactionAppliedResultLedger(intelligenceDb, tenantId);
      const versions = new TransactionAggregateVersionReader(intelligenceDb, tenantId);
      const executor = new TransactionCommandExecutor(intelligenceDb, tenantId);
      const dispositionRecorder = new TransactionResultDispositionRecorder(intelligenceDb, tenantId);
      const applier = new IntelligenceResultApplier({ ledger, versions, executor, policy: this.policy });

      const dispositions: ApplyResult["status"][] = [];
      const counts = { applied: 0, duplicate: 0, recompute: 0, rejected: 0 };
      for (const row of pending) {
        throwIfAborted(options.signal);
        const job = JSON.parse(row.jobJson) as IntelligenceJob;
        const result = JSON.parse(row.resultJson) as IntelligenceResult;
        const outcome = await applyOrRejectDeterministically(applier, job, result, options.signal);
        await dispositionRecorder.record({
          idempotencyKey: row.idempotencyKey,
          jobId: row.jobId,
          resultHash: row.resultHash,
          outcome,
        });
        dispositions.push(outcome.status);
        counts[outcome.status] += 1;
      }

      const remaining = await pendingResultQuery(intelligenceDb, tenantId)
        .select("i.idempotency_key")
        .limit(1)
        .executeTakeFirst();
      return {
        ...counts,
        processed: dispositions.length,
        hasMore: remaining !== undefined,
        dispositions,
      };
    });
  }
}

function pendingResultQuery(db: Transaction<IntelligenceDatabase>, tenantId: string) {
  return db
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
    .leftJoin("intelligence_result_dispositions as d", (join) =>
      join
        .onRef("d.tenant_id", "=", "i.tenant_id")
        .onRef("d.idempotency_key", "=", "i.idempotency_key"),
    )
    .where("i.tenant_id", "=", tenantId)
    .where("d.idempotency_key", "is", null)
    .where("l.released_at", "is", null)
    .where("l.completed_at", "is not", null)
    .whereRef("j.base_aggregate_version", "=", "i.base_aggregate_version");
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
      .where("tenant_id", "=", this.tenantId)
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

interface DispositionInput {
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly resultHash: string;
  readonly outcome: ApplyResult;
}

class TransactionResultDispositionRecorder {
  constructor(
    private readonly db: Transaction<IntelligenceDatabase>,
    private readonly tenantId: string,
  ) {}

  async record(input: DispositionInput): Promise<void> {
    const fields = dispositionFields(input.outcome);
    const recordedAt = new Date().toISOString();
    const values = {
      tenant_id: this.tenantId,
      idempotency_key: input.idempotencyKey,
      job_id: input.jobId,
      result_hash: input.resultHash,
      status: input.outcome.status,
      code: fields.code,
      reason: fields.reason,
      aggregate_type: fields.effect?.aggregateType ?? null,
      aggregate_id: fields.effect?.aggregateId ?? null,
      new_version: fields.effect?.newVersion ?? null,
      summary: fields.effect?.summary ?? null,
      created_at: recordedAt,
    };
    await this.db
      .insertInto("intelligence_result_dispositions")
      .values(values)
      .onConflict((oc) => oc.columns(["tenant_id", "idempotency_key"]).doUpdateSet({
        status: values.status,
        code: values.code,
        reason: values.reason,
        aggregate_type: values.aggregate_type,
        aggregate_id: values.aggregate_id,
        new_version: values.new_version,
        summary: values.summary,
        created_at: values.created_at,
      }))
      .execute();
  }
}

async function applyOrRejectDeterministically(
  applier: IntelligenceResultApplier,
  job: IntelligenceJob,
  result: IntelligenceResult,
  signal: AbortSignal | undefined,
): Promise<ApplyResult> {
  try {
    throwIfAborted(signal);
    return await applier.apply(job, result, { signal });
  } catch (error) {
    if (error instanceof ReproductionPlanError || error instanceof InvestigationError) {
      return {
        status: "rejected",
        code: "SchemaInvalid",
        reason: error.message,
      };
    }
    throw error;
  }
}

function dispositionFields(outcome: ApplyResult): {
  readonly code: string | null;
  readonly reason: string | null;
  readonly effect?: AppliedEffect;
} {
  switch (outcome.status) {
    case "applied":
    case "duplicate":
      return { code: null, reason: null, effect: outcome.effect };
    case "recompute":
      return { code: null, reason: outcome.reason };
    case "rejected":
      return { code: outcome.code, reason: outcome.reason };
  }
}

class TransactionAggregateVersionReader implements AggregateVersionReader {
  constructor(
    private readonly db: Transaction<IntelligenceDatabase>,
    private readonly tenantId: string,
  ) {}

  async currentVersion(ref: IntelligenceAggregateRef): Promise<number | undefined> {
    const mapping = AGGREGATE_TABLES[ref.type];
    if (mapping === undefined) {
      return undefined;
    }
    const row = await this.db
      .selectFrom(mapping.table)
      .select("version")
      .where("tenant_id", "=", this.tenantId)
      .where(mapping.idColumn, "=", ref.id)
      .executeTakeFirst();
    return row?.version;
  }
}

class TransactionCommandExecutor implements IntelligenceCommandExecutor {
  constructor(
    private readonly db: Transaction<IntelligenceDatabase>,
    private readonly tenantId: string,
  ) {}

  async execute(job: IntelligenceJob, result: IntelligenceResult): Promise<AppliedEffect> {
    if (job.aggregateRef.type !== "investigation") {
      throw new Error(`No aggregate application handler for type ${job.aggregateRef.type}`);
    }
    const investigation = await this.loadInvestigation(job.aggregateRef.id);
    if (job.jobType === "investigation.reproduction-planning") {
      // Validate the model proposal through the existing deterministic parser;
      // only the aggregate transition below is persisted in this ticket.
      const nextPlanRevision = investigation.planRevision() + 1;
      reproductionPlanFromResult(investigation.caseId, nextPlanRevision, result);
      const transition = investigation.startReproduction({
        expectedVersion: job.baseAggregateVersion,
        idempotencyKey: result.idempotencyKey,
      });
      await this.persistInvestigationTransition(transition);
      return this.effect(investigation, transition);
    }

    if (job.jobType === "investigation.bug-analysis") {
      const draft = bugEpisodeDraftFromResult(
        withoutModelAuthoredDomainIds(result),
        deterministicBugEpisodeId(investigation.caseId, result.idempotencyKey),
      );
      let transition: InvestigationTransition;
      try {
        transition = investigation.confirm({
          expectedVersion: job.baseAggregateVersion,
          idempotencyKey: result.idempotencyKey,
          episode: draft,
        });
      } catch (error) {
        if (
          error instanceof InvestigationError &&
          (error.code === "InvestigationConfirmationRejected" ||
            error.code === "InvestigationAttemptUnknown")
        ) {
          transition = investigation.escalateToHuman({
            expectedVersion: investigation.currentVersion(),
            idempotencyKey: `${result.idempotencyKey}:escalate`,
            handoff: {
              bestHypothesis: "Bug analysis did not meet the deterministic confirmation rule.",
              keyEvidenceRefs: [...result.evidenceRefs],
              suggestedActions: ["Assign a human reviewer to confirm or refute."],
              limitationCodes: ["confirmation_rejected"],
            },
          });
        } else {
          throw error;
        }
      }
      await this.persistInvestigationTransition(transition);
      return this.effect(investigation, transition);
    }

    throw new Error(`Unsupported investigation job type ${job.jobType}.`);
  }

  private async loadInvestigation(caseId: string): Promise<InvestigationCase> {
    const row = await this.db
      .selectFrom("investigation_cases")
      .select([
        "case_id",
        "finding_id",
        "project_id",
        "status",
        "version",
        "plan_revision",
        "budget_json",
        "usage_json",
        "bug_episode_id",
      ])
      .where("tenant_id", "=", this.tenantId)
      .where("case_id", "=", caseId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new Error(`Investigation case ${caseId} does not exist.`);
    }

    const attempts = await this.db
      .selectFrom("investigation_attempts")
      .select("attempt_json")
      .where("tenant_id", "=", this.tenantId)
      .where("case_id", "=", caseId)
      .orderBy("ordinal", "asc")
      .execute();
    const bugEpisode = row.bug_episode_id === null
      ? undefined
      : await this.loadBugEpisode(row.bug_episode_id, row.case_id, row.finding_id);
    const handoff = await this.loadHandoff(caseId);
    return InvestigationCase.restore({
      caseId: row.case_id,
      findingId: row.finding_id,
      projectId: row.project_id,
      budget: JSON.parse(row.budget_json) as InvestigationBudget,
      usage: JSON.parse(row.usage_json) as InvestigationBudgetUsage,
      version: row.version,
      status: row.status as InvestigationStatus,
      planRevision: row.plan_revision,
      attempts: attempts.map((attempt) => JSON.parse(attempt.attempt_json) as ReproductionAttempt),
      ...(bugEpisode === undefined ? {} : { bugEpisode }),
      ...(handoff === undefined ? {} : { handoff }),
    });
  }

  private async loadBugEpisode(
    episodeId: string,
    expectedCaseId: string,
    expectedFindingId: string,
  ): Promise<BugEpisode | undefined> {
    const row = await this.db
      .selectFrom("investigation_bug_episodes")
      .select(["case_id", "finding_id", "episode_json"])
      .where("tenant_id", "=", this.tenantId)
      .where("episode_id", "=", episodeId)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const episode = JSON.parse(row.episode_json) as BugEpisode;
    if (
      row.case_id !== expectedCaseId ||
      row.finding_id !== expectedFindingId ||
      episode.caseId !== expectedCaseId ||
      episode.findingId !== expectedFindingId ||
      episode.episodeId !== episodeId
    ) {
      throw new Error(`BugEpisode ${episodeId} does not belong to investigation case ${expectedCaseId}.`);
    }
    return episode;
  }

  private async loadHandoff(caseId: string): Promise<HumanHandoff | undefined> {
    const row = await this.db
      .selectFrom("investigation_handoffs")
      .select("handoff_json")
      .where("tenant_id", "=", this.tenantId)
      .where("case_id", "=", caseId)
      .executeTakeFirst();
    return row === undefined ? undefined : JSON.parse(row.handoff_json) as HumanHandoff;
  }

  private async persistInvestigationTransition(transition: InvestigationTransition): Promise<void> {
    const now = new Date().toISOString();
    const previousVersion = transition.version - 1;
    const updated = await this.db
      .updateTable("investigation_cases")
      .set({
        status: transition.toStatus,
        version: transition.version,
        plan_revision: transition.planRevision,
        usage_json: JSON.stringify(transition.usage),
        bug_episode_id: transition.bugEpisode?.episodeId ?? null,
        updated_at: now,
      })
      .where("tenant_id", "=", this.tenantId)
      .where("case_id", "=", transition.caseId)
      .where("version", "=", previousVersion)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      throw new Error(
        `Investigation case ${transition.caseId} was not at base version ${previousVersion}`,
      );
    }

    if (transition.appendedAttempt !== undefined) {
      await this.db
        .insertInto("investigation_attempts")
        .values({
          tenant_id: this.tenantId,
          attempt_id: transition.appendedAttempt.attemptId,
          case_id: transition.caseId,
          ordinal: transition.appendedAttempt.ordinal,
          plan_revision: transition.appendedAttempt.planRevision,
          outcome: transition.appendedAttempt.outcome,
          attempt_json: JSON.stringify(transition.appendedAttempt),
          created_at: now,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "attempt_id"]).doNothing())
        .execute();
    }
    if (transition.bugEpisode !== undefined) {
      const inserted = await this.db
        .insertInto("investigation_bug_episodes")
        .values({
          tenant_id: this.tenantId,
          episode_id: transition.bugEpisode.episodeId,
          case_id: transition.caseId,
          finding_id: transition.bugEpisode.findingId,
          confidence: transition.bugEpisode.confidence,
          episode_json: JSON.stringify(transition.bugEpisode),
          created_at: now,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "episode_id"]).doNothing())
        .returning("episode_id")
        .executeTakeFirst();
      if (inserted === undefined) {
        await this.assertExistingBugEpisodeMatches(transition.bugEpisode);
      }
    }
    if (transition.handoff !== undefined) {
      await this.db
        .insertInto("investigation_handoffs")
        .values({
          tenant_id: this.tenantId,
          case_id: transition.caseId,
          handoff_json: JSON.stringify(transition.handoff),
          created_at: now,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "case_id"]).doUpdateSet({
          handoff_json: JSON.stringify(transition.handoff),
          created_at: now,
        }))
        .execute();
    }
  }

  private async assertExistingBugEpisodeMatches(episode: BugEpisode): Promise<void> {
    const row = await this.db
      .selectFrom("investigation_bug_episodes")
      .select(["case_id", "finding_id", "episode_json"])
      .where("tenant_id", "=", this.tenantId)
      .where("episode_id", "=", episode.episodeId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new Error(`BugEpisode ${episode.episodeId} insert conflicted but no existing episode could be read.`);
    }
    const existing = JSON.parse(row.episode_json) as BugEpisode;
    if (
      row.case_id !== episode.caseId ||
      row.finding_id !== episode.findingId ||
      JSON.stringify(existing) !== JSON.stringify(episode)
    ) {
      throw new Error(`BugEpisode ${episode.episodeId} collides with a different persisted episode.`);
    }
  }

  private effect(investigation: InvestigationCase, transition: InvestigationTransition): AppliedEffect {
    return {
      aggregateType: "investigation",
      aggregateId: investigation.caseId,
      newVersion: transition.version,
      summary: transition.toStatus,
    };
  }
}

class ProductionIntelligencePolicyGate implements IntelligencePolicyGate {
  allows(job: IntelligenceJob, result: IntelligenceResult): boolean {
    if (job.dataPolicyId.trim().length === 0) {
      return false;
    }
    return result.proposals.every((proposal) => !containsForbiddenPolicyAuthority(proposal));
  }
}

const FORBIDDEN_POLICY_AUTHORITY_KEYS = new Set([
  "budget",
  "dataPolicyId",
  "maximumCostMicros",
  "maximumTokens",
  "policy",
  "policyId",
]);

function containsForbiddenPolicyAuthority(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenPolicyAuthority);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_POLICY_AUTHORITY_KEYS.has(key) || containsForbiddenPolicyAuthority(nested)) {
      return true;
    }
  }
  return false;
}

function deterministicBugEpisodeId(caseId: string, idempotencyKey: string): string {
  return `${caseId}:episode:${idempotencyKey}`;
}

function withoutModelAuthoredDomainIds(result: IntelligenceResult): IntelligenceResult {
  const [first, ...rest] = result.proposals;
  if (first === undefined || !("episodeId" in first)) {
    return result;
  }
  const { episodeId: _ignored, ...sanitized } = first;
  return { ...result, proposals: [sanitized, ...rest] };
}

export class IntelligenceResultConsumerAbortError extends Error {
  constructor() {
    super("Intelligence Result consumption was aborted before aggregate dispatch.");
    this.name = "IntelligenceResultConsumerAbortError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new IntelligenceResultConsumerAbortError();
  }
}

function boundedPositive(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}
