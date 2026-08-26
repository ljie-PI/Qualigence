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

export type {
  AuthenticatedRunnerContext,
  RunnerProtocolApplication,
  RunnerProtocolApplicationResolver,
} from "@qualigence/runner-control";

/**
 * Core-facing seam for dispatching one execution attempt to a connected Runner.
 * The Core Daemon (LS-05 Task 4, out of scope here) drives this; the adapter's
 * server implements it per live Runner connection. Neither side imports Protobuf.
 */
export interface RunnerConnectionPort {
  readonly authenticatedRunner: {
    readonly runnerId: string;
    readonly scope: import("@qualigence/runner-control").RunnerAuthorizationScope;
    readonly capabilities: readonly string[];
  };
  offer(job: AcceptedExecutionJob, requirements: readonly string[]): Promise<ExecutionJobLease>;
  cancel(jobId: string, reason: string): Promise<void>;
}

/**
 * Runner-facing seam for establishing a session with the Core Daemon. The Runner
 * app (LS-05 Task 5, out of scope here) drives this; the adapter's client
 * implements it.
 */
export interface RunnerClientPort {
  connect(hello: RunnerHello): Promise<RunnerSession>;
}

/**
 * An established Runner session over the bidirectional stream. The negotiated
 * {@link RunnerWelcome} is captured once at handshake and never mutated.
 */
export interface RunnerSession {
  readonly welcome: RunnerWelcome;
  nextOffer(signal: AbortSignal): Promise<ExecutionJobOffer>;
  accept(offerId: string): Promise<ExecutionJobLease>;
  renew(lease: ExecutionJobLease): Promise<ExecutionJobLease>;
  submit(batch: ExecutionEventBatch): Promise<ExecutionEventAck>;
  registerArtifactManifest?(registration: ArtifactManifestRegistration): Promise<ArtifactUploadAck>;
  uploadArtifactChunk?(upload: ArtifactChunkUpload): Promise<ArtifactUploadAck>;
  complete(lease: ExecutionJobLease, result: ExecutionCompletion): Promise<void>;
  close(): Promise<void>;
}

/** Negotiated server parameters advertised to every Runner in its Welcome. */
export interface WelcomeParameters {
  readonly serverVersion: string;
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly traceBatchMaximumEvents: number;
  readonly traceBatchMaximumBytes: number;
  readonly maximumInFlightBatches: number;
  readonly maximumPendingWriteBytes: number;
}
