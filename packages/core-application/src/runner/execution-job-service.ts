import { randomBytes } from "node:crypto";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
  ExecutionJobLease,
  ExecutionJobOffer,
  RunnerCapabilities,
} from "@qualigence/runner-protocol";
import { negotiateCapabilities } from "@qualigence/runner-protocol";
import { CoreApplicationError } from "./core-runner-protocol-application.js";
import type { LeaseOwner, RunOwnershipService } from "./run-ownership-service.js";

export interface ExecutionJobServiceOptions {
  readonly leaseDurationMs?: number;
  readonly generateOfferId?: () => string;
}

export interface OfferRequest {
  readonly owner: LeaseOwner;
  readonly capabilities: RunnerCapabilities;
  readonly job: AcceptedExecutionJob;
  readonly requiredCapabilities: readonly string[];
}

interface PendingOffer {
  readonly offer: ExecutionJobOffer;
  readonly owner: LeaseOwner;
  lease?: ExecutionJobLease;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;

/**
 * Owns the Offer/accept/renew/complete lifecycle on top of the authoritative
 * {@link RunOwnershipService}. Capability negotiation happens before any Job
 * payload is offered, so a required capability the Runner does not advertise
 * produces an explicit {@link CoreDaemonError} `CapabilityMismatch` rather than a
 * silent downgrade. Accept is idempotent: the same Offer always returns the same
 * Lease.
 */
export class ExecutionJobService {
  private readonly offers = new Map<string, PendingOffer>();
  private readonly completions = new Map<string, ExecutionCompletion>();
  private readonly leaseDurationMs: number;
  private readonly generateOfferId: () => string;

  constructor(
    private readonly ownership: RunOwnershipService,
    options: ExecutionJobServiceOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.generateOfferId = options.generateOfferId ?? ((): string => randomBytes(12).toString("hex"));
  }

  /**
   * Offer a Job to a specific Runner session. Rejects with `CapabilityMismatch`
   * when the Runner does not advertise every required capability; in that case no
   * Offer is stored and no Job payload is exposed.
   */
  offer(request: OfferRequest): ExecutionJobOffer {
    const negotiation = negotiateCapabilities(request.capabilities, request.requiredCapabilities);
    if (negotiation.outcome === "rejected") {
      throw new CoreApplicationError("CapabilityMismatch", "runner is missing required capabilities", {
        details: { missingCapabilities: negotiation.rejection.missingCapabilities },
      });
    }
    const offerId = this.generateOfferId();
    const offer: ExecutionJobOffer = {
      offerId,
      job: request.job,
      requiredCapabilities: [...request.requiredCapabilities],
      leaseDurationMs: this.leaseDurationMs,
    };
    this.offers.set(offerId, { offer, owner: request.owner });
    return offer;
  }

  /** Accept an Offer, granting (or re-returning) its single-owner Lease. */
  accept(offerId: string): ExecutionJobLease {
    const pending = this.offers.get(offerId);
    if (pending === undefined) {
      throw new CoreApplicationError("UnknownOffer", `offer ${offerId} is not known`);
    }
    if (pending.lease !== undefined) {
      return pending.lease;
    }
    const lease = this.ownership.grant(pending.offer.job, pending.owner);
    pending.lease = lease;
    return lease;
  }

  renew(lease: ExecutionJobLease): ExecutionJobLease {
    return this.ownership.renew(lease);
  }

  complete(lease: ExecutionJobLease, completion: ExecutionCompletion): void {
    this.ownership.complete(lease);
    this.completions.set(lease.runId, completion);
  }

  completionOf(runId: string): ExecutionCompletion | undefined {
    return this.completions.get(runId);
  }
}
