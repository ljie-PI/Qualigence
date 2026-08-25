import type {
  CompleteLeaseResult,
  HashedResumeTokenRecord,
  PersistedExecutionLease,
  PersistedRunnerSession,
  ResumePresentedIdentity,
  ResumeTokenBinding,
  RotateResumeTokenInput,
  RotateResumeTokenResult,
  RunnerControlStore,
  RunnerCompletionRecord,
} from "@qualigence/runner-control";
import type {
  ExecutionCompletion,
  TraceEvent,
  FindingEnvelope,
  RunId,
} from "@qualigence/runner-protocol";
import type { TenantTransactionProvider } from "./tenant-transaction.js";
import { PostgresRunnerControlStore } from "./postgres-runner-control-store.js";
import {
  PostgresTraceStore,
  type PostgresTraceClock,
} from "./postgres-trace-store.js";

/**
 * Long-lived Runner-control store facade for Self-hosted composition. Each
 * method opens a fresh tenant-scoped PostgreSQL transaction and delegates to the
 * normal transaction-backed store inside that operation, so the Runner
 * application graph never retains a completed transaction or an unscoped store.
 */
export class OperationScopedPostgresRunnerControlStore implements RunnerControlStore {
  constructor(
    private readonly provider: TenantTransactionProvider,
    private readonly tenantId: string,
  ) {}

  saveSession(record: PersistedRunnerSession): Promise<void> {
    return this.withStore((store) => store.saveSession(record));
  }

  closeSession(sessionId: string, closedAt: string): Promise<void> {
    return this.withStore((store) => store.closeSession(sessionId, closedAt));
  }

  issueResumeToken(record: HashedResumeTokenRecord): Promise<void> {
    return this.withStore((store) => store.issueResumeToken(record));
  }

  consumeResumeToken(input: {
    tokenHash: string;
    presented: ResumePresentedIdentity;
    consumedAt: string;
  }): Promise<ResumeTokenBinding | undefined> {
    return this.withStore((store) => store.consumeResumeToken(input));
  }

  rotateResumeToken(input: RotateResumeTokenInput): Promise<RotateResumeTokenResult | undefined> {
    return this.withStore((store) => store.rotateResumeToken(input));
  }

  grantLease(input: PersistedExecutionLease): Promise<"granted" | "already_exists"> {
    return this.withStore((store) => store.grantLease(input));
  }

  renewLease(input: {
    runId: string;
    jobId: string;
    owner: { readonly runnerId: string; readonly sessionId: string };
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    newExpiresAt: string;
  }): Promise<"renewed" | "rejected"> {
    return this.withStore((store) => store.renewLease(input));
  }

  completeLease(input: {
    runId: string;
    jobId: string;
    owner: { readonly runnerId: string; readonly sessionId: string };
    leaseEpoch: number;
    leaseTokenHash: string;
    checkedAt: string;
    completion: ExecutionCompletion;
  }): Promise<CompleteLeaseResult> {
    return this.withStore((store) => store.completeLease(input));
  }

  markLeaseLost(runId: string, lostAt: string): Promise<boolean> {
    return this.withStore((store) => store.markLeaseLost(runId, lostAt));
  }

  lease(runId: string): Promise<PersistedExecutionLease | undefined> {
    return this.withStore((store) => store.lease(runId));
  }

  completion(runId: string): Promise<ExecutionCompletion | undefined> {
    return this.withStore((store) => store.completion(runId));
  }

  completionRecord(runId: string): Promise<RunnerCompletionRecord | undefined> {
    return this.withStore((store) => store.completionRecord(runId));
  }

  private withStore<T>(operation: (store: PostgresRunnerControlStore) => Promise<T>): Promise<T> {
    return this.provider.withTenant(this.tenantId, ({ db }) =>
      operation(new PostgresRunnerControlStore(db, this.tenantId)),
    );
  }
}

/**
 * Long-lived Trace store facade matching {@link OperationScopedPostgresRunnerControlStore}:
 * every Trace/finding read or write opens a fresh tenant-scoped transaction.
 */
export class OperationScopedPostgresTraceStore {
  constructor(
    private readonly provider: TenantTransactionProvider,
    private readonly tenantId: string,
    private readonly clock?: PostgresTraceClock,
  ) {}

  appendTraceEvent(event: TraceEvent): ReturnType<PostgresTraceStore["appendTraceEvent"]> {
    return this.withStore((store) => store.appendTraceEvent(event));
  }

  appendFinding(finding: FindingEnvelope, payloadHash: string): ReturnType<PostgresTraceStore["appendFinding"]> {
    return this.withStore((store) => store.appendFinding(finding, payloadHash));
  }

  eventAt(runId: RunId, sequenceNumber: number): Promise<TraceEvent | undefined> {
    return this.withStore((store) => store.eventAt(runId, sequenceNumber));
  }

  nextTraceSequenceNumber(runId: RunId): Promise<number> {
    return this.withStore((store) => store.nextTraceSequenceNumber(runId));
  }

  findingReferences(runId: RunId): Promise<readonly { readonly findingId: string; readonly createdAt: string }[]> {
    return this.withStore((store) => store.findingReferences(runId));
  }

  private withStore<T>(operation: (store: PostgresTraceStore) => Promise<T>): Promise<T> {
    return this.provider.withTenant(this.tenantId, ({ db }) =>
      operation(new PostgresTraceStore(db, this.tenantId, this.clock)),
    );
  }
}
