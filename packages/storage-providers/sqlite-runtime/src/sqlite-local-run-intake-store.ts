import { canonicalPayloadHash, parseExecutionJob } from "@qualigence/runner-protocol";
import type { AcceptedExecutionJob, ExecutionCompletion } from "@qualigence/runner-protocol";
import type {
  LocalCompletionApplyResult,
  LocalRunCompletionCandidate,
  LocalRunDispatch,
  LocalRunIntakeRecord,
  LocalRunIntakeStore,
} from "@qualigence/runner-control";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

export interface LocalCompletionRetryPolicy {
  readonly retryBaseMs: number;
  readonly retryMaximumMs: number;
  readonly maximumAttempts: number;
}

const MAX_RETRY_MS = 300_000;
const MAX_ATTEMPTS = 64;
const MAX_BATCH = 256;

export class SqliteLocalRunIntakeStore implements LocalRunIntakeStore {
  private readonly policy: LocalCompletionRetryPolicy;

  constructor(private readonly runtime: SqliteRuntime, policy: LocalCompletionRetryPolicy) {
    if (
      !positive(policy.retryBaseMs, MAX_RETRY_MS) ||
      !positive(policy.retryMaximumMs, MAX_RETRY_MS) ||
      !positive(policy.maximumAttempts, MAX_ATTEMPTS) ||
      policy.retryBaseMs > policy.retryMaximumMs
    ) throw new Error("Invalid Local completion retry policy.");
    this.policy = Object.freeze({ ...policy });
  }

  async create(input: { readonly job: AcceptedExecutionJob; readonly createdAt: string }): Promise<void> {
    const createdAt = instant(input.createdAt);
    const job = parseExecutionJob(input.job);
    const jobJson = JSON.stringify(job);
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db.insertInto("execution_runs").values({
        run_id: job.runId, job_id: job.jobId, target_kind: job.target.kind,
        objective: job.objective, status: "running", next_sequence_number: 1,
        created_at: createdAt, completed_at: null, error_code: null,
      }).execute();
      await this.runtime.db.insertInto("local_run_intakes").values({
        run_id: job.runId, job_id: job.jobId, job_json: jobJson,
        job_sha256: canonicalPayloadHash(job), dispatch_state: "pending_runner", dispatch_attempt: 0,
        dispatch_last_attempt_at: null, dispatch_error_code: null, completion_state: "awaiting",
        completion_attempt: 0, completion_last_attempt_at: null, completion_next_attempt_at: createdAt,
        completion_error_code: null, completion_sha256: null, completion_applied_at: null,
        completion_blocked_at: null, created_at: createdAt, updated_at: createdAt,
      }).execute();
    });
  }

  async pendingDispatches(limit: number): Promise<readonly LocalRunDispatch[]> {
    bounded(limit);
    const rows = await this.runtime.db.selectFrom("local_run_intakes")
      .select(["run_id", "dispatch_attempt", "job_json"])
      .where("dispatch_state", "=", "pending_runner")
      .orderBy("updated_at").orderBy("run_id").limit(limit).execute();
    return rows.map((row) => ({ runId: row.run_id, expectedAttempt: row.dispatch_attempt, job: parseExecutionJob(JSON.parse(row.job_json)) }));
  }

  async beginOffer(input: { readonly runId: string; readonly expectedAttempt: number; readonly startedAt: string }): Promise<boolean> {
    const result = await this.runtime.db.updateTable("local_run_intakes").set({
      dispatch_state: "dispatching", dispatch_attempt: input.expectedAttempt + 1,
      dispatch_last_attempt_at: instant(input.startedAt), dispatch_error_code: null, updated_at: input.startedAt,
    }).where("run_id", "=", input.runId).where("dispatch_state", "=", "pending_runner")
      .where("dispatch_attempt", "=", input.expectedAttempt).executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async markOffered(input: { readonly runId: string; readonly expectedAttempt: number; readonly offeredAt: string }): Promise<boolean> {
    return this.finishDispatch(input.runId, input.expectedAttempt, "offered", input.offeredAt, null);
  }

  async markOfferOutcomeUnknown(input: { readonly runId: string; readonly expectedAttempt: number; readonly failedAt: string; readonly errorCode: string }): Promise<boolean> {
    return this.finishDispatch(input.runId, input.expectedAttempt, "offer_outcome_unknown", input.failedAt, safeCode(input.errorCode));
  }

  async quarantineInterruptedDispatches(quarantinedAt: string): Promise<number> {
    const at = instant(quarantinedAt);
    const result = await this.runtime.db.updateTable("local_run_intakes").set({ dispatch_state: "offer_outcome_unknown", dispatch_error_code: "OfferInterrupted", updated_at: at })
      .where("dispatch_state", "=", "dispatching").executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async run(runId: string): Promise<LocalRunIntakeRecord | undefined> {
    const row = await this.runtime.db.selectFrom("local_run_intakes").innerJoin("execution_runs", "execution_runs.run_id", "local_run_intakes.run_id")
      .select(["local_run_intakes.run_id", "local_run_intakes.job_id", "dispatch_state", "dispatch_attempt", "completion_state", "completion_attempt", "completion_next_attempt_at", "completion_error_code", "execution_runs.status", "execution_runs.completed_at", "execution_runs.error_code"])
      .where("local_run_intakes.run_id", "=", runId).executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      runId: row.run_id, jobId: row.job_id, dispatchState: row.dispatch_state as LocalRunIntakeRecord["dispatchState"],
      dispatchAttempt: row.dispatch_attempt, completionState: row.completion_state as LocalRunIntakeRecord["completionState"],
      completionAttempt: row.completion_attempt, completionNextAttemptAt: row.completion_next_attempt_at,
      runStatus: row.status as LocalRunIntakeRecord["runStatus"],
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      ...(row.completion_error_code === null ? {} : { completionErrorCode: row.completion_error_code }),
    };
  }

  async pendingCompletions(input: { readonly now: string; readonly limit: number }): Promise<readonly LocalRunCompletionCandidate[]> {
    const now = instant(input.now); bounded(input.limit);
    const rows = await this.runtime.db.selectFrom("local_run_intakes")
      .select(["run_id", "job_id", "job_sha256", "completion_attempt"])
      .where("dispatch_state", "in", ["offered", "offer_outcome_unknown"])
      .where("completion_state", "=", "awaiting").where("completion_next_attempt_at", "<=", now)
      .orderBy("completion_next_attempt_at").orderBy("updated_at").orderBy("run_id").limit(input.limit).execute();
    return rows.map((row) => ({ runId: row.run_id, jobId: row.job_id, jobSha256: row.job_sha256, expectedAttempt: row.completion_attempt }));
  }

  async hasCompletionBlockers(): Promise<boolean> {
    const row = await this.runtime.db.selectFrom("local_run_intakes").select("run_id")
      .where("completion_state", "in", ["integrity_blocked", "retry_exhausted"]).limit(1).executeTakeFirst();
    return row !== undefined;
  }

  async recordCompletionFailure(input: { readonly runId: string; readonly expectedAttempt: number; readonly errorCode: "CompletionPending" | "CompletionAuthorityUnavailable" | "CompletionApplyFailed"; readonly failedAt: string }) {
    const failedAt = instant(input.failedAt);
    return runInImmediateTransaction(this.runtime, async () => {
      const row = await this.runtime.db.selectFrom("local_run_intakes").select(["completion_state", "completion_attempt"])
        .where("run_id", "=", input.runId).executeTakeFirst();
      if (row === undefined || row.completion_state === "applied" || row.completion_attempt !== input.expectedAttempt) return { status: "stale" } as const;
      if (row.completion_state !== "awaiting") return { status: "blocked" } as const;
      const attempt = input.expectedAttempt + 1;
      if (attempt >= this.policy.maximumAttempts) {
        await this.runtime.db.updateTable("local_run_intakes").set({ completion_state: "retry_exhausted", completion_attempt: attempt, completion_last_attempt_at: failedAt, completion_error_code: input.errorCode, completion_blocked_at: failedAt, updated_at: failedAt })
          .where("run_id", "=", input.runId).where("completion_state", "=", "awaiting").where("completion_attempt", "=", input.expectedAttempt).execute();
        return { status: "blocked" } as const;
      }
      const delay = Math.min(this.policy.retryMaximumMs, cappedPower(this.policy.retryBaseMs, attempt - 1, this.policy.retryMaximumMs));
      const nextMs = Date.parse(failedAt) + delay;
      if (!Number.isSafeInteger(nextMs)) throw new Error("Completion retry timestamp overflow.");
      const nextAttemptAt = new Date(nextMs).toISOString();
      const updated = await this.runtime.db.updateTable("local_run_intakes").set({ completion_attempt: attempt, completion_last_attempt_at: failedAt, completion_next_attempt_at: nextAttemptAt, completion_error_code: input.errorCode, updated_at: failedAt })
        .where("run_id", "=", input.runId).where("completion_state", "=", "awaiting").where("completion_attempt", "=", input.expectedAttempt).executeTakeFirst();
      return updated.numUpdatedRows === 1n ? { status: "scheduled", attempt, nextAttemptAt } as const : { status: "stale" } as const;
    });
  }

  async applyCompletion(input: { readonly runId: string; readonly expectedAttempt: number; readonly jobId: string; readonly jobSha256: string; readonly completion: ExecutionCompletion; readonly completedAt: string }): Promise<LocalCompletionApplyResult> {
    const completedAt = instant(input.completedAt);
    return runInImmediateTransaction(this.runtime, async () => {
      const row = await this.runtime.db.selectFrom("local_run_intakes").innerJoin("execution_runs", "execution_runs.run_id", "local_run_intakes.run_id")
        .select(["local_run_intakes.job_id", "job_sha256", "completion_state", "completion_attempt", "completion_sha256", "execution_runs.status", "execution_runs.completed_at", "execution_runs.error_code"])
        .where("local_run_intakes.run_id", "=", input.runId).executeTakeFirst();
      if (row === undefined) return "stale";
      const hash = canonicalPayloadHash(input.completion);
      const completionErrorCode = "errorCode" in input.completion ? input.completion.errorCode : undefined;
      if (row.completion_state === "applied") return row.job_id === input.jobId && row.job_sha256 === input.jobSha256 && row.completion_sha256 === hash && row.status === input.completion.status && row.completed_at === completedAt && row.error_code === (completionErrorCode ?? null) ? "duplicate" : "completion_conflict";
      if (row.completion_state !== "awaiting" || row.completion_attempt !== input.expectedAttempt) return "stale";
      if (row.job_id !== input.jobId || row.job_sha256 !== input.jobSha256 || input.completion.jobId !== input.jobId || input.completion.runId !== input.runId) return "identity_mismatch";
      if (row.status !== "running") {
        if (row.status !== input.completion.status || row.completed_at !== completedAt || row.error_code !== (completionErrorCode ?? null)) return "completion_conflict";
      }
      await this.runtime.db.updateTable("execution_runs").set({ status: input.completion.status, completed_at: completedAt, error_code: completionErrorCode ?? null }).where("run_id", "=", input.runId).where("status", "=", "running").execute();
      await this.runtime.db.updateTable("local_run_intakes").set({ completion_state: "applied", completion_sha256: hash, completion_applied_at: completedAt, completion_error_code: null, updated_at: completedAt })
        .where("run_id", "=", input.runId).where("completion_state", "=", "awaiting").where("completion_attempt", "=", input.expectedAttempt).execute();
      return "applied";
    });
  }

  async markIntegrityBlocked(input: { readonly runId: string; readonly expectedAttempt: number; readonly errorCode: "CompletionIdentityMismatch" | "CompletionConflict"; readonly blockedAt: string }): Promise<"blocked" | "stale"> {
    const blockedAt = instant(input.blockedAt);
    const result = await this.runtime.db.updateTable("local_run_intakes").set({ completion_state: "integrity_blocked", completion_error_code: input.errorCode, completion_blocked_at: blockedAt, updated_at: blockedAt })
      .where("run_id", "=", input.runId).where("completion_state", "=", "awaiting").where("completion_attempt", "=", input.expectedAttempt).executeTakeFirst();
    if (result.numUpdatedRows === 1n) return "blocked";
    const row = await this.runtime.db.selectFrom("local_run_intakes").select("completion_state").where("run_id", "=", input.runId).executeTakeFirst();
    return row?.completion_state === "integrity_blocked" || row?.completion_state === "retry_exhausted" ? "blocked" : "stale";
  }

  private async finishDispatch(runId: string, expectedAttempt: number, state: "offered" | "offer_outcome_unknown", atInput: string, errorCode: string | null): Promise<boolean> {
    const at = instant(atInput);
    const result = await this.runtime.db.updateTable("local_run_intakes").set({ dispatch_state: state, dispatch_error_code: errorCode, updated_at: at })
      .where("run_id", "=", runId).where("dispatch_state", "=", "dispatching").where("dispatch_attempt", "=", expectedAttempt + 1).executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
}

function positive(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function bounded(limit: number): void { if (!positive(limit, MAX_BATCH)) throw new Error("Invalid Local intake batch limit."); }
function instant(value: string): string { const ms = Date.parse(value); if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value) throw new Error("Invalid canonical timestamp."); return value; }
function safeCode(value: string): string { return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value) ? value : "OfferFailed"; }
function cappedPower(base: number, exponent: number, cap: number): number { let value = base; for (let index = 0; index < exponent; index += 1) { if (value >= Math.ceil(cap / 2)) return cap; value *= 2; } return value; }
