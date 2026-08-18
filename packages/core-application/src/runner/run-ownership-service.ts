import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  canonicalPayloadHash,
  type AcceptedExecutionJob,
  type ExecutionCompletion,
  type ExecutionEventBatch,
  type ExecutionJobLease,
  type TargetRef,
} from "@qualigence/runner-protocol";
import type {
  AuthenticatedRunnerContext,
  PersistedExecutionLease,
  PersistedLeaseOwner,
  RunnerControlIntegrityEventSink,
  RunnerControlStore,
} from "@qualigence/runner-control";
import { CoreApplicationError } from "./core-runner-protocol-application.js";

export type LeaseOwner = PersistedLeaseOwner;

export type LeaseLostReason = "expired" | "revoked" | "epoch_superseded";

export interface RunOwnershipServiceOptions {
  readonly store: RunnerControlStore;
  /**
   * Required integrity-event sink; production wires a structured logger. An
   * event is emitted when a completion is rejected because a different terminal
   * result is already stored for the run.
   */
  readonly integrityEvents: RunnerControlIntegrityEventSink;
  readonly leaseDurationMs?: number;
  readonly now?: () => number;
  readonly generateToken?: () => string;
  readonly generateRunId?: () => string;
  readonly generateJobId?: () => string;
}

export interface RecoveredRun {
  readonly job: AcceptedExecutionJob;
  /** The lost runId this recovery run inherits the execution from. */
  readonly recoveryOfRunId: string;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * The authoritative single-owner lease and run-ownership state machine (LS-05
 * design §5). The persistent store is the only writer of lease state: it grants
 * a lease bound to `runId + runnerId + sessionId + leaseEpoch`, extends it on
 * renew without changing the epoch, and refuses to transfer a `runId` to a
 * different Runner. A lost run is never re-authorized; recovery always creates a
 * brand new `runId` that records `recoveryOfRunId`.
 */
export class RunOwnershipService {
  private readonly store: RunnerControlStore;
  private readonly integrityEvents: RunnerControlIntegrityEventSink;
  private readonly leaseDurationMs: number;
  private readonly now: () => number;
  private readonly generateToken: () => string;
  private readonly generateRunId: () => string;
  private readonly generateJobId: () => string;

  constructor(options: RunOwnershipServiceOptions) {
    this.store = options.store;
    this.integrityEvents = options.integrityEvents;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.generateToken = options.generateToken ?? ((): string => randomBytes(32).toString("base64url"));
    this.generateRunId = options.generateRunId ?? ((): string => randomBytes(16).toString("hex"));
    this.generateJobId = options.generateJobId ?? ((): string => randomBytes(16).toString("hex"));
  }

  async grant(
    job: AcceptedExecutionJob,
    owner: LeaseOwner,
    recoveryOfRunId?: string,
  ): Promise<ExecutionJobLease> {
    const leaseToken = this.generateToken();
    const leaseEpoch = 1;
    const expiresAt = new Date(this.now() + this.leaseDurationMs).toISOString();
    const outcome = await this.store.grantLease({
      job,
      owner,
      leaseEpoch,
      leaseTokenHash: hashToken(leaseToken),
      expiresAt,
      ...(recoveryOfRunId === undefined ? {} : { recoveryOfRunId }),
    });
    if (outcome === "already_exists") {
      throw new CoreApplicationError(
        "RunOwnershipViolation",
        `run ${job.runId} already has an owner and is never re-granted`,
        { details: { runId: job.runId } },
      );
    }
    return {
      jobId: job.jobId,
      runId: job.runId,
      leaseToken,
      leaseEpoch,
      expiresAt,
    };
  }

  async renew(lease: ExecutionJobLease): Promise<ExecutionJobLease> {
    const record = await this.requireLiveLease(lease);
    const newExpiresAt = new Date(this.now() + this.leaseDurationMs).toISOString();
    const renewed = await this.store.renewLease({
      runId: lease.runId,
      jobId: lease.jobId,
      owner: record.owner,
      leaseEpoch: lease.leaseEpoch,
      leaseTokenHash: hashToken(lease.leaseToken),
      checkedAt: new Date(this.now()).toISOString(),
      newExpiresAt,
    });
    if (!renewed) {
      throw new CoreApplicationError("LeaseLost", `lease for run ${lease.runId} is no longer valid`, {
        details: { runId: lease.runId },
      });
    }
    return {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseToken: lease.leaseToken,
      leaseEpoch: record.leaseEpoch,
      expiresAt: newExpiresAt,
    };
  }

  async complete(lease: ExecutionJobLease, completion: ExecutionCompletion): Promise<void> {
    const record = await this.requireMatchingLease(lease);
    await this.completeAgainst(record, completion);
  }

  /**
   * Complete a run using the stored lease as authority, without presenting the
   * raw lease token. This is the resumed-connection path: the gRPC server never
   * saw the lease on this connection (it was accepted or renewed on a
   * pre-disconnect connection or a previous Core process), so the session-owner
   * check is the gate and the persisted lease binding is what is written. A run
   * with no stored lease or a lost lease is refused exactly like
   * {@link complete}.
   */
  async completeStored(runId: string, completion: ExecutionCompletion): Promise<void> {
    const record = await this.store.lease(runId);
    const nowIso = new Date(this.now()).toISOString();
    if (record === undefined) {
      throw new CoreApplicationError("LeaseLost", `run ${runId} has no active lease`, {
        details: { runId },
      });
    }
    if (record.completedAt !== undefined) {
      await this.completeAgainst(record, completion, nowIso);
      return;
    }
    if (record.lostAt !== undefined) {
      throw new CoreApplicationError("LeaseLost", `run ${runId} has no active lease`, {
        details: { runId },
      });
    }
    if (record.expiresAt <= nowIso) {
      if (!await this.store.markLeaseLost(runId, nowIso)) {
        const latest = await this.store.lease(runId);
        if (latest?.completedAt !== undefined) {
          await this.completeAgainst(latest, completion, nowIso);
          return;
        }
      }
      throw new CoreApplicationError("LeaseLost", `lease for run ${runId} has expired`, {
        details: { runId },
      });
    }
    await this.completeAgainst(record, completion, nowIso);
  }

  private async completeAgainst(
    record: PersistedExecutionLease,
    completion: ExecutionCompletion,
    checkedAt = new Date(this.now()).toISOString(),
  ): Promise<void> {
    const outcome = await this.store.completeLease({
      runId: record.job.runId,
      jobId: record.job.jobId,
      owner: record.owner,
      leaseEpoch: record.leaseEpoch,
      leaseTokenHash: record.leaseTokenHash,
      checkedAt,
      completion,
    });
    if (outcome.outcome === "completion_conflict") {
      this.integrityEvents.emit({
        kind: "completion_conflict",
        runId: record.job.runId,
        leaseTokenHash: record.leaseTokenHash,
        presentedCompletionHash: canonicalPayloadHash(completion),
        storedCompletionHash: canonicalPayloadHash(outcome.storedCompletion),
        observedAt: checkedAt,
      });
      throw new CoreApplicationError(
        "RunOwnershipViolation",
        `completion for run ${record.job.runId} conflicts with the stored terminal result`,
        { details: { runId: record.job.runId } },
      );
    }
    if (outcome.outcome === "rejected") {
      // The atomic completion decision observed no valid-bound terminal
      // conflict, so this is lost authority rather than an integrity event.
      throw new CoreApplicationError(
        "LeaseLost",
        `lease for run ${record.job.runId} no longer authorizes completion`,
        { details: { runId: record.job.runId } },
      );
    }
  }

  async mayStartAction(lease: ExecutionJobLease): Promise<boolean> {
    const record = await this.store.lease(lease.runId);
    if (record === undefined || record.lostAt !== undefined || record.completedAt !== undefined) {
      return false;
    }
    if (record.leaseEpoch !== lease.leaseEpoch) {
      return false;
    }
    if (record.expiresAt <= new Date(this.now()).toISOString()) {
      return false;
    }
    return constantTimeEquals(record.leaseTokenHash, hashToken(lease.leaseToken));
  }

  async markLost(runId: string, _reason: LeaseLostReason = "revoked"): Promise<void> {
    await this.store.markLeaseLost(runId, new Date(this.now()).toISOString());
  }

  /**
   * Recover a lost run under a brand-new runId. The prior runId is never
   * re-authorized: only an expired lease or an explicitly revoked one may be
   * recovered, a live lease rejects recovery with `LeaseActive`, and a
   * completed run rejects it with `RunCompleted` so a terminal result is never
   * executed a second time. The lineage is returned to the caller, flows
   * through {@link ExecutionJobService.offer} into the recovered grant, and is
   * then persisted on the new lease row.
   */
  async createRecoveryRun(lostRunId: string): Promise<RecoveredRun> {
    const record = await this.store.lease(lostRunId);
    if (record === undefined) {
      throw new CoreApplicationError("UnknownRun", `run ${lostRunId} is not known`, {
        details: { runId: lostRunId },
      });
    }
    if (record.completedAt !== undefined) {
      throw new CoreApplicationError(
        "RunCompleted",
        `run ${lostRunId} already completed and is never recovered`,
        { details: { runId: lostRunId } },
      );
    }
    const nowIso = new Date(this.now()).toISOString();
    if (record.lostAt === undefined && record.expiresAt > nowIso) {
      throw new CoreApplicationError(
        "LeaseActive",
        `run ${lostRunId} still has a live lease; recover only after expiry or an explicit revoke`,
        { details: { runId: lostRunId } },
      );
    }
    if (record.lostAt === undefined) {
      await this.store.markLeaseLost(lostRunId, nowIso);
    }
    const runId = this.generateRunId();
    const jobId = this.generateJobId();
    return { job: recoveryJob(record.job, jobId, runId), recoveryOfRunId: lostRunId };
  }

  async authorizeTraceUpload(identity: AuthenticatedRunnerContext, batch: ExecutionEventBatch): Promise<void> {
    const record = await this.store.lease(batch.runId);
    if (record === undefined) {
      throw new CoreApplicationError("RunOwnershipViolation", `run ${batch.runId} has no owner`, {
        details: { runId: batch.runId },
      });
    }
    if (!constantTimeEquals(record.owner.runnerId, identity.runnerId)) {
      throw new CoreApplicationError(
        "RunOwnershipViolation",
        `runner ${identity.runnerId} may not upload Trace for run ${batch.runId} owned by ${record.owner.runnerId}`,
        { details: { runId: batch.runId, ownerRunnerId: record.owner.runnerId } },
      );
    }
  }

  async ownerOf(runId: string): Promise<LeaseOwner | undefined> {
    return (await this.store.lease(runId))?.owner;
  }

  async recoveryOf(runId: string): Promise<string | undefined> {
    return (await this.store.lease(runId))?.recoveryOfRunId;
  }

  async completionOf(runId: string): Promise<ExecutionCompletion | undefined> {
    return this.store.completion(runId);
  }

  private async requireLiveLease(lease: ExecutionJobLease) {
    const record = await this.requireMatchingLease(lease);
    if (record.completedAt !== undefined) {
      throw new CoreApplicationError("LeaseLost", `lease for run ${lease.runId} is completed`, {
        details: { runId: lease.runId },
      });
    }
    return record;
  }

  private async requireMatchingLease(lease: ExecutionJobLease) {
    const record = await this.store.lease(lease.runId);
    if (record === undefined) {
      throw new CoreApplicationError("LeaseLost", `run ${lease.runId} has no active lease`, {
        details: { runId: lease.runId },
      });
    }
    if (
      record.lostAt !== undefined ||
      record.leaseEpoch !== lease.leaseEpoch ||
      !constantTimeEquals(record.leaseTokenHash, hashToken(lease.leaseToken))
    ) {
      throw new CoreApplicationError("LeaseLost", `lease for run ${lease.runId} is no longer valid`, {
        details: { runId: lease.runId },
      });
    }
    if (record.completedAt !== undefined) {
      return record;
    }
    if (record.expiresAt <= new Date(this.now()).toISOString()) {
      await this.store.markLeaseLost(lease.runId, new Date(this.now()).toISOString());
      throw new CoreApplicationError("LeaseLost", `lease for run ${lease.runId} has expired`, {
        details: { runId: lease.runId },
      });
    }
    return record;
  }
}

function recoveryJob(
  original: AcceptedExecutionJob,
  jobId: string,
  runId: string,
): AcceptedExecutionJob {
  const target: TargetRef = original.target;
  const base: AcceptedExecutionJob = {
    jobId,
    runId,
    target,
    objective: original.objective,
  };
  return original.plan === undefined ? base : { ...base, plan: original.plan };
}
