import { randomBytes } from "node:crypto";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
  ExecutionJobLease,
  ExecutionJobOffer,
  RunnerCapabilities,
} from "@qualigence/runner-protocol";
import { negotiateCapabilities } from "@qualigence/runner-protocol";
import type { RunnerControlStore } from "@qualigence/runner-control";
import { CoreApplicationError } from "./core-runner-protocol-application.js";
import type { LeaseOwner, RunCompletionDisposition, RunOwnershipService } from "./run-ownership-service.js";

export interface ExecutionJobServiceOptions {
  readonly store: RunnerControlStore;
  readonly leaseDurationMs?: number;
  readonly now?: () => number;
  readonly generateOfferId?: () => string;
}

export interface OfferRequest {
  readonly owner: LeaseOwner;
  readonly capabilities: RunnerCapabilities;
  readonly job: AcceptedExecutionJob;
  readonly requiredCapabilities: readonly string[];
  /** The lost runId this job's new runId recovers; persisted on the grant. */
  readonly recoveryOfRunId?: string;
}

interface PendingOffer {
  readonly offer: ExecutionJobOffer;
  readonly owner: LeaseOwner;
  readonly recoveryOfRunId?: string;
  lease?: ExecutionJobLease;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;

/**
 * Owns the Offer/accept/renew/complete lifecycle on top of the authoritative
 * {@link RunOwnershipService}. Capability negotiation happens before any Job
 * payload is offered, so a required capability the Runner does not advertise
 * produces an explicit {@link CoreApplicationError} `CapabilityMismatch` rather
 * than a silent downgrade. Accept is idempotent: the same Offer always returns
 * the same Lease. An Offer for a runId that already holds durable lease state is
 * refused before any payload is exposed: a completed run is never executed
 * again, a lost run is never re-authorized under its old runId, and a live
 * unexpired lease is left to its owner to renew or complete. Only an expired
 * never-completed lease is recovered, under a brand-new runId that records its
 * lineage.
 */
export class ExecutionJobService {
  private readonly offers = new Map<string, PendingOffer>();
  private readonly store: RunnerControlStore;
  private readonly leaseDurationMs: number;
  private readonly now: () => number;
  private readonly generateOfferId: () => string;

  constructor(
    private readonly ownership: RunOwnershipService,
    options: ExecutionJobServiceOptions,
  ) {
    this.store = options.store;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.generateOfferId = options.generateOfferId ?? ((): string => randomBytes(12).toString("hex"));
  }

  /**
   * Offer a Job to a specific Runner session. Rejects with `CapabilityMismatch`
   * when the Runner does not advertise every required capability; in that case no
   * Offer is stored and no Job payload is exposed.
   */
  async offer(request: OfferRequest): Promise<ExecutionJobOffer> {
    const negotiation = negotiateCapabilities(request.capabilities, request.requiredCapabilities);
    if (negotiation.outcome === "rejected") {
      throw new CoreApplicationError("CapabilityMismatch", "runner is missing required capabilities", {
        details: { missingCapabilities: negotiation.rejection.missingCapabilities },
      });
    }
    const pendingOffer = await this.resolveRecovery(request);
    const offerId = this.generateOfferId();
    const offer: ExecutionJobOffer = {
      offerId,
      job: pendingOffer.job,
      requiredCapabilities: [...request.requiredCapabilities],
      leaseDurationMs: this.leaseDurationMs,
    };
    this.offers.set(offerId, {
      offer,
      owner: request.owner,
      ...(pendingOffer.recoveryOfRunId === undefined ? {} : { recoveryOfRunId: pendingOffer.recoveryOfRunId }),
    });
    return offer;
  }

  /** Accept an Offer, granting (or re-returning) its single-owner Lease. */
  async accept(offerId: string): Promise<ExecutionJobLease> {
    const pending = this.offers.get(offerId);
    if (pending === undefined) {
      throw new CoreApplicationError("UnknownOffer", `offer ${offerId} is not known`);
    }
    if (pending.lease !== undefined) {
      return pending.lease;
    }
    const lease = await this.ownership.grant(
      pending.offer.job,
      pending.owner,
      pending.recoveryOfRunId,
    );
    pending.lease = lease;
    return lease;
  }

  async renew(lease: ExecutionJobLease): Promise<ExecutionJobLease> {
    return this.ownership.renew(lease);
  }

  async complete(lease: ExecutionJobLease, completion: ExecutionCompletion): Promise<RunCompletionDisposition> {
    return this.ownership.complete(lease, completion);
  }

  async completionOf(runId: string): Promise<ExecutionCompletion | undefined> {
    return this.ownership.completionOf(runId);
  }

  leaseOf(runId: string): ExecutionJobLease | undefined {
    for (const pending of this.offers.values()) {
      if (pending.lease?.runId === runId) return pending.lease;
    }
    return undefined;
  }

  /**
   * Refuse Offers whose runId already carries durable lease state, and recover
   * a run whose lease expired without a terminal result. Raw lease tokens are
   * never persisted, so a crashed accept can never be replayed: after the
   * expiry of the unreachable lease, the run is marked lost and re-offered
   * under a fresh runId that records the lineage.
   */
  private async resolveRecovery(request: OfferRequest): Promise<OfferRequest> {
    const stored = await this.store.lease(request.job.runId);
    if (stored === undefined) {
      return request;
    }
    if (stored.lostAt !== undefined) {
      throw new CoreApplicationError(
        "RunLost",
        `run ${request.job.runId} is lost and is never re-offered`,
        {
          details: {
            runId: request.job.runId,
            ...(stored.recoveryOfRunId === undefined ? {} : { recoveryOfRunId: stored.recoveryOfRunId }),
          },
        },
      );
    }
    if (stored.completedAt !== undefined) {
      throw new CoreApplicationError(
        "RunCompleted",
        `run ${request.job.runId} already completed and is never re-offered`,
        { details: { runId: request.job.runId } },
      );
    }
    const nowIso = new Date(this.now()).toISOString();
    if (stored.expiresAt > nowIso) {
      throw new CoreApplicationError(
        "LeaseActive",
        `run ${request.job.runId} already has a live lease; its owner must renew or complete it`,
        { details: { runId: request.job.runId } },
      );
    }
    const recovered = await this.ownership.createRecoveryRun(request.job.runId);
    return { ...request, job: recovered.job, recoveryOfRunId: recovered.recoveryOfRunId };
  }
}
