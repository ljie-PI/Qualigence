import type { IntelligenceJob, IntelligenceJobType, IntelligenceResult } from "@qualigence/intelligence";

/**
 * A durable lease on an Intelligence Job. In the single-node v1 the lease is
 * backed by a PostgreSQL `FOR UPDATE SKIP LOCKED` row lock held for the lease
 * lifetime, so two Workers can never hold the same Job at once, and a crashed
 * Worker's lock is released automatically for re-lease.
 */
export interface IntelligenceJobLease {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly workerId: string;
  readonly expiresAt: string;
  readonly attempt: number;
}

export interface LeaseInput {
  readonly workerId: string;
  readonly acceptedTypes: readonly IntelligenceJobType[];
  readonly now: string;
  readonly leaseDurationMs: number;
}

export interface RenewInput {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly workerId: string;
  readonly now: string;
  readonly leaseDurationMs: number;
}

/**
 * The Worker-facing durable work queue. A Worker only ever leases Jobs of an
 * accepted type; it never reads or writes an aggregate table.
 */
export interface IntelligenceJobStore {
  lease(input: LeaseInput): Promise<{ readonly job: IntelligenceJob; readonly lease: IntelligenceJobLease } | undefined>;
  renew(input: RenewInput): Promise<IntelligenceJobLease>;
  /** Release a held lease without appending a Result (e.g. after a processing failure) so the Job can be re-leased. */
  abandon(jobId: string): Promise<void>;
}

export interface AppendResultInput {
  readonly tenantId: string;
  readonly jobId: string;
  readonly leaseToken: string;
  readonly leaseAttempt: number;
  readonly workerId: string;
  readonly baseAggregateVersion: number;
  readonly result: IntelligenceResult;
}

export type AppendDisposition = "accepted" | "duplicate";

/**
 * The append-only Result Inbox. A Worker appends a validated Result under its
 * active lease; the Server (never the Worker) later applies it. Append is
 * idempotent by the Result idempotency key — the same Result appended twice is
 * `duplicate`, never a second row.
 */
export interface IntelligenceResultInbox {
  append(input: AppendResultInput): Promise<{ readonly disposition: AppendDisposition }>;
}
