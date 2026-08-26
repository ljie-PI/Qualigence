import type {
  AcceptedMissionDispatch,
  BlockedMissionDispatch,
  MissionDispatchAcceptanceReceipt,
  PendingMissionDispatch,
  PrdMissionRepository,
} from "@qualigence/mission";
import { validateApprovedExecutionPolicy } from "@qualigence/mission";
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
  | "acceptance_persistence_failed"
  | "block_persistence_failed"
  | "cancelled"
  | "deadline_exceeded"
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
      readonly dispatch: BlockedMissionDispatch;
      readonly attemptId: string;
      readonly runnerId: string;
      readonly reason: MissionDispatchBlockedReason;
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
  readonly repository: Pick<PrdMissionRepository, "pendingDispatches" | "markDispatchAccepted"> & {
    readonly markDispatchBlocked: NonNullable<PrdMissionRepository["markDispatchBlocked"]>;
  };
  readonly runners: MissionDispatchRunnerDirectory;
  readonly leases: MissionDispatchLeaseReader;
  readonly clock: Clock;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: string;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly initialBackoffMs?: number;
  readonly maximumBackoffMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly onError?: (error: unknown) => void;
}

export interface MissionDispatchLoopReadiness {
  readonly status: "ready" | "not-ready";
  readonly active: boolean;
  readonly aborted: boolean;
  readonly inFlight: boolean;
  readonly consecutiveFailures: number;
  readonly lastSuccessfulObservationAt?: string;
  readonly lastError?: string;
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
  private readonly signal: AbortSignal | undefined;
  private readonly deadlineAtMs: number | undefined;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maximumBackoffMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly backoff = new Map<string, BackoffState>();
  private readonly onError: (error: unknown) => void;
  private timer: unknown;
  private active = false;
  private inFlight: Promise<void> = Promise.resolve();
  private inFlightActive = false;
  private consecutiveFailures = 0;
  private lastSuccessfulObservationAt: string | undefined;
  private lastError: string | undefined;

  constructor(options: MissionDispatchLoopOptions) {
    this.tenantId = nonEmpty(options.tenantId, "tenantId");
    this.repository = options.repository;
    this.runners = options.runners;
    this.leases = options.leases;
    this.clock = options.clock;
    this.signal = options.signal;
    this.deadlineAtMs = options.deadlineAt === undefined ? undefined : parseDeadline(options.deadlineAt);
    this.batchSize = boundedPositive(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize", 256);
    this.intervalMs = boundedPositive(options.intervalMs ?? DEFAULT_INTERVAL_MS, "intervalMs", 60_000);
    this.initialBackoffMs = boundedPositive(options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS, "initialBackoffMs", 60_000);
    this.maximumBackoffMs = boundedPositive(options.maximumBackoffMs ?? DEFAULT_MAXIMUM_BACKOFF_MS, "maximumBackoffMs", 300_000);
    if (this.initialBackoffMs > this.maximumBackoffMs) {
      throw new Error("initialBackoffMs must be less than or equal to maximumBackoffMs");
    }
    this.setTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.lastSuccessfulObservationAt = undefined;
    this.lastError = undefined;
    this.consecutiveFailures = 0;
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

  readiness(): MissionDispatchLoopReadiness {
    const aborted = this.signal?.aborted === true;
    const status = this.active && !aborted && this.lastSuccessfulObservationAt !== undefined && this.lastError === undefined ? "ready" : "not-ready";
    return {
      status,
      active: this.active,
      aborted,
      inFlight: this.inFlightActive,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.lastSuccessfulObservationAt === undefined ? {} : { lastSuccessfulObservationAt: this.lastSuccessfulObservationAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  async runOnce(): Promise<MissionDispatchCycleResult> {
    const dispatches = await this.repository.pendingDispatches(this.batchSize);
    const results: MissionDispatchResult[] = [];
    for (const dispatch of dispatches) {
      const stopped = this.preOfferStopped(dispatch);
      if (stopped !== undefined) {
        results.push(stopped);
        continue;
      }
      results.push(await this.dispatch(dispatch));
    }
    const summary = {
      totalPending: dispatches.length,
      attempted: results.filter((result) => result.outcome === "accepted" || result.reason !== "backing_off").length,
      accepted: results.filter((result) => result.outcome === "accepted").length,
      pending: results.filter((result) => result.outcome === "pending").length,
      blocked: results.filter((result) => result.outcome === "blocked").length,
      results,
    };
    this.recordSuccessfulObservation();
    return summary;
  }

  private schedule(delayMs: number): void {
    if (!this.active || this.timer !== undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.inFlightActive = true;
      this.inFlight = this.runOnce()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.consecutiveFailures += 1;
          this.lastError = errorMessage(error);
          this.onError(error);
        })
        .finally(() => {
          this.inFlightActive = false;
          this.schedule(this.intervalMs);
        });
    }, delayMs);
  }

  private recordSuccessfulObservation(): void {
    this.lastSuccessfulObservationAt = this.clock.now();
    this.consecutiveFailures = 0;
    this.lastError = undefined;
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
    try {
      validateApprovedExecutionPolicy(job.policy, job.plan?.budget.maximumWallClockMs ?? 0);
    } catch (error) {
      return this.block(dispatch, "policy_invalid", { error: errorMessage(error) });
    }

    const existing = await this.acceptExistingLease(dispatch, job);
    if (existing !== undefined) return existing;

    if (Date.parse(job.policy.expiresAt) <= nowMs) {
      return this.block(dispatch, "policy_invalid", { error: "Execution policy is expired." });
    }

    const connection = await this.runners.connectionFor({ tenantId: this.tenantId, runnerId: dispatch.runnerId });
    if (connection === undefined) {
      return this.defer(dispatch, "runner_offline");
    }

    const authorization = await this.authorizeConnection(dispatch, job, connection);
    if (authorization !== undefined) return authorization;
    const stopped = this.preOfferStopped(dispatch);
    if (stopped !== undefined) return stopped;

    try {
      const lease = await connection.offer(job, dispatch.requiredCapabilities);
      if (lease.jobId !== dispatch.runnerJobId || lease.runId !== dispatch.runId) {
        return this.block(dispatch, "lease_identity_mismatch", { leaseJobId: lease.jobId, leaseRunId: lease.runId });
      }
      return this.accept(dispatch, "accepted", lease);
    } catch (error) {
      const reconciled = await this.acceptExistingLease(dispatch, job).catch(() => undefined);
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

  private async authorizeConnection(
    dispatch: PendingMissionDispatch,
    job: AcceptedExecutionJob,
    connection: MissionDispatchRunnerConnection,
  ): Promise<MissionDispatchResult | undefined> {
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
    let accepted: AcceptedMissionDispatch;
    try {
      accepted = await this.repository.markDispatchAccepted(dispatch.attemptId, receipt, dispatch.version);
    } catch {
      return this.acceptancePersistenceFailed(dispatch);
    }
    this.backoff.delete(dispatch.attemptId);
    return lease === undefined
      ? { outcome: "accepted", dispatch: accepted, receipt: accepted.receipt }
      : { outcome: "accepted", dispatch: accepted, receipt: accepted.receipt, lease };
  }

  private async block(
    dispatch: PendingMissionDispatch,
    reason: MissionDispatchBlockedReason,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<MissionDispatchResult> {
    try {
      const blocked = await this.repository.markDispatchBlocked(dispatch.attemptId, dispatch.version);
      this.backoff.delete(dispatch.attemptId);
      return details === undefined
        ? { outcome: "blocked", dispatch: blocked, attemptId: dispatch.attemptId, runnerId: dispatch.runnerId, reason }
        : { outcome: "blocked", dispatch: blocked, attemptId: dispatch.attemptId, runnerId: dispatch.runnerId, reason, details };
    } catch (error) {
      const code = errorCode(error);
      if (code === "MissionDispatchVersionConflict" || code === "MissionDispatchReceiptConflict") {
        const job = await this.safeParseJob(dispatch);
        if (job !== undefined) {
          const accepted = await this.acceptExistingLease(dispatch, job).catch(() => undefined);
          if (accepted !== undefined) return accepted;
        }
      }
      return this.defer(dispatch, "block_persistence_failed");
    }
  }

  private preOfferStopped(dispatch: PendingMissionDispatch): MissionDispatchResult | undefined {
    if (this.signal?.aborted === true) {
      return pending(dispatch, "cancelled", 0);
    }
    if (this.deadlineAtMs !== undefined && this.nowMs() >= this.deadlineAtMs) {
      const retryAfterMs = this.recordBackoff(dispatch.attemptId);
      return pending(dispatch, "deadline_exceeded", retryAfterMs);
    }
    return undefined;
  }

  private async safeParseJob(dispatch: PendingMissionDispatch): Promise<AcceptedExecutionJob | undefined> {
    try {
      return parseExecutionJob(dispatch.job);
    } catch {
      return undefined;
    }
  }

  private defer(dispatch: PendingMissionDispatch, reason: Exclude<MissionDispatchPendingReason, "backing_off" | "cancelled">): MissionDispatchResult {
    const retryAfterMs = this.recordBackoff(dispatch.attemptId);
    return pending(dispatch, reason, retryAfterMs);
  }

  private acceptancePersistenceFailed(dispatch: PendingMissionDispatch): MissionDispatchResult {
    const retryAfterMs = this.recordBackoff(dispatch.attemptId);
    return pending(dispatch, "acceptance_persistence_failed", retryAfterMs);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDeadline(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("deadlineAt must be a canonical ISO instant");
  }
  return milliseconds;
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
