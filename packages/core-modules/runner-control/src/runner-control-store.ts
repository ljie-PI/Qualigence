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

/**
 * The result of one atomic completion attempt. A stored terminal completion is
 * exposed only when this attempt verified the lease binding and observed a
 * different canonical completion in that same operation.
 */
export type CompleteLeaseResult =
  | { readonly outcome: "completed" }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "rejected" }
  | {
      readonly outcome: "completion_conflict";
      readonly storedCompletion: ExecutionCompletion;
    };

export interface RotateResumeTokenInput {
  readonly presentedTokenHash: string;
  readonly replacementTokenHash: string;
  readonly replacementExpiresAt: string;
  readonly presented: ResumePresentedIdentity;
  readonly rotatedAt: string;
}

export interface RotateResumeTokenResult {
  /**
   * `rotated` when this call consumed the presented token and stored the
   * replacement; `idempotent_retry` when an earlier (possibly crashed)
   * redemption already rotated the same presented token.
   */
  readonly outcome: "rotated" | "idempotent_retry";
  readonly binding: ResumeTokenBinding;
}

export type RunnerControlIntegrityKind = "completion_conflict";

/**
 * An integrity anomaly observed by the runner-control authority. Only hashes
 * are ever carried; raw lease tokens, resume tokens and completion payloads
 * must never be embedded in an event.
 */
export interface RunnerControlIntegrityEvent {
  readonly kind: RunnerControlIntegrityKind;
  readonly runId: string;
  readonly leaseTokenHash: string;
  readonly presentedCompletionHash: string;
  readonly storedCompletionHash?: string;
  readonly observedAt: string;
}

export interface RunnerControlIntegrityEventSink {
  readonly emit: (event: RunnerControlIntegrityEvent) => void;
}

/**
 * Pure lease-binding comparison shared by every provider: a completion is
 * legitimate only when the presented lease is bound to the stored job, owner,
 * epoch and token hash and the lease was never marked lost. It intentionally
 * ignores expiry and the completed flag so an idempotent completion retry after
 * the terminal commit remains a `duplicate` rather than a rejection.
 */
export function leaseBindingMatches(
  record: PersistedExecutionLease,
  presented: {
    jobId: string;
    owner: PersistedLeaseOwner;
    leaseEpoch: number;
    leaseTokenHash: string;
  },
): boolean {
  return (
    record.lostAt === undefined &&
    record.job.jobId === presented.jobId &&
    record.owner.runnerId === presented.owner.runnerId &&
    record.owner.sessionId === presented.owner.sessionId &&
    record.leaseEpoch === presented.leaseEpoch &&
    record.leaseTokenHash === presented.leaseTokenHash
  );
}

/**
 * Classify a completion replay against the stored terminal result. `duplicate`
 * is legal only when the stored completion is byte-for-byte
 * canonical-equivalent; any other stored terminal result is `rejected` and must
 * be surfaced as a `completion_conflict` integrity event.
 */
export function classifyCompletion(
  stored: ExecutionCompletion,
  presented: ExecutionCompletion,
): "duplicate" | "rejected" {
  return canonicalPayloadHash(stored) === canonicalPayloadHash(presented)
    ? "duplicate"
    : "rejected";
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
  /**
   * Atomically redeem a single-use resume token and persist its replacement in
   * the same step, so a redemption that crashed between the consume and the
   * Welcome reply can be replayed deterministically. A repeated presentation of
   * an already-rotated token returns `idempotent_retry` with the same binding;
   * an unknown, expired, plainly consumed, or identity-mismatched token returns
   * `undefined`.
   */
  rotateResumeToken(input: RotateResumeTokenInput): Promise<RotateResumeTokenResult | undefined>;
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
  }): Promise<CompleteLeaseResult>;
  markLeaseLost(runId: string, lostAt: string): Promise<boolean>;
  lease(runId: string): Promise<PersistedExecutionLease | undefined>;
  completion(runId: string): Promise<ExecutionCompletion | undefined>;
}
