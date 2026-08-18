import type {
  ExecutionCompletion,
} from "@qualigence/runner-protocol";
import type {
  CompleteLeaseResult,
  HashedResumeTokenRecord,
  PersistedExecutionLease,
  PersistedLeaseOwner,
  PersistedRunnerSession,
  ResumePresentedIdentity,
  ResumeTokenBinding,
  RotateResumeTokenInput,
  RotateResumeTokenResult,
  RunnerControlStore,
} from "@qualigence/runner-control";
import {
  leaseBindingMatches,
  observedCompletionResult,
} from "@qualigence/runner-control";

type TokenRecord = HashedResumeTokenRecord & { consumedAt?: string };

/**
 * Serializable-behaviour in-memory {@link RunnerControlStore} for tests. It is a
 * test double, never production code: the SQLite and PostgreSQL providers are
 * the only production implementations, and both are pinned to this behaviour by
 * the shared `runnerControlStoreContract`.
 */
export class InMemoryRunnerControlStore implements RunnerControlStore {
  private readonly sessions = new Map<string, PersistedRunnerSession & { closedAt?: string }>();
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly leases = new Map<string, PersistedExecutionLease>();
  private readonly completions = new Map<string, ExecutionCompletion>();
  private queue: Promise<void> = Promise.resolve();
  completionReadCount = 0;

  saveSession(record: PersistedRunnerSession): Promise<void> {
    return this.serialize(() => {
      this.sessions.set(record.sessionId, { ...record });
    });
  }

  closeSession(sessionId: string, closedAt: string): Promise<void> {
    return this.serialize(() => {
      const existing = this.sessions.get(sessionId);
      if (existing !== undefined) {
        this.sessions.set(sessionId, { ...existing, closedAt });
      }
    });
  }

  issueResumeToken(record: HashedResumeTokenRecord): Promise<void> {
    return this.serialize(() => {
      this.tokens.set(record.tokenHash, { ...record });
    });
  }

  consumeResumeToken(input: {
    tokenHash: string;
    presented: ResumePresentedIdentity;
    consumedAt: string;
  }): Promise<ResumeTokenBinding | undefined> {
    return this.serialize(() => {
      const record = this.tokens.get(input.tokenHash);
      if (
        record === undefined ||
        record.consumedAt !== undefined ||
        record.expiresAt <= input.consumedAt ||
        record.binding.runnerId !== input.presented.runnerId ||
        record.binding.certificateFingerprint !== input.presented.certificateFingerprint ||
        record.binding.protocolMajor !== input.presented.protocolMajor
      ) {
        return undefined;
      }
      this.tokens.set(input.tokenHash, { ...record, consumedAt: input.consumedAt });
      return record.binding;
    });
  }

  rotateResumeToken(input: RotateResumeTokenInput): Promise<RotateResumeTokenResult | undefined> {
    return this.serialize(() => {
      const record = this.tokens.get(input.presentedTokenHash);
      if (record === undefined || !identityMatches(record.binding, input.presented)) {
        return undefined;
      }
      if (record.expiresAt <= input.rotatedAt) {
        // The crash-replay window has closed: burn the credential.
        this.tokens.set(input.presentedTokenHash, { ...record, consumedAt: input.rotatedAt });
        return undefined;
      }
      const replacement = this.tokens.get(input.replacementTokenHash);
      if (record.consumedAt !== undefined) {
        return replacement === undefined
          ? undefined
          : { outcome: "idempotent_retry", binding: record.binding };
      }
      this.tokens.set(input.replacementTokenHash, {
        tokenHash: input.replacementTokenHash,
        binding: record.binding,
        expiresAt: input.replacementExpiresAt,
      });
      this.tokens.set(input.presentedTokenHash, { ...record, consumedAt: input.rotatedAt });
      return { outcome: "rotated", binding: record.binding };
    });
  }

  grantLease(input: PersistedExecutionLease): Promise<"granted" | "already_exists"> {
    return this.serialize(() => {
      if (this.leases.has(input.job.runId)) {
        return "already_exists";
      }
      this.leases.set(input.job.runId, { ...input });
      return "granted";
    });
  }

  renewLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    newExpiresAt: string;
  }): Promise<"renewed" | "rejected"> {
    return this.serialize(() => {
      const record = this.liveLease(input);
      if (record === undefined) {
        return "rejected";
      }
      this.leases.set(input.runId, { ...record, expiresAt: input.newExpiresAt });
      return "renewed";
    });
  }

  completeLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    completion: ExecutionCompletion;
  }): Promise<CompleteLeaseResult> {
    return this.serialize(() => {
      const record = this.leases.get(input.runId);
      if (record === undefined) {
        return { outcome: "rejected" };
      }
      const bound = leaseBindingMatches(record, input);
      if (!bound) {
        return { outcome: "rejected" };
      }
      const existing = this.completions.get(input.runId);
      const observed = observedCompletionResult(existing, input.completion);
      if (observed !== undefined) {
        return observed;
      }
      if (!bound || record.expiresAt <= input.checkedAt) {
        return { outcome: "rejected" };
      }
      const raced = this.completions.get(input.runId);
      const racedResult = observedCompletionResult(raced, input.completion);
      if (racedResult !== undefined) {
        return racedResult;
      }
      this.leases.set(input.runId, { ...record, completedAt: input.checkedAt });
      this.completions.set(input.runId, input.completion);
      return { outcome: "completed" };
    });
  }

  markLeaseLost(runId: string, lostAt: string): Promise<boolean> {
    return this.serialize(() => {
      const record = this.leases.get(runId);
      if (record === undefined || record.lostAt !== undefined || record.completedAt !== undefined) {
        return false;
      }
      this.leases.set(runId, { ...record, lostAt });
      return true;
    });
  }

  lease(runId: string): Promise<PersistedExecutionLease | undefined> {
    return this.serialize(() => this.leases.get(runId));
  }

  completion(runId: string): Promise<ExecutionCompletion | undefined> {
    return this.serialize(() => {
      this.completionReadCount += 1;
      return this.completions.get(runId);
    });
  }

  private liveLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
  }): PersistedExecutionLease | undefined {
    const record = this.leases.get(input.runId);
    if (
      record === undefined ||
      record.lostAt !== undefined ||
      record.completedAt !== undefined ||
      !leaseBindingMatches(record, input) ||
      record.expiresAt <= input.checkedAt
    ) {
      return undefined;
    }
    return record;
  }

  private serialize<TResult>(operation: () => Promise<TResult> | TResult): Promise<TResult> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function identityMatches(
  binding: ResumeTokenBinding,
  presented: ResumePresentedIdentity,
): boolean {
  return (
    binding.runnerId === presented.runnerId &&
    binding.certificateFingerprint === presented.certificateFingerprint &&
    binding.protocolMajor === presented.protocolMajor
  );
}
