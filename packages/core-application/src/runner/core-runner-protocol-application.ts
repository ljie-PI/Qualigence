import type {
  AuthenticatedRunnerContext,
  RunnerProtocolApplication,
} from "@qualigence/runner-control";
import { ArtifactUploadError, type ArtifactUploadService } from "@qualigence/evidence";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import type {
  AcceptedExecutionJob,
  ArtifactChunkUpload,
  ArtifactManifestRegistration,
  ArtifactUploadAck,
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
  | "RunLost"
  | "RunCompleted"
  | "LeaseActive"
  | "CapabilityMismatch"
  | "ProtocolVersionMismatch"
  | "RunnerResumeRejected"
  | "TraceIntegrityViolation"
  | "ArtifactUnacknowledged"
  | "ArtifactUploadRejected"
  | "UnknownSession"
  | "UnknownOffer"
  | "UnknownRun"
  | "RunIdentityMismatch"
  | "RunOwnershipViolation"
  | "PolicyMissing";

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
  readonly completionSink?: RunCompletionSink;
  readonly artifactUploads?: ArtifactUploadService;
}

export interface RunCompletionSink {
  complete(input: {
    readonly identity: AuthenticatedRunnerContext;
    readonly jobId: string;
    readonly runId: string;
    readonly completion: ExecutionCompletion;
  }): Promise<void>;
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
  private readonly completionSink: RunCompletionSink | undefined;
  private readonly artifactUploads: ArtifactUploadService | undefined;
  private readonly offersByJob = new Map<string, CanonicalOffer>();
  private readonly offersByRun = new Map<string, CanonicalOffer>();
  private processing: Promise<void> = Promise.resolve();

  constructor(options: CoreRunnerProtocolApplicationOptions) {
    this.sessions = options.sessions;
    this.jobs = options.jobs;
    this.ownership = options.ownership;
    this.recordRun = options.recordRun;
    this.completionSink = options.completionSink;
    this.artifactUploads = options.artifactUploads;
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
      const lease = await this.jobs.accept(offerId);
      const offered = this.offersByRun.get(lease.runId);
      if (offered !== undefined) {
        await this.recordRun?.(offered.offer.job);
      }
      return lease;
    });
  }

  renew(sessionId: string, lease: ExecutionJobLease): Promise<ExecutionJobLease> {
    return this.serialize(async () => {
      await this.requireOwner(sessionId, lease.runId);
      return this.jobs.renew(lease);
    });
  }

  ingest(sessionId: string, batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    return this.serialize(() => this.sessions.ingest(sessionId, batch));
  }

  registerArtifactManifest(
    sessionId: string,
    registration: ArtifactManifestRegistration,
  ): Promise<ArtifactUploadAck> {
    return this.serialize(async () => {
      const session = this.requireSession(sessionId);
      await this.requireOwner(sessionId, registration.runId);
      const lease = {
        jobId: registration.jobId,
        runId: registration.runId,
        leaseEpoch: registration.leaseEpoch,
        leaseToken: registration.leaseToken,
        expiresAt: new Date(0).toISOString(),
      };
      if (!await this.ownership.mayStartAction(lease)) {
        throw new CoreApplicationError("LeaseLost", `lease for run ${registration.runId} no longer authorizes new artifact manifests`);
      }
      const job = await this.ownership.jobOf(registration.runId);
      if (job === undefined || job.jobId !== registration.jobId || job.projectId !== registration.manifest.projectId) {
        throw new CoreApplicationError("RunIdentityMismatch", `artifact manifest for run ${registration.runId} does not match durable job provenance`);
      }
      return this.requireArtifactUploads().registerManifest({
        identity: {
          tenantId: tenantIdFor(session.identity),
          projectId: job.projectId,
          runnerId: session.identity.runnerId,
        },
        jobId: registration.jobId,
        leaseEpoch: registration.leaseEpoch,
        manifest: registration.manifest,
      }).catch(mapArtifactUploadError);
    });
  }

  uploadArtifactChunk(
    sessionId: string,
    upload: ArtifactChunkUpload,
  ): Promise<ArtifactUploadAck> {
    return this.serialize(async () => {
      const session = this.requireSession(sessionId);
      return this.requireArtifactUploads().uploadChunk({
        identity: { runnerId: session.identity.runnerId },
        chunk: upload.chunk,
      }).catch(mapArtifactUploadError);
    });
  }

  complete(
    sessionId: string,
    lease: ExecutionJobLease,
    completion: ExecutionCompletion,
  ): Promise<void> {
    return this.serialize(async () => {
      await this.requireOwner(sessionId, lease.runId);
      if (lease.leaseToken === "") {
        // The gRPC server could not attach a lease it had seen on this
        // connection: the run was accepted or renewed on a pre-disconnect
        // connection (or a previous Core process). Session ownership is already
        // verified above, so the stored lease is the authority for completing.
        const disposition = await this.ownership.completeStored(lease.runId, completion);
        await this.invokeCompletionSink(sessionId, completion, disposition);
        return;
      }
      const disposition = await this.jobs.complete(lease, completion);
      await this.invokeCompletionSink(sessionId, completion, disposition);
    });
  }

  closeSession(sessionId: string): Promise<void> {
    return this.serialize(() => this.sessions.closeSession(sessionId));
  }

  private async createOfferSerialized(
    sessionId: string,
    job: AcceptedExecutionJob,
    requirements: readonly string[],
  ): Promise<ExecutionJobOffer> {
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

    const offer = await this.jobs.offer({
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

  private async requireOwner(sessionId: string, runId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const owner = await this.ownership.ownerOf(runId);
    if (
      owner === undefined ||
      owner.sessionId !== sessionId ||
      owner.runnerId !== session.identity.runnerId
    ) {
      throw new CoreApplicationError("LeaseLost", `session ${sessionId} does not own run ${runId}`);
    }
  }

  private async invokeCompletionSink(sessionId: string, completion: ExecutionCompletion, disposition: "completed" | "duplicate"): Promise<void> {
    const sink = this.completionSink;
    if (sink === undefined) return;
    const session = this.requireSession(sessionId);
    const authoritative = disposition === "duplicate" ? await this.jobs.completionOf(completion.runId) : completion;
    if (authoritative === undefined) return;
    await sink.complete({ identity: session.identity, jobId: authoritative.jobId, runId: authoritative.runId, completion: authoritative });
  }

  private requireArtifactUploads(): ArtifactUploadService {
    if (this.artifactUploads === undefined) {
      throw new CoreApplicationError("ArtifactUploadRejected", "artifact upload is not configured");
    }
    return this.artifactUploads;
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

function tenantIdFor(identity: AuthenticatedRunnerContext): string {
  return identity.scope.kind === "tenant" ? identity.scope.tenantId : "local";
}

function mapArtifactUploadError(error: unknown): never {
  if (error instanceof ArtifactUploadError) {
    throw new CoreApplicationError(
      "ArtifactUploadRejected",
      error.message,
      { cause: error, details: { artifactCode: error.code } },
    );
  }
  throw error;
}
