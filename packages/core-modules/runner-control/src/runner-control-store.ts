import {
  canonicalPayloadHash,
  type AcceptedExecutionJob,
  type ExecutionCompletion,
} from "@qualigence/runner-protocol";

export interface ResumeTokenBinding {
  readonly runnerId: string;
  readonly certificateFingerprint: string;
  readonly previousSessionId: string;
  readonly protocolMajor: number;
}

export interface ResumePresentedIdentity {
  readonly runnerId: string;
  readonly certificateFingerprint: string;
  readonly protocolMajor: number;
}

export interface PersistedRunnerSession {
  readonly sessionId: string;
  readonly runnerId: string;
  readonly certificateFingerprint: string;
  readonly capabilities: readonly string[];
  readonly protocolMajor: number;
  readonly createdAt: string;
}

export interface PersistedLeaseOwner {
  readonly runnerId: string;
  readonly sessionId: string;
}

export interface HashedResumeTokenRecord {
  readonly tokenHash: string;
  readonly binding: ResumeTokenBinding;
  readonly expiresAt: string;
}

export interface PersistedExecutionLease {
  readonly job: AcceptedExecutionJob;
  readonly owner: PersistedLeaseOwner;
  readonly leaseEpoch: number;
  readonly leaseTokenHash: string;
  readonly expiresAt: string;
  readonly lostAt?: string;
  readonly completedAt?: string;
  readonly recoveryOfRunId?: string;
}

export class InMemoryRunnerControlStore implements RunnerControlStore {
  private readonly sessions = new Map<string, PersistedRunnerSession & { closedAt?: string }>();
  private readonly tokens = new Map<
    string,
    HashedResumeTokenRecord & { consumedAt?: string }
  >();
  private readonly leases = new Map<string, PersistedExecutionLease>();
  private readonly completions = new Map<string, ExecutionCompletion>();
  private queue: Promise<void> = Promise.resolve();

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
      if (record === undefined || record.consumedAt !== undefined) {
        return undefined;
      }
      this.tokens.set(input.tokenHash, { ...record, consumedAt: input.consumedAt });
      if (
        record.expiresAt <= input.consumedAt ||
        record.binding.runnerId !== input.presented.runnerId ||
        record.binding.certificateFingerprint !== input.presented.certificateFingerprint ||
        record.binding.protocolMajor !== input.presented.protocolMajor
      ) {
        return undefined;
      }
      return record.binding;
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
  }): Promise<boolean> {
    return this.serialize(() => {
      const record = this.liveLease(input);
      if (record === undefined) {
        return false;
      }
      this.leases.set(input.runId, { ...record, expiresAt: input.newExpiresAt });
      return true;
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
  }): Promise<"completed" | "duplicate" | "rejected"> {
    return this.serialize(() => {
      const existing = this.completions.get(input.runId);
      if (existing !== undefined) {
        return canonicalPayloadHash(existing) === canonicalPayloadHash(input.completion)
          ? "duplicate"
          : "rejected";
      }
      const record = this.liveLease(input);
      if (record === undefined) {
        const raced = this.completions.get(input.runId);
        return raced !== undefined &&
          canonicalPayloadHash(raced) === canonicalPayloadHash(input.completion)
          ? "duplicate"
          : "rejected";
      }
      this.leases.set(input.runId, { ...record, completedAt: input.checkedAt });
      this.completions.set(input.runId, input.completion);
      return "completed";
    });
  }

  markLeaseLost(runId: string, lostAt: string): Promise<boolean> {
    return this.serialize(() => {
      const record = this.leases.get(runId);
      if (record === undefined || record.lostAt !== undefined) {
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
    return this.serialize(() => this.completions.get(runId));
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
      record.job.jobId !== input.jobId ||
      record.owner.runnerId !== input.owner.runnerId ||
      record.owner.sessionId !== input.owner.sessionId ||
      record.leaseEpoch !== input.leaseEpoch ||
      record.leaseTokenHash !== input.leaseTokenHash ||
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

export interface RunnerControlStore {
  saveSession(record: PersistedRunnerSession): Promise<void>;
  closeSession(sessionId: string, closedAt: string): Promise<void>;
  issueResumeToken(record: HashedResumeTokenRecord): Promise<void>;
  consumeResumeToken(input: {
    tokenHash: string;
    presented: ResumePresentedIdentity;
    consumedAt: string;
  }): Promise<ResumeTokenBinding | undefined>;
  grantLease(input: PersistedExecutionLease): Promise<"granted" | "already_exists">;
  renewLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    newExpiresAt: string;
  }): Promise<boolean>;
  completeLease(input: {
    runId: string;
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    completion: ExecutionCompletion;
  }): Promise<"completed" | "duplicate" | "rejected">;
  markLeaseLost(runId: string, lostAt: string): Promise<boolean>;
  lease(runId: string): Promise<PersistedExecutionLease | undefined>;
  completion(runId: string): Promise<ExecutionCompletion | undefined>;
}
