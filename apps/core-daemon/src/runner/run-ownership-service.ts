import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AcceptedExecutionJob,
  ExecutionJobLease,
  TargetRef,
} from "@qualigence/runner-protocol";
import type { AuthenticatedRunnerIdentity } from "@qualigence/grpc-runner-protocol";
import type { ExecutionEventBatch } from "@qualigence/runner-protocol";
import { CoreDaemonError } from "../errors.js";

/** The single Runner that owns a Run, captured at lease grant time. */
export interface LeaseOwner {
  readonly runnerId: string;
  readonly sessionId: string;
}

export type LeaseLostReason = "expired" | "revoked" | "epoch_superseded";

export interface RunOwnershipServiceOptions {
  readonly leaseDurationMs?: number;
  readonly now?: () => number;
  readonly generateToken?: () => string;
  readonly generateRunId?: () => string;
  readonly generateJobId?: () => string;
}

interface OwnershipRecord {
  readonly job: AcceptedExecutionJob;
  readonly owner: LeaseOwner;
  leaseEpoch: number;
  leaseTokenHash: string;
  expiresAtMs: number;
  lost: boolean;
  completed: boolean;
  readonly recoveryOfRunId?: string;
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
 * design §5). The server is the only writer of lease state: it grants a lease
 * bound to `runId + runnerId + sessionId + leaseEpoch`, extends it on renew
 * without changing the epoch, and refuses to transfer a `runId` to a different
 * Runner. A lost run is never re-authorized; recovery always creates a brand new
 * `runId` that records `recoveryOfRunId`. Only the original owning identity may
 * continue to upload already-created Trace for a lost run.
 */
export class RunOwnershipService {
  private readonly records = new Map<string, OwnershipRecord>();
  private readonly leaseDurationMs: number;
  private readonly now: () => number;
  private readonly generateToken: () => string;
  private readonly generateRunId: () => string;
  private readonly generateJobId: () => string;

  constructor(options: RunOwnershipServiceOptions = {}) {
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.generateToken = options.generateToken ?? ((): string => randomBytes(32).toString("base64url"));
    this.generateRunId = options.generateRunId ?? ((): string => randomBytes(16).toString("hex"));
    this.generateJobId = options.generateJobId ?? ((): string => randomBytes(16).toString("hex"));
  }

  /**
   * Grant a fresh, single-owner lease for a job. A run may only ever be granted
   * once; a second grant for the same `runId` is a hard ownership violation.
   */
  grant(job: AcceptedExecutionJob, owner: LeaseOwner): ExecutionJobLease {
    const existing = this.records.get(job.runId);
    if (existing !== undefined) {
      throw new CoreDaemonError(
        "RunOwnershipViolation",
        `run ${job.runId} already has an owner and is never re-granted`,
        { details: { runId: job.runId } },
      );
    }
    const leaseToken = this.generateToken();
    const leaseEpoch = 1;
    const expiresAtMs = this.now() + this.leaseDurationMs;
    this.records.set(job.runId, {
      job,
      owner,
      leaseEpoch,
      leaseTokenHash: hashToken(leaseToken),
      expiresAtMs,
      lost: false,
      completed: false,
    });
    return {
      jobId: job.jobId,
      runId: job.runId,
      leaseToken,
      leaseEpoch,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /**
   * Extend a held lease. Renew keeps the same epoch and only pushes out the
   * conservative deadline. A wrong token, superseded epoch, or a lease that is
   * already lost/expired throws `LeaseLost` rather than silently re-authorizing.
   */
  renew(lease: ExecutionJobLease): ExecutionJobLease {
    const record = this.requireLiveOwnershipForToken(lease);
    record.expiresAtMs = this.now() + this.leaseDurationMs;
    return {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseToken: lease.leaseToken,
      leaseEpoch: record.leaseEpoch,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    };
  }

  /**
   * Complete a run under its lease. A lease that has expired or been lost can
   * never complete a run; the caller receives `LeaseLost` and the server decides
   * recovery from the Trace it already holds.
   */
  complete(lease: ExecutionJobLease): void {
    const record = this.requireLiveOwnershipForToken(lease);
    record.completed = true;
  }

  /** True only while the lease is valid: correct token, current epoch, owned, not lost/expired. */
  mayStartAction(lease: ExecutionJobLease): boolean {
    const record = this.records.get(lease.runId);
    if (record === undefined || record.lost || record.completed) {
      return false;
    }
    if (record.leaseEpoch !== lease.leaseEpoch) {
      return false;
    }
    if (record.expiresAtMs <= this.now()) {
      return false;
    }
    return constantTimeEquals(record.leaseTokenHash, hashToken(lease.leaseToken));
  }

  markLost(runId: string, _reason: LeaseLostReason = "revoked"): void {
    const record = this.records.get(runId);
    if (record !== undefined) {
      record.lost = true;
    }
  }

  /**
   * Create a fresh recovery attempt for a lost run. The recovery is a brand new
   * `runId` that records `recoveryOfRunId`; the original `runId` is marked lost
   * and never re-assigned to any Runner. The new job is returned un-granted so a
   * caller must explicitly re-offer it.
   */
  createRecoveryRun(lostRunId: string): AcceptedExecutionJob {
    const record = this.records.get(lostRunId);
    if (record === undefined) {
      throw new CoreDaemonError("UnknownRun", `run ${lostRunId} is not known`, {
        details: { runId: lostRunId },
      });
    }
    record.lost = true;
    const runId = this.generateRunId();
    const jobId = this.generateJobId();
    const recovery: AcceptedExecutionJob = recoveryJob(record.job, jobId, runId);
    this.records.set(runId, {
      job: recovery,
      owner: record.owner,
      leaseEpoch: 0,
      leaseTokenHash: "",
      expiresAtMs: 0,
      lost: false,
      completed: false,
      recoveryOfRunId: lostRunId,
    });
    return recovery;
  }

  /**
   * Authorize a Trace upload for a run. Only the original owning Runner identity
   * may upload Trace for a run — even after its lease is lost — so a second
   * Runner can never replay or forge Trace for another Runner's run.
   */
  authorizeTraceUpload(identity: AuthenticatedRunnerIdentity, batch: ExecutionEventBatch): void {
    const record = this.records.get(batch.runId);
    if (record === undefined) {
      throw new CoreDaemonError("RunOwnershipViolation", `run ${batch.runId} has no owner`, {
        details: { runId: batch.runId },
      });
    }
    if (!constantTimeEquals(record.owner.runnerId, identity.runnerId)) {
      throw new CoreDaemonError(
        "RunOwnershipViolation",
        `runner ${identity.runnerId} may not upload Trace for run ${batch.runId} owned by ${record.owner.runnerId}`,
        { details: { runId: batch.runId, ownerRunnerId: record.owner.runnerId } },
      );
    }
  }

  ownerOf(runId: string): LeaseOwner | undefined {
    return this.records.get(runId)?.owner;
  }

  recoveryOf(runId: string): string | undefined {
    return this.records.get(runId)?.recoveryOfRunId;
  }

  private requireLiveOwnershipForToken(lease: ExecutionJobLease): OwnershipRecord {
    const record = this.records.get(lease.runId);
    if (record === undefined) {
      throw new CoreDaemonError("LeaseLost", `run ${lease.runId} has no active lease`, {
        details: { runId: lease.runId },
      });
    }
    if (
      record.lost ||
      record.leaseEpoch !== lease.leaseEpoch ||
      !constantTimeEquals(record.leaseTokenHash, hashToken(lease.leaseToken))
    ) {
      throw new CoreDaemonError("LeaseLost", `lease for run ${lease.runId} is no longer valid`, {
        details: { runId: lease.runId },
      });
    }
    if (record.expiresAtMs <= this.now()) {
      record.lost = true;
      throw new CoreDaemonError("LeaseLost", `lease for run ${lease.runId} has expired`, {
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
