/**
 * The Intelligence Job/Result contract: the persistent envelope for a
 * model-assisted investigation step (reproduction planning or bug analysis). A
 * Worker only ever produces an {@link IntelligenceResult}; a deterministic
 * applier validates it against the Job's schema, budget, policy, evidence and
 * base aggregate version before any aggregate is touched. The model never writes
 * an aggregate directly.
 */

export type IntelligenceJobType =
  | "prd.planning"
  | "skill.induction"
  | "skill.evaluation"
  | "investigation.reproduction-planning"
  | "investigation.bug-analysis";

export interface IntelligenceAggregateRef {
  readonly type: string;
  readonly id: string;
}

export interface IntelligenceJobBudget {
  readonly maximumTokens: number;
  readonly maximumCostMicros: number;
  readonly timeoutMs: number;
}

export interface IntelligenceJob {
  readonly jobId: string;
  readonly jobType: IntelligenceJobType;
  readonly schemaVersion: "intelligence-job/v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly aggregateRef: IntelligenceAggregateRef;
  readonly baseAggregateVersion: number;
  readonly inputRefs: readonly string[];
  readonly modelProfileId: string;
  readonly dataPolicyId: string;
  readonly budget: IntelligenceJobBudget;
  readonly priority: "low" | "normal" | "high";
  readonly idempotencyKey: string;
  readonly causationId: string;
  readonly expectedResultSchema: string;
}

export interface IntelligenceResultUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
}

export interface IntelligenceResult {
  readonly jobId: string;
  readonly resultSchemaVersion: "intelligence-result/v1";
  readonly proposals: readonly Readonly<Record<string, unknown>>[];
  readonly evidenceRefs: readonly string[];
  readonly confidence: number;
  readonly provenance: readonly string[];
  readonly usage: IntelligenceResultUsage;
  readonly terminalStatus: "succeeded" | "blocked" | "failed";
  readonly idempotencyKey: string;
}

export type IntelligenceRejectionCode =
  | "SchemaInvalid"
  | "TerminalNotSucceeded"
  | "BudgetExceeded"
  | "PolicyViolation"
  | "EvidenceMismatch";

/**
 * The aggregate-agnostic description of what a validated result changed. It
 * references a version only — never plaintext model output — so it is safe to
 * persist and replay for idempotency.
 */
export interface AppliedEffect {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly newVersion: number;
  readonly summary: string;
}

export type ApplyResult =
  | { readonly status: "applied"; readonly effect: AppliedEffect }
  | { readonly status: "duplicate"; readonly effect: AppliedEffect }
  | { readonly status: "recompute"; readonly reason: string }
  | {
      readonly status: "rejected";
      readonly code: IntelligenceRejectionCode;
      readonly reason: string;
    };

/** Records which result idempotency keys have already been applied. */
export interface AppliedResultLedger {
  find(idempotencyKey: string): Promise<AppliedEffect | undefined>;
  record(idempotencyKey: string, effect: AppliedEffect): Promise<void>;
}

/** Reports the live version of a target aggregate, to detect stale results. */
export interface AggregateVersionReader {
  currentVersion(ref: IntelligenceAggregateRef): Promise<number | undefined>;
}

/** Applies a fully validated result to its target aggregate, deterministically. */
export interface IntelligenceCommandExecutor {
  execute(job: IntelligenceJob, result: IntelligenceResult): Promise<AppliedEffect>;
}

/** An optional deterministic policy gate consulted before execution. */
export interface IntelligencePolicyGate {
  allows(job: IntelligenceJob, result: IntelligenceResult): boolean;
}
