import type {
  AggregateVersionReader,
  AppliedEffect,
  AppliedResultLedger,
  ApplyResult,
  IntelligenceCommandExecutor,
  IntelligenceJob,
  IntelligencePolicyGate,
  IntelligenceRejectionCode,
  IntelligenceResult,
} from "../contracts.js";

export interface IntelligenceResultApplierDeps {
  readonly ledger: AppliedResultLedger;
  readonly versions: AggregateVersionReader;
  readonly executor: IntelligenceCommandExecutor;
  readonly policy?: IntelligencePolicyGate;
}

type EnvelopeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: IntelligenceRejectionCode; readonly reason: string };

/**
 * The single deterministic gate through which every model-produced
 * {@link IntelligenceResult} must pass before it can change an aggregate. It
 * validates the result envelope, deduplicates by idempotency key, rejects stale
 * results whose base aggregate version has moved on (returning `recompute`),
 * enforces the Job's token/cost budget, an optional policy gate and the evidence
 * closure, and only then invokes the aggregate command executor. The same result
 * applied twice is never applied twice: the second call returns `duplicate`.
 */
export class IntelligenceResultApplier {
  constructor(private readonly deps: IntelligenceResultApplierDeps) {}

  async apply(
    job: IntelligenceJob,
    result: IntelligenceResult,
  ): Promise<ApplyResult> {
    const envelope = this.validateEnvelope(job, result);
    if (!envelope.ok) {
      return { status: "rejected", code: envelope.code, reason: envelope.reason };
    }

    const existing = await this.deps.ledger.find(result.idempotencyKey);
    if (existing !== undefined) {
      return { status: "duplicate", effect: existing };
    }

    const current = await this.deps.versions.currentVersion(job.aggregateRef);
    if (current === undefined || current !== job.baseAggregateVersion) {
      return {
        status: "recompute",
        reason: `Base aggregate version ${job.baseAggregateVersion} no longer matches the current version ${String(current)}.`,
      };
    }

    if (result.terminalStatus !== "succeeded") {
      return {
        status: "rejected",
        code: "TerminalNotSucceeded",
        reason: `Result terminal status is ${result.terminalStatus}.`,
      };
    }

    const totalTokens = result.usage.inputTokens + result.usage.outputTokens;
    if (
      totalTokens > job.budget.maximumTokens ||
      result.usage.costMicros > job.budget.maximumCostMicros
    ) {
      return {
        status: "rejected",
        code: "BudgetExceeded",
        reason: `Result consumed ${totalTokens} tokens / ${result.usage.costMicros} micros beyond the job budget.`,
      };
    }

    const inputSet = new Set(job.inputRefs);
    const strayEvidence = result.evidenceRefs.find((ref) => !inputSet.has(ref));
    if (strayEvidence !== undefined) {
      return {
        status: "rejected",
        code: "EvidenceMismatch",
        reason: `Evidence ref ${strayEvidence} was not among the job input refs.`,
      };
    }

    if (this.deps.policy !== undefined && !this.deps.policy.allows(job, result)) {
      return {
        status: "rejected",
        code: "PolicyViolation",
        reason: "The data policy gate rejected this result.",
      };
    }

    const effect: AppliedEffect = await this.deps.executor.execute(job, result);
    await this.deps.ledger.record(result.idempotencyKey, effect);
    return { status: "applied", effect };
  }

  private validateEnvelope(
    job: IntelligenceJob,
    result: IntelligenceResult,
  ): EnvelopeCheck {
    if (result.resultSchemaVersion !== "intelligence-result/v1") {
      return {
        ok: false,
        code: "SchemaInvalid",
        reason: `Unsupported result schema ${result.resultSchemaVersion}.`,
      };
    }
    if (result.jobId !== job.jobId) {
      return {
        ok: false,
        code: "SchemaInvalid",
        reason: `Result jobId ${result.jobId} does not match job ${job.jobId}.`,
      };
    }
    if (result.idempotencyKey !== job.idempotencyKey) {
      return {
        ok: false,
        code: "SchemaInvalid",
        reason: "Result idempotency key does not match the job.",
      };
    }
    if (job.expectedResultSchema !== result.resultSchemaVersion) {
      return {
        ok: false,
        code: "SchemaInvalid",
        reason: `Job expected schema ${job.expectedResultSchema}.`,
      };
    }
    if (result.confidence < 0 || result.confidence > 1) {
      return {
        ok: false,
        code: "SchemaInvalid",
        reason: `Confidence ${result.confidence} is out of the [0,1] range.`,
      };
    }
    if (
      !Number.isFinite(result.usage.inputTokens) ||
      !Number.isFinite(result.usage.outputTokens) ||
      !Number.isFinite(result.usage.costMicros) ||
      result.usage.inputTokens < 0 ||
      result.usage.outputTokens < 0 ||
      result.usage.costMicros < 0
    ) {
      return {
        ok: false,
        code: "SchemaInvalid",
        reason: "Result usage must be non-negative finite numbers.",
      };
    }
    if (result.terminalStatus === "succeeded" && result.proposals.length === 0) {
      return {
        ok: false,
        code: "SchemaInvalid",
        reason: "A succeeded result must carry at least one proposal.",
      };
    }
    return { ok: true };
  }
}
