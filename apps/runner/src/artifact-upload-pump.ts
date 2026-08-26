import type {
  ArtifactChunkUpload,
  ArtifactManifestRegistration,
  ArtifactUploadAck,
  ArtifactUploadManifest,
  ExecutionJobLease,
} from "@qualigence/runner-protocol";
import type { RunnerSpool } from "@qualigence/runner-spool";
import { RunnerAppError } from "./errors.js";

export interface ArtifactUploadSubmitter {
  registerArtifactManifest(registration: ArtifactManifestRegistration): Promise<ArtifactUploadAck>;
  uploadArtifactChunk(upload: ArtifactChunkUpload): Promise<ArtifactUploadAck>;
}

export interface ArtifactUploadPumpResult {
  readonly artifacts: number;
  readonly acknowledged: number;
}

interface ArtifactSpool {
  pendingArtifactManifests(runId: string): Promise<readonly ArtifactUploadManifest[]>;
  pendingArtifactChunks(runId: string, artifactId: string, missingRanges: readonly { readonly offset: number; readonly length: number }[]): Promise<readonly import("@qualigence/runner-protocol").ArtifactUploadChunk[]>;
  artifactUploadProgress(runId: string, artifactId: string): Promise<ArtifactUploadAck | undefined>;
  acknowledgeArtifactProgress(progress: ArtifactUploadAck): Promise<void>;
}

/**
 * Drains spooled Artifact manifests/chunks before Trace that may reference them.
 * Server-reported missing ranges are authoritative: already durable ranges are
 * deleted from the local spool, missing ranges are replayed, and a final ACK
 * removes both manifest and chunks so reconnect/restart resumes safely.
 */
export class ArtifactUploadPump {
  constructor(
    private readonly spool: RunnerSpool,
    private readonly submitter: ArtifactUploadSubmitter,
    private readonly lease: ExecutionJobLease,
  ) {}

  async drain(runId: string, signal?: AbortSignal): Promise<ArtifactUploadPumpResult> {
    signal?.throwIfAborted();
    const spool = artifactSpool(this.spool);
    const manifests = await abortable(spool.pendingArtifactManifests(runId), signal);
    let acknowledged = 0;
    for (const manifest of manifests) {
      signal?.throwIfAborted();
      const progress = await abortable(
        spool.artifactUploadProgress(manifest.runId, manifest.artifactId),
        signal,
      );
      const initial = progress ?? await this.registerManifest(manifest, spool, signal);
      const final = initial.acknowledged
        ? initial
        : await this.uploadMissing(manifest, initial, signal);
      if (final.acknowledged) acknowledged += 1;
    }
    return { artifacts: manifests.length, acknowledged };
  }

  private async registerManifest(
    manifest: ArtifactUploadManifest,
    spool: ArtifactSpool,
    signal?: AbortSignal,
  ): Promise<ArtifactUploadAck> {
    const registered = await abortable(this.submitter.registerArtifactManifest({
      jobId: this.lease.jobId,
      runId: this.lease.runId,
      leaseEpoch: this.lease.leaseEpoch,
      leaseToken: this.lease.leaseToken,
      manifest,
    }), signal);
    await abortable(spool.acknowledgeArtifactProgress(registered), signal);
    return registered;
  }

  private async uploadMissing(
    manifest: ArtifactUploadManifest,
    initial: ArtifactUploadAck,
    signal?: AbortSignal,
  ): Promise<ArtifactUploadAck> {
    let progress = initial;
    for (;;) {
      const chunks = await abortable(
        artifactSpool(this.spool).pendingArtifactChunks(manifest.runId, manifest.artifactId, progress.missingRanges),
        signal,
      );
      if (chunks.length === 0) return progress;
      for (const chunk of chunks) {
        signal?.throwIfAborted();
        progress = await abortable(this.submitter.uploadArtifactChunk({
          jobId: this.lease.jobId,
          runId: this.lease.runId,
          leaseEpoch: this.lease.leaseEpoch,
          leaseToken: this.lease.leaseToken,
          chunk,
        }), signal);
        await abortable(artifactSpool(this.spool).acknowledgeArtifactProgress(progress), signal);
        if (progress.acknowledged) return progress;
      }
    }
  }
}

function artifactSpool(spool: RunnerSpool): ArtifactSpool {
  if (
    spool.pendingArtifactManifests === undefined ||
    spool.pendingArtifactChunks === undefined ||
    spool.artifactUploadProgress === undefined ||
    spool.acknowledgeArtifactProgress === undefined
  ) {
    throw new RunnerAppError("TransportError", "runner spool does not support artifact upload recovery");
  }
  return {
    pendingArtifactManifests: spool.pendingArtifactManifests.bind(spool),
    pendingArtifactChunks: spool.pendingArtifactChunks.bind(spool),
    artifactUploadProgress: spool.artifactUploadProgress.bind(spool),
    acknowledgeArtifactProgress: spool.acknowledgeArtifactProgress.bind(spool),
  };
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
