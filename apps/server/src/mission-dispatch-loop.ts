import type {
  AcceptedMissionDispatch,
  MissionDispatchAcceptanceReceipt,
  PendingMissionDispatch,
  PrdMissionRepository,
} from "@qualigence/mission";
import {
  canonicalPayloadHash,
  parseExecutionJob,
  type AcceptedExecutionJob,
  type ExecutionJobLease,
} from "@qualigence/runner-protocol";
import type { Clock } from "@qualigence/shared-kernel";

export type MissionDispatchRunnerScope =
  | { readonly kind: "local" }
  | {
      readonly kind: "tenant";
      readonly tenantId: string;
      readonly projectIds: readonly string[];
    };

export interface MissionDispatchRunnerConnection {
  readonly authenticatedRunner: {
    readonly runnerId: string;
    readonly scope: MissionDispatchRunnerScope;
    readonly capabilities: readonly string[];
  };
  offer(job: AcceptedExecutionJob, requirements: readonly string[]): Promise<ExecutionJobLease>;
}

export interface MissionDispatchRunnerDirectory {
  connectionFor(input: {
    readonly tenantId: string;
    readonly runnerId: string;
  }): MissionDispatchRunnerConnection | undefined | Promise<MissionDispatchRunnerConnection | undefined>;
}

export interface MissionDispatchLeaseReader {
  lease(runId: string): Promise<{
    readonly job: AcceptedExecutionJob;
    readonly owner: { readonly runnerId: string };
    readonly lostAt?: string;
    readonly completedAt?: string;
  } | undefined>;
}

export type MissionDispatchBlockedReason =
  | "runner_binding_mismatch"
  | "tenant_scope_mismatch"
  | "project_scope_mismatch"
  | "capability_mismatch"
  | "policy_invalid"
  | "lease_identity_mismatch"
  | "lease_lost"
  | "dispatch_conflict";

export type MissionDispatchPendingReason =
  | "runner_offline"
  | "runner_unavailable"
  | "backing_off";

export type MissionDispatchResult =
  | {
      readonly outcome: "accepted";
      readonly dispatch: AcceptedMissionDispatch;
      readonly receipt: MissionDispatchAcceptanceReceipt;
      readonly lease?: ExecutionJobLease;
    }
  | {
      readonly outcome: "pending";
      readonly attemptId: string;
      readonly runnerId: string;
      readonly reason: MissionDispatchPendingReason;
      readonly retryAfterMs: number;
    }
  | {
      readonly outcome: "blocked";
      readonly attemptId: string;
      readonly runnerId: string;
      readonly reason: MissionDispatchBlockedReason;
      readonly retryAfterMs: number;
      readonly details?: Readonly<Record<string, unknown>>;
    };

export interface MissionDispatchCycleResult {
  readonly totalPending: number;
  readonly attempted: number;
  readonly accepted: number;
  readonly pending: number;
  readonly blocked: number;
  readonly results: readonly MissionDispatchResult[];
}

export interface MissionDispatchLoopOptions {
  readonly tenantId: string;
  readonly repository: Pick<PrdMissionRepository, "pendingDispatches" | "markDispatchAccepted">;
  readonly runners: MissionDispatchRunnerDirectory;
  readonly leases: MissionDispatchLeaseReader;
  readonly clock: Clock;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly initialBackoffMs?: number;
  readonly maximumBackoffMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

interface BackoffState {
  readonly failures: number;
  readonly notBeforeMs: number;
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAXIMUM_BACKOFF_MS = 30_000;

export class MissionDispatchLoop {
  private readonly tenantId: string;
  private readonly repository: MissionDispatchLoopOptions["repository"];
  private readonly runners: MissionDispatchRunnerDirectory;
  private readonly leases: MissionDispatchLeaseReader;
  private readonly clock: Clock;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maximumBackoffMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly backoff = new Map<string, BackoffState>();
  private timer: unknown;
  private active = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(options: MissionDispatchLoopOptions) {
    this.tenantId = nonEmpty(options.tenantId, "tenantId");
    this.repository = options.repository;
    this.runners = options.runners;
    this.leases = options.leases;
    this.clock = options.clock;
    this.batchSize = boundedPositive(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize", 256);
    this.intervalMs = boundedPositive(options.intervalMs ?? DEFAULT_INTERVAL_MS, "intervalMs", 60_000);
    this.initialBackoffMs = boundedPositive(options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS, "initialBackoffMs", 60_000);
    this.maximumBackoffMs = boundedPositive(options.maximumBackoffMs ?? DEFAULT_MAXIMUM_BACKOFF_MS, "maximumBackoffMs", 300_000);
    if (this.initialBackoffMs > this.maximumBackoffMs) {
      throw new Error("initialBackoffMs must be less than or equal to maximumBackoffMs");
    }
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  async runOnce(): Promise<MissionDispatchCycleResult> {
    const dispatches = await this.repository.pendingDispatches(this.batchSize);
    const results: MissionDispatchResult[] = [];
    for (const dispatch of dispatches) {
      results.push(await this.dispatch(dispatch));
    }
    return {
      totalPending: dispatches.length,
      attempted: results.filter((result) => result.outcome === "accepted" || result.reason !== "backing_off").length,
      accepted: results.filter((result) => result.outcome === "accepted").length,
      pending: results.filter((result) => result.outcome === "pending").length,
      blocked: results.filter((result) => result.outcome === "blocked").length,
      results,
    };
  }

  private schedule(delayMs: number): void {
    if (!this.active || this.timer !== undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.inFlight = this.runOnce()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => this.schedule(this.intervalMs));
    }, delayMs);
  }

  private async dispatch(dispatch: PendingMissionDispatch): Promise<MissionDispatchResult> {
    const deferred = this.backoff.get(dispatch.attemptId);
    const nowMs = this.nowMs();
    if (deferred !== undefined && deferred.notBeforeMs > nowMs) {
      return pending(dispatch, "backing_off", deferred.notBeforeMs - nowMs);
    }

    let job: AcceptedExecutionJob;
    try {
      job = parseExecutionJob(dispatch.job);
    } catch (error) {
      return this.block(dispatch, "policy_invalid", { error: errorName(error) });
    }
    if (job.jobId !== dispatch.runnerJobId || job.runId !== dispatch.runId) {
      return this.block(dispatch, "lease_identity_mismatch");
    }

    const existing = await this.acceptExistingLease(dispatch, job);
    if (existing !== undefined) return existing;

    const connection = await this.runners.connectionFor({ tenantId: this.tenantId, runnerId: dispatch.runnerId });
    if (connection === undefined) {
      return this.defer(dispatch, "runner_offline");
    }

    const authorization = this.authorizeConnection(dispatch, job, connection);
    if (authorization !== undefined) return authorization;

    try {
      const lease = await connection.offer(job, dispatch.requiredCapabilities);
      if (lease.jobId !== dispatch.runnerJobId || lease.runId !== dispatch.runId) {
        return this.block(dispatch, "lease_identity_mismatch", { leaseJobId: lease.jobId, leaseRunId: lease.runId });
      }
      return this.accept(dispatch, "accepted", lease);
    } catch (error) {
      const reconciled = await this.acceptExistingLease(dispatch, job);
      if (reconciled !== undefined) return reconciled;
      const code = errorCode(error);
      if (code === "CapabilityMismatch") {
        return this.block(dispatch, "capability_mismatch", errorDetails(error));
      }
      if (code === "LeaseActive") {
        return this.block(dispatch, "dispatch_conflict", { code });
      }
      if (code === "PolicyMissing") {
        return this.block(dispatch, "policy_invalid", { code });
      }
      if (code === "RunIdentityMismatch" || code === "RunLost" || code === "RunCompleted" || code === "RunOwnershipViolation") {
        return this.block(dispatch, "dispatch_conflict", { code });
      }
      return this.defer(dispatch, "runner_unavailable");
    }
  }

  private async acceptExistingLease(
    dispatch: PendingMissionDispatch,
    job: AcceptedExecutionJob,
  ): Promise<MissionDispatchResult | undefined> {
    const lease = await this.leases.lease(dispatch.runId);
    if (lease === undefined) return undefined;
    if (
      lease.job.jobId !== dispatch.runnerJobId ||
      lease.job.runId !== dispatch.runId ||
      lease.owner.runnerId !== dispatch.runnerId ||
      canonicalPayloadHash(lease.job) !== canonicalPayloadHash(job)
    ) {
      return this.block(dispatch, "lease_identity_mismatch");
    }
    if (lease.lostAt !== undefined) {
      return this.block(dispatch, "lease_lost");
    }
    return this.accept(dispatch, "already_active");
  }

  private authorizeConnection(
    dispatch: PendingMissionDispatch,
    job: AcceptedExecutionJob,
    connection: MissionDispatchRunnerConnection,
  ): MissionDispatchResult | undefined {
    const runner = connection.authenticatedRunner;
    if (runner.runnerId !== dispatch.runnerId) {
      return this.block(dispatch, "runner_binding_mismatch", { authenticatedRunnerId: runner.runnerId });
    }
    if (runner.scope.kind !== "tenant" || runner.scope.tenantId !== this.tenantId) {
      return this.block(dispatch, "tenant_scope_mismatch", { scope: runner.scope });
    }
    if (!runner.scope.projectIds.includes(job.projectId)) {
      return this.block(dispatch, "project_scope_mismatch", { projectId: job.projectId });
    }
    const advertised = new Set(runner.capabilities);
    const missingCapabilities = dispatch.requiredCapabilities.filter((capability) => !advertised.has(capability));
    if (missingCapabilities.length > 0) {
      return this.block(dispatch, "capability_mismatch", { missingCapabilities });
    }
    return undefined;
  }

  private async accept(
    dispatch: PendingMissionDispatch,
    status: MissionDispatchAcceptanceReceipt["status"],
    lease?: ExecutionJobLease,
  ): Promise<MissionDispatchResult> {
    const receipt: MissionDispatchAcceptanceReceipt = {
      status,
      jobId: dispatch.runnerJobId,
      runId: dispatch.runId,
      // Derived from the durable outbox row so crash replay uses the same CAS receipt.
      acceptedAt: dispatch.createdAt,
    };
    const accepted = await this.repository.markDispatchAccepted(dispatch.attemptId, receipt, dispatch.version);
    this.backoff.delete(dispatch.attemptId);
    return lease === undefined
      ? { outcome: "accepted", dispatch: accepted, receipt: accepted.receipt }
      : { outcome: "accepted", dispatch: accepted, receipt: accepted.receipt, lease };
  }

  private block(
    dispatch: PendingMissionDispatch,
    reason: MissionDispatchBlockedReason,
    details?: Readonly<Record<string, unknown>>,
  ): MissionDispatchResult {
    const retryAfterMs = this.recordBackoff(dispatch.attemptId);
    return details === undefined
      ? { outcome: "blocked", attemptId: dispatch.attemptId, runnerId: dispatch.runnerId, reason, retryAfterMs }
      : { outcome: "blocked", attemptId: dispatch.attemptId, runnerId: dispatch.runnerId, reason, retryAfterMs, details };
  }

  private defer(dispatch: PendingMissionDispatch, reason: Exclude<MissionDispatchPendingReason, "backing_off">): MissionDispatchResult {
    const retryAfterMs = this.recordBackoff(dispatch.attemptId);
    return pending(dispatch, reason, retryAfterMs);
  }

  private recordBackoff(attemptId: string): number {
    const previous = this.backoff.get(attemptId);
    const failures = (previous?.failures ?? 0) + 1;
    const retryAfterMs = Math.min(this.initialBackoffMs * 2 ** (failures - 1), this.maximumBackoffMs);
    this.backoff.set(attemptId, { failures, notBeforeMs: this.nowMs() + retryAfterMs });
    return retryAfterMs;
  }

  private nowMs(): number {
    const value = Date.parse(this.clock.now());
    if (!Number.isFinite(value)) throw new Error("MissionDispatchLoop clock returned a non-ISO instant");
    return value;
  }
}

function pending(
  dispatch: PendingMissionDispatch,
  reason: MissionDispatchPendingReason,
  retryAfterMs: number,
): MissionDispatchResult {
  return { outcome: "pending", attemptId: dispatch.attemptId, runnerId: dispatch.runnerId, reason, retryAfterMs };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;
}

function errorDetails(error: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof error === "object" && error !== null && typeof (error as { readonly details?: unknown }).details === "object"
    ? (error as { readonly details: Readonly<Record<string, unknown>> }).details
    : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function boundedPositive(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}
