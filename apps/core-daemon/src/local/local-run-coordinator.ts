import type { RunCompletionSink } from "@qualigence/core-application";
import type { RunnerConnectionPort } from "@qualigence/grpc-runner-protocol";
import type { LocalRunIntakeStore, RunnerControlStore } from "@qualigence/runner-control";

export class LocalRunCoordinator implements RunCompletionSink {
  private stopped = false;
  private healthy = true;
  private queue: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  private livePromise: Promise<void> | undefined;
  constructor(private readonly options: {
    readonly store: LocalRunIntakeStore;
    readonly controlStore?: RunnerControlStore;
    readonly connection: () => RunnerConnectionPort | undefined;
    readonly configuredRunnerId: string;
    readonly now?: () => string;
    readonly batchSize?: number;
  }) {}
  isHealthy(): boolean { return this.healthy; }
  stop(): void { this.stopped = true; }
  async complete(input: Parameters<RunCompletionSink["complete"]>[0]): Promise<void> {
    if (input.identity.scope.kind !== "local") return;
    await this.reconciliationPass();
  }
  dispatchPass(): Promise<void> { return this.serialize(async () => {
    if (this.stopped) return;
    for (const pending of await this.options.store.pendingDispatches(this.options.batchSize ?? 64)) {
      const connection = this.options.connection();
      const runner = connection?.authenticatedRunner;
      if (connection === undefined || runner?.runnerId !== this.options.configuredRunnerId || runner.scope.kind !== "local" || !runner.capabilities.includes("target:web-playwright")) continue;
      const at = this.now();
      if (!await this.options.store.beginOffer({ runId: pending.runId, expectedAttempt: pending.expectedAttempt, startedAt: at })) continue;
      try { await connection.offer(pending.job, ["target:web-playwright"]); await this.options.store.markOffered({ runId: pending.runId, expectedAttempt: pending.expectedAttempt, offeredAt: this.now() }); }
      catch { await this.options.store.markOfferOutcomeUnknown({ runId: pending.runId, expectedAttempt: pending.expectedAttempt, failedAt: this.now(), errorCode: "OfferFailed" }); }
    }
  }); }
  reconciliationPass(): Promise<void> { return this.serialize(async () => {
    if (this.stopped || this.options.controlStore === undefined) return;
    for (const candidate of await this.options.store.pendingCompletions({ now: this.now(), limit: this.options.batchSize ?? 64 })) await this.reconcileCandidate(candidate);
  }); }
  async startup(): Promise<void> { await this.options.store.quarantineInterruptedDispatches(this.now()); await this.reconciliationPass(); }
  startLive(pollIntervalMs: number): void { this.livePromise ??= this.live(pollIntervalMs); }
  async shutdown(): Promise<void> { this.stopped = true; this.abort.abort(); await this.livePromise; }
  private async live(pollIntervalMs: number): Promise<void> { while (!this.stopped) { await this.dispatchPass(); await this.reconciliationPass(); await delay(pollIntervalMs, this.abort.signal); } }
  private async reconcileCandidate(candidate: { readonly runId: string; readonly jobId: string; readonly jobSha256: string; readonly expectedAttempt: number }): Promise<void> {
    try {
      const authority = await this.options.controlStore?.completionRecord(candidate.runId);
      if (authority === undefined) { await this.options.store.recordCompletionFailure({ runId: candidate.runId, expectedAttempt: candidate.expectedAttempt, errorCode: "CompletionPending", failedAt: this.now() }); return; }
      const expectedHash = candidate.jobSha256 || authority.jobSha256;
      const outcome = await this.options.store.applyCompletion({ runId: candidate.runId, expectedAttempt: candidate.expectedAttempt, jobId: authority.jobId, jobSha256: expectedHash, completion: authority.completion, completedAt: authority.completedAt });
      if (outcome === "identity_mismatch" || outcome === "completion_conflict") { await this.options.store.markIntegrityBlocked({ runId: candidate.runId, expectedAttempt: candidate.expectedAttempt, errorCode: outcome === "identity_mismatch" ? "CompletionIdentityMismatch" : "CompletionConflict", blockedAt: this.now() }); this.healthy = false; }
    } catch { const result = await this.options.store.recordCompletionFailure({ runId: candidate.runId, expectedAttempt: candidate.expectedAttempt, errorCode: "CompletionAuthorityUnavailable", failedAt: this.now() }); if (result.status === "blocked") this.healthy = false; }
  }
  private now(): string { return this.options.now?.() ?? new Date().toISOString(); }
  private serialize(operation: () => Promise<void>): Promise<void> { const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result; }
}

function delay(ms: number, signal: AbortSignal): Promise<void> { if (signal.aborted) return Promise.resolve(); return new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); }); }
