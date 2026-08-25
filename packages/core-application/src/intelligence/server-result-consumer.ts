import { createHash } from "node:crypto";
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
    job_type: string;
    schema_version: string;
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
    follow_up_job_id: string | null;
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
        const decoded = decodePendingPayload(row);
        const outcome = decoded.ok
          ? await applyOrRejectDeterministically(applier, decoded.job, decoded.result, options.signal)
          : decoded.outcome;
        const recorded = await dispositionRecorder.record({
          idempotencyKey: row.idempotencyKey,
          jobId: row.jobId,
          resultHash: row.resultHash,
          outcome,
          followUpJobId: null,
        });
        if (decoded.ok && outcome.status === "recompute" && recorded.inserted && recorded.status === "recompute") {
          const followUpJobId = await createRecomputeFollowUp(
            intelligenceDb,
            tenantId,
            decoded.job,
            decoded.result,
            options.signal,
          );
          if (followUpJobId !== null) {
            await dispositionRecorder.attachFollowUpJob({
              idempotencyKey: row.idempotencyKey,
              jobId: row.jobId,
              resultHash: row.resultHash,
              followUpJobId,
            });
          }
        }
        dispositions.push(recorded.status);
        counts[recorded.status] += 1;
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

type PendingPayloadRow = {
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly resultHash: string;
  readonly jobJson: string;
  readonly resultJson: string;
};

type PendingPayloadDecode =
  | { readonly ok: true; readonly job: IntelligenceJob; readonly result: IntelligenceResult }
  | { readonly ok: false; readonly outcome: Extract<ApplyResult, { readonly status: "rejected" }> };

function decodePendingPayload(row: PendingPayloadRow): PendingPayloadDecode {
  const parsedJob = parseJsonObject(row.jobJson, "job_json");
  if (!parsedJob.ok) {
    return malformedPendingPayload(parsedJob.reason);
  }
  const job = validateIntelligenceJobShape(parsedJob.value);
  if (!job.ok) {
    return malformedPendingPayload(`job_json ${job.reason}`);
  }

  const parsedResult = parseJsonObject(row.resultJson, "result_json");
  if (!parsedResult.ok) {
    return malformedPendingPayload(parsedResult.reason);
  }
  const result = validateIntelligenceResultShape(parsedResult.value);
  if (!result.ok) {
    return malformedPendingPayload(`result_json ${result.reason}`);
  }

  return { ok: true, job: job.value, result: result.value };
}

function malformedPendingPayload(reason: string): PendingPayloadDecode {
  return {
    ok: false,
    outcome: {
      status: "rejected",
      code: "SchemaInvalid",
      reason,
    },
  };
}

type ShapeValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function parseJsonObject(value: string, label: string): ShapeValidation<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return { ok: false, reason: `${label} must be a JSON object.` };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: `${label} is not valid JSON.` };
  }
}

const INTELLIGENCE_JOB_TYPES = new Set([
  "prd.planning",
  "skill.induction",
  "skill.evaluation",
  "investigation.reproduction-planning",
  "investigation.bug-analysis",
]);

const INTELLIGENCE_PRIORITIES = new Set(["low", "normal", "high"]);
const INTELLIGENCE_TERMINAL_STATUSES = new Set(["succeeded", "blocked", "failed"]);

function validateIntelligenceJobShape(value: Record<string, unknown>): ShapeValidation<IntelligenceJob> {
  const aggregateRef = value.aggregateRef;
  const budget = value.budget;
  if (!isNonEmptyString(value.jobId)) {
    return { ok: false, reason: "must include a string jobId." };
  }
  if (!isString(value.jobType) || !INTELLIGENCE_JOB_TYPES.has(value.jobType)) {
    return { ok: false, reason: "must include a supported jobType." };
  }
  if (value.schemaVersion !== "intelligence-job/v1") {
    return { ok: false, reason: "must use schemaVersion intelligence-job/v1." };
  }
  if (!isNonEmptyString(value.tenantId) || !isNonEmptyString(value.projectId)) {
    return { ok: false, reason: "must include tenantId and projectId strings." };
  }
  if (!isRecord(aggregateRef) || !isNonEmptyString(aggregateRef.type) || !isNonEmptyString(aggregateRef.id)) {
    return { ok: false, reason: "must include aggregateRef type and id strings." };
  }
  if (!isSafeNonNegativeInteger(value.baseAggregateVersion)) {
    return { ok: false, reason: "must include a non-negative safe integer baseAggregateVersion." };
  }
  if (!isStringArray(value.inputRefs)) {
    return { ok: false, reason: "must include an inputRefs string array." };
  }
  if (
    !isNonEmptyString(value.modelProfileId) ||
    !isString(value.dataPolicyId) ||
    !isNonEmptyString(value.idempotencyKey) ||
    !isString(value.causationId) ||
    !isNonEmptyString(value.expectedResultSchema)
  ) {
    return { ok: false, reason: "must include model, policy, idempotency, causation, and result-schema strings." };
  }
  if (!isRecord(budget) ||
    !isFiniteNonNegativeNumber(budget.maximumTokens) ||
    !isFiniteNonNegativeNumber(budget.maximumCostMicros) ||
    !isFiniteNonNegativeNumber(budget.timeoutMs)
  ) {
    return { ok: false, reason: "must include non-negative finite budget numbers." };
  }
  if (!isString(value.priority) || !INTELLIGENCE_PRIORITIES.has(value.priority)) {
    return { ok: false, reason: "must include a supported priority." };
  }
  return { ok: true, value: value as unknown as IntelligenceJob };
}

function validateIntelligenceResultShape(value: Record<string, unknown>): ShapeValidation<IntelligenceResult> {
  const usage = value.usage;
  if (!isNonEmptyString(value.jobId)) {
    return { ok: false, reason: "must include a string jobId." };
  }
  if (!isString(value.resultSchemaVersion)) {
    return { ok: false, reason: "must include a string resultSchemaVersion." };
  }
  if (!Array.isArray(value.proposals) || !value.proposals.every(isRecord)) {
    return { ok: false, reason: "must include a proposals object array." };
  }
  if (!isStringArray(value.evidenceRefs) || !isStringArray(value.provenance)) {
    return { ok: false, reason: "must include evidenceRefs and provenance string arrays." };
  }
  if (!isFiniteNonNegativeNumber(value.confidence)) {
    return { ok: false, reason: "must include a non-negative finite confidence." };
  }
  if (!isRecord(usage) ||
    !isFiniteNonNegativeNumber(usage.inputTokens) ||
    !isFiniteNonNegativeNumber(usage.outputTokens) ||
    !isFiniteNonNegativeNumber(usage.costMicros)
  ) {
    return { ok: false, reason: "must include non-negative finite usage numbers." };
  }
  if (!isString(value.terminalStatus) || !INTELLIGENCE_TERMINAL_STATUSES.has(value.terminalStatus)) {
    return { ok: false, reason: "must include a supported terminalStatus." };
  }
  if (!isNonEmptyString(value.idempotencyKey)) {
    return { ok: false, reason: "must include a string idempotencyKey." };
  }
  return { ok: true, value: value as unknown as IntelligenceResult };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
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
  readonly followUpJobId: string | null;
}

interface AttachFollowUpInput {
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly resultHash: string;
  readonly followUpJobId: string;
}

interface RecordedDisposition {
  readonly inserted: boolean;
  readonly status: ApplyResult["status"];
}

class TransactionResultDispositionRecorder {
  constructor(
    private readonly db: Transaction<IntelligenceDatabase>,
    private readonly tenantId: string,
  ) {}

  async record(input: DispositionInput): Promise<RecordedDisposition> {
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
      follow_up_job_id: input.followUpJobId,
      created_at: recordedAt,
    };
    const inserted = await this.db
      .insertInto("intelligence_result_dispositions")
      .values(values)
      .onConflict((oc) => oc.columns(["tenant_id", "idempotency_key"]).doNothing())
      .returning("status")
      .executeTakeFirst();
    if (inserted !== undefined) {
      return { inserted: true, status: asApplyStatus(inserted.status) };
    }
    return { inserted: false, status: await this.readExistingStatus(input.idempotencyKey) };
  }

  async attachFollowUpJob(input: AttachFollowUpInput): Promise<void> {
    await this.db
      .updateTable("intelligence_result_dispositions")
      .set({ follow_up_job_id: input.followUpJobId })
      .where("tenant_id", "=", this.tenantId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .where("job_id", "=", input.jobId)
      .where("result_hash", "=", input.resultHash)
      .where("status", "=", "recompute")
      .where("follow_up_job_id", "is", null)
      .execute();
  }

  private async readExistingStatus(idempotencyKey: string): Promise<ApplyResult["status"]> {
    const existing = await this.db
      .selectFrom("intelligence_result_dispositions")
      .select("status")
      .where("tenant_id", "=", this.tenantId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (existing === undefined) {
      throw new Error(`Disposition for ${idempotencyKey} conflicted but could not be read.`);
    }
    return asApplyStatus(existing.status);
  }
}

async function createRecomputeFollowUp(
  db: Transaction<IntelligenceDatabase>,
  tenantId: string,
  originalJob: IntelligenceJob,
  staleResult: IntelligenceResult,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const currentVersion = await new TransactionAggregateVersionReader(db, tenantId).currentVersion(originalJob.aggregateRef);
  throwIfAborted(signal);
  if (currentVersion === undefined) {
    return null;
  }

  const followUp = recomputeFollowUpJob(tenantId, originalJob, staleResult, currentVersion);
  const createdAt = new Date().toISOString();
  await db
    .insertInto("intelligence_jobs")
    .values({
      tenant_id: tenantId,
      job_id: followUp.jobId,
      job_type: followUp.jobType,
      schema_version: followUp.schemaVersion,
      project_id: followUp.projectId,
      aggregate_type: followUp.aggregateRef.type,
      aggregate_id: followUp.aggregateRef.id,
      base_aggregate_version: followUp.baseAggregateVersion,
      model_profile_id: followUp.modelProfileId,
      data_policy_id: followUp.dataPolicyId,
      priority: followUp.priority,
      idempotency_key: followUp.idempotencyKey,
      causation_id: followUp.causationId,
      expected_result_schema: followUp.expectedResultSchema,
      job_json: JSON.stringify(followUp),
      created_at: createdAt,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "job_id"]).doNothing())
    .execute();
  return followUp.jobId;
}

function recomputeFollowUpJob(
  tenantId: string,
  originalJob: IntelligenceJob,
  staleResult: IntelligenceResult,
  baseAggregateVersion: number,
): IntelligenceJob {
  const seed = [
    tenantId,
    originalJob.jobId,
    staleResult.idempotencyKey,
    originalJob.aggregateRef.type,
    originalJob.aggregateRef.id,
    String(baseAggregateVersion),
  ].join("\u0000");
  const digest = createHash("sha256").update(seed).digest("hex");
  return {
    ...originalJob,
    tenantId,
    jobId: `recompute-job-${digest}`,
    baseAggregateVersion,
    idempotencyKey: `recompute-idem-${digest}`,
    causationId: staleResult.idempotencyKey,
  };
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

function asApplyStatus(status: string): ApplyResult["status"] {
  if (status === "applied" || status === "duplicate" || status === "recompute" || status === "rejected") {
    return status;
  }
  throw new Error(`Unknown Intelligence Result disposition status ${status}.`);
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
