import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
  ExecutionEventBatch,
  ExecutionJobLease,
  TargetRef,
} from "@qualigence/runner-protocol";
import type {
  AuthenticatedRunnerContext,
  PersistedLeaseOwner,
  RunnerControlStore,
} from "@qualigence/runner-control";
import { CoreApplicationError } from "./core-runner-protocol-application.js";

export type LeaseOwner = PersistedLeaseOwner;

export type LeaseLostReason = "expired" | "revoked" | "epoch_superseded";

export interface RunOwnershipServiceOptions {
  readonly store: RunnerControlStore;
  readonly leaseDurationMs?: number;
  readonly now?: () => number;
  readonly generateToken?: () => string;
  readonly generateRunId?: () => string;
  readonly generateJobId?: () => string;
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
  private readonly pendingRecoveryOf = new Map<string, string>();
  private readonly leaseDurationMs: number;
  private readonly now: () => number;
  private readonly generateToken: () => string;
  private readonly generateRunId: () => string;
  private readonly generateJobId: () => string;

  constructor(options: RunOwnershipServiceOptions) {
    this.store = options.store;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.generateToken = options.generateToken ?? ((): string => randomBytes(32).toString("base64url"));
    this.generateRunId = options.generateRunId ?? ((): string => randomBytes(16).toString("hex"));
    this.generateJobId = options.generateJobId ?? ((): string => randomBytes(16).toString("hex"));
  }

  async grant(job: AcceptedExecutionJob, owner: LeaseOwner): Promise<ExecutionJobLease> {
    const leaseToken = this.generateToken();
    const leaseEpoch = 1;
    const expiresAt = new Date(this.now() + this.leaseDurationMs).toISOString();
    const recoveryOfRunId = this.pendingRecoveryOf.get(job.runId);
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
    this.pendingRecoveryOf.delete(job.runId);
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
    const outcome = await this.store.completeLease({
      runId: lease.runId,
      jobId: lease.jobId,
      owner: record.owner,
      leaseEpoch: lease.leaseEpoch,
      leaseTokenHash: hashToken(lease.leaseToken),
      checkedAt: new Date(this.now()).toISOString(),
      completion,
    });
    if (outcome === "rejected") {
      throw new CoreApplicationError(
        "RunOwnershipViolation",
        `completion for run ${lease.runId} conflicts with the stored terminal result`,
        { details: { runId: lease.runId } },
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

  async createRecoveryRun(lostRunId: string): Promise<AcceptedExecutionJob> {
    const record = await this.store.lease(lostRunId);
    if (record === undefined) {
      throw new CoreApplicationError("UnknownRun", `run ${lostRunId} is not known`, {
        details: { runId: lostRunId },
      });
    }
    await this.store.markLeaseLost(lostRunId, new Date(this.now()).toISOString());
    const runId = this.generateRunId();
    const jobId = this.generateJobId();
    this.pendingRecoveryOf.set(runId, lostRunId);
    return recoveryJob(record.job, jobId, runId);
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
    return this.pendingRecoveryOf.get(runId) ?? (await this.store.lease(runId))?.recoveryOfRunId;
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
