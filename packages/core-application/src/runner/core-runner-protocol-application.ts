import type {
  AuthenticatedRunnerContext,
  RunnerProtocolApplication,
} from "@qualigence/runner-control";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
  ExecutionEventAck,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  RunnerHello,
  RunnerWelcome,
} from "@qualigence/runner-protocol";
import type { ExecutionJobService } from "./execution-job-service.js";
import type { RunOwnershipService } from "./run-ownership-service.js";
import type { RunnerSessionService } from "./runner-session-service.js";

export type CoreApplicationErrorCode =
  | "LeaseLost"
  | "CapabilityMismatch"
  | "ProtocolVersionMismatch"
  | "RunnerResumeRejected"
  | "TraceIntegrityViolation"
  | "UnknownSession"
  | "UnknownOffer"
  | "UnknownRun"
  | "RunIdentityMismatch"
  | "RunOwnershipViolation";

export interface CoreApplicationErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class CoreApplicationError extends Error {
  readonly code: CoreApplicationErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: CoreApplicationErrorCode, message: string, options: CoreApplicationErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CoreApplicationError";
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isCoreApplicationError(value: unknown): value is CoreApplicationError {
  return value instanceof CoreApplicationError;
}

export interface CoreRunnerProtocolApplicationOptions {
  readonly sessions: RunnerSessionService;
  readonly jobs: ExecutionJobService;
  readonly ownership: RunOwnershipService;
  readonly recordRun?: (job: AcceptedExecutionJob) => Promise<void>;
}

interface CanonicalOffer {
  readonly canonical: string;
  readonly sessionId: string;
  readonly offer: ExecutionJobOffer;
}

export class CoreRunnerProtocolApplication implements RunnerProtocolApplication {
  readonly sessions: RunnerSessionService;
  readonly jobs: ExecutionJobService;
  readonly ownership: RunOwnershipService;
  private readonly recordRun: ((job: AcceptedExecutionJob) => Promise<void>) | undefined;
  private readonly offersByJob = new Map<string, CanonicalOffer>();
  private readonly offersByRun = new Map<string, CanonicalOffer>();
  private processing: Promise<void> = Promise.resolve();

  constructor(options: CoreRunnerProtocolApplicationOptions) {
    this.sessions = options.sessions;
    this.jobs = options.jobs;
    this.ownership = options.ownership;
    this.recordRun = options.recordRun;
  }

  openSession(
    hello: RunnerHello,
    identity: AuthenticatedRunnerContext,
  ): Promise<RunnerWelcome> {
    return this.serialize(() => this.sessions.register(hello, identity));
  }

  createOffer(
    sessionId: string,
    job: AcceptedExecutionJob,
    requirements: readonly string[],
  ): Promise<ExecutionJobOffer> {
    return this.serialize(() => this.createOfferSerialized(sessionId, job, requirements));
  }

  accept(sessionId: string, offerId: string): Promise<ExecutionJobLease> {
    return this.serialize(async () => {
      this.requireSession(sessionId);
      const lease = this.jobs.accept(offerId);
      const offered = this.offersByRun.get(lease.runId);
      if (offered !== undefined) {
        await this.recordRun?.(offered.offer.job);
      }
      return lease;
    });
  }

  renew(sessionId: string, lease: ExecutionJobLease): Promise<ExecutionJobLease> {
    return this.serialize(() => {
      this.requireOwner(sessionId, lease.runId);
      return this.jobs.renew(lease);
    });
  }

  ingest(sessionId: string, batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    return this.serialize(() => this.sessions.ingest(sessionId, batch));
  }

  complete(
    sessionId: string,
    lease: ExecutionJobLease,
    completion: ExecutionCompletion,
  ): Promise<void> {
    return this.serialize(() => {
      this.requireOwner(sessionId, lease.runId);
      const held = this.jobs.leaseOf(lease.runId);
      if (held === undefined) {
        throw new CoreApplicationError("LeaseLost", `run ${lease.runId} has no accepted lease`);
      }
      this.jobs.complete(held, completion);
    });
  }

  closeSession(sessionId: string): Promise<void> {
    return this.serialize(() => {
      this.sessions.closeSession(sessionId);
    });
  }

  private createOfferSerialized(
    sessionId: string,
    job: AcceptedExecutionJob,
    requirements: readonly string[],
  ): ExecutionJobOffer {
    const session = this.requireSession(sessionId);
    const canonical = canonicalPayloadHash({ job, requirements: [...requirements] });
    const byJob = this.offersByJob.get(job.jobId);
    const byRun = this.offersByRun.get(job.runId);
    if (byJob !== undefined || byRun !== undefined) {
      if (
        byJob === undefined ||
        byRun === undefined ||
        byJob !== byRun ||
        byJob.canonical !== canonical ||
        byJob.sessionId !== sessionId
      ) {
        throw new CoreApplicationError(
          "RunIdentityMismatch",
          `job ${job.jobId} or run ${job.runId} was replayed with different content`,
        );
      }
      return byJob.offer;
    }

    const offer = this.jobs.offer({
      owner: { runnerId: session.identity.runnerId, sessionId },
      capabilities: session.capabilities,
      job,
      requiredCapabilities: requirements,
    });
    const record: CanonicalOffer = { canonical, sessionId, offer };
    this.offersByJob.set(job.jobId, record);
    this.offersByRun.set(job.runId, record);
    return offer;
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.session(sessionId);
    if (session === undefined) {
      throw new CoreApplicationError("UnknownSession", `session ${sessionId} is not known`);
    }
    return session;
  }

  private requireOwner(sessionId: string, runId: string): void {
    const session = this.requireSession(sessionId);
    const owner = this.ownership.ownerOf(runId);
    if (
      owner === undefined ||
      owner.sessionId !== sessionId ||
      owner.runnerId !== session.identity.runnerId
    ) {
      throw new CoreApplicationError("LeaseLost", `session ${sessionId} does not own run ${runId}`);
    }
  }

  private serialize<TResult>(operation: () => Promise<TResult> | TResult): Promise<TResult> {
    const result = this.processing.then(operation);
    this.processing = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
