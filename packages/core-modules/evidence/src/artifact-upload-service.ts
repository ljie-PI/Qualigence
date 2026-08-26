import { createHash } from "node:crypto";
import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  type ArtifactByteRange,
  type ArtifactUploadAck,
  type ArtifactUploadChunk,
  type ArtifactUploadManifest,
} from "@qualigence/runner-protocol";
import type { Clock } from "@qualigence/shared-kernel";
import type {
  ArtifactManifestStore,
  ArtifactStore,
  ArtifactUploadChunkRecord,
  ArtifactUploadManifestRecord,
  ArtifactUploadStore,
} from "./persistence-ports.js";

export type ArtifactUploadErrorCode =
  | "ArtifactUploadValidationFailed"
  | "ArtifactManifestConflict"
  | "ArtifactChunkConflict"
  | "ArtifactUploadNotRegistered"
  | "ArtifactUploadForbidden"
  | "ArtifactHashMismatch";

export class ArtifactUploadError extends Error {
  constructor(
    readonly code: ArtifactUploadErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArtifactUploadError";
  }
}

export interface ArtifactUploadIdentity {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runnerId: string;
}

export interface ArtifactUploadChunkIdentity extends ArtifactUploadIdentity {
  readonly runId: string;
  readonly artifactId: string;
}

export interface RegisterArtifactManifestInput {
  readonly identity: ArtifactUploadIdentity;
  readonly jobId: string;
  readonly leaseEpoch: number;
  readonly manifest: ArtifactUploadManifest;
}

export interface UploadArtifactChunkInput {
  readonly identity: ArtifactUploadChunkIdentity;
  readonly chunk: ArtifactUploadChunk;
}

export interface ArtifactUploadServiceOptions {
  readonly uploads: ArtifactUploadStore;
  readonly artifactStore: ArtifactStore;
  readonly artifactStoreForManifest?: (manifest: ArtifactUploadManifestRecord) => ArtifactStore;
  readonly manifestStore: ArtifactManifestStore;
  readonly clock: Clock;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SENSITIVITIES = new Set(["public", "internal", "sensitive", "secret"]);

export class ArtifactUploadService {
  private readonly uploads: ArtifactUploadStore;
  private readonly artifactStore: ArtifactStore;
  private readonly artifactStoreForManifest: ((manifest: ArtifactUploadManifestRecord) => ArtifactStore) | undefined;
  private readonly manifestStore: ArtifactManifestStore;
  private readonly clock: Clock;

  constructor(options: ArtifactUploadServiceOptions) {
    this.uploads = options.uploads;
    this.artifactStore = options.artifactStore;
    this.artifactStoreForManifest = options.artifactStoreForManifest;
    this.manifestStore = options.manifestStore;
    this.clock = options.clock;
  }

  async registerManifest(input: RegisterArtifactManifestInput): Promise<ArtifactUploadAck> {
    validateManifest(input.manifest);
    this.assertManifestScope(input.identity, input.manifest);
    const manifest: ArtifactUploadManifestRecord = {
      ...input.manifest,
      jobId: input.jobId,
      registeredByRunnerId: input.identity.runnerId,
      registeredLeaseEpoch: input.leaseEpoch,
      status: "registered",
      createdAt: this.clock.now(),
    };
    const registered = await this.uploads.registerManifest(manifest);
    if (registered.status === "conflict") {
      throw new ArtifactUploadError("ArtifactManifestConflict", `artifact ${input.manifest.artifactId} manifest conflicts with durable state`);
    }
    return this.progressFor(registered.manifest);
  }

  async uploadChunk(input: UploadArtifactChunkInput): Promise<ArtifactUploadAck> {
    validateChunk(input.chunk);
    this.assertChunkScope(input.identity, input.chunk);
    const manifest = await this.uploads.manifest(input.chunk);
    if (manifest === undefined) {
      throw new ArtifactUploadError("ArtifactUploadNotRegistered", `artifact ${input.chunk.artifactId} has no registered manifest`);
    }
    if (manifest.registeredByRunnerId !== input.identity.runnerId) {
      throw new ArtifactUploadError("ArtifactUploadForbidden", `runner ${input.identity.runnerId} cannot upload artifact ${input.chunk.artifactId}`);
    }
    this.assertChunkMatchesManifest(input.chunk, manifest);
    if (manifest.status === "verified") {
      return { artifactId: manifest.artifactId, runId: manifest.runId, missingRanges: [], acknowledged: true };
    }

    const now = this.clock.now();
    const result = await this.uploads.appendChunk({
      ...input.chunk,
      sizeBytes: input.chunk.bytes.length,
      createdAt: now,
    });
    if (result.status === "conflict") {
      throw new ArtifactUploadError("ArtifactChunkConflict", `artifact ${input.chunk.artifactId} chunk at offset ${input.chunk.offset} conflicts with durable bytes`);
    }
    return this.progressFor(manifest);
  }

  async acknowledgedArtifactIds(runId: string, artifactIds: readonly string[]): Promise<ReadonlySet<string>> {
    return this.uploads.acknowledgedArtifactIds(runId, artifactIds);
  }

  private async progressFor(manifest: ArtifactUploadManifestRecord): Promise<ArtifactUploadAck> {
    if (manifest.status === "verified") {
      return { artifactId: manifest.artifactId, runId: manifest.runId, missingRanges: [], acknowledged: true };
    }
    const chunks = await this.uploads.chunks(manifest);
    const missing = missingRanges(manifest, chunks);
    if (missing.length > 0) {
      return { artifactId: manifest.artifactId, runId: manifest.runId, missingRanges: missing, acknowledged: false };
    }
    await this.verifyAndCommit(manifest, chunks);
    return { artifactId: manifest.artifactId, runId: manifest.runId, missingRanges: [], acknowledged: true };
  }

  private async verifyAndCommit(
    manifest: ArtifactUploadManifestRecord,
    chunks: readonly ArtifactUploadChunkRecord[],
  ): Promise<void> {
    const ordered = [...chunks].sort((left, right) => left.offset - right.offset);
    const bytes = new Uint8Array(manifest.sizeBytes);
    for (const chunk of ordered) {
      bytes.set(chunk.bytes, chunk.offset);
    }
    const digest = sha256Hex(bytes);
    if (bytes.length !== manifest.sizeBytes || digest !== manifest.sha256) {
      throw new ArtifactUploadError("ArtifactHashMismatch", `artifact ${manifest.artifactId} failed final hash verification`);
    }
    const stored = await this.artifactStoreFor(manifest).write({
      artifactId: manifest.artifactId,
      runId: manifest.runId,
      name: manifest.artifactId,
      kind: "other",
      mediaType: manifest.mediaType,
      bytes,
    });
    if (!await this.artifactStoreFor(manifest).verify(stored)) {
      throw new ArtifactUploadError("ArtifactHashMismatch", `artifact ${manifest.artifactId} could not be verified after durable write`);
    }
    await this.manifestStore.append(stored);
    await this.uploads.markVerified({
      tenantId: manifest.tenantId,
      projectId: manifest.projectId,
      runId: manifest.runId,
      artifactId: manifest.artifactId,
      relativePath: stored.relativePath,
      verifiedAt: this.clock.now(),
    });
  }

  private artifactStoreFor(manifest: ArtifactUploadManifestRecord): ArtifactStore {
    return this.artifactStoreForManifest?.(manifest) ?? this.artifactStore;
  }

  private assertManifestScope(identity: ArtifactUploadIdentity, manifest: ArtifactUploadManifest): void {
    if (manifest.tenantId !== identity.tenantId || manifest.projectId !== identity.projectId) {
      throw new ArtifactUploadError("ArtifactUploadForbidden", "artifact manifest scope does not match authenticated runner scope");
    }
  }

  private assertChunkScope(identity: ArtifactUploadChunkIdentity, chunk: ArtifactUploadChunk): void {
    if (
      chunk.tenantId !== identity.tenantId ||
      chunk.projectId !== identity.projectId ||
      chunk.runId !== identity.runId ||
      chunk.artifactId !== identity.artifactId
    ) {
      throw new ArtifactUploadError("ArtifactUploadForbidden", "artifact chunk scope does not match authenticated runner scope");
    }
  }

  private assertChunkMatchesManifest(chunk: ArtifactUploadChunk, manifest: ArtifactUploadManifestRecord): void {
    if (
      chunk.tenantId !== manifest.tenantId ||
      chunk.projectId !== manifest.projectId ||
      chunk.runId !== manifest.runId ||
      chunk.artifactId !== manifest.artifactId
    ) {
      throw new ArtifactUploadError("ArtifactUploadForbidden", "artifact chunk scope does not match registered manifest");
    }
    const maximumLength = Math.min(manifest.chunkSizeBytes, manifest.sizeBytes - chunk.offset);
    if (chunk.offset < 0 || chunk.offset >= Math.max(1, manifest.sizeBytes) || chunk.bytes.length !== maximumLength) {
      throw new ArtifactUploadError("ArtifactUploadValidationFailed", "artifact chunk offset or length is invalid for the manifest");
    }
  }
}

export function missingRanges(
  manifest: ArtifactUploadManifest,
  chunks: readonly Pick<ArtifactUploadChunkRecord, "offset" | "sizeBytes">[],
): readonly ArtifactByteRange[] {
  if (manifest.sizeBytes === 0) return [];
  const present = new Set(chunks.map((chunk) => chunk.offset));
  const ranges: ArtifactByteRange[] = [];
  for (let offset = 0; offset < manifest.sizeBytes; offset += manifest.chunkSizeBytes) {
    if (!present.has(offset)) {
      ranges.push({ offset, length: Math.min(manifest.chunkSizeBytes, manifest.sizeBytes - offset) });
    }
  }
  return ranges;
}

function validateManifest(manifest: ArtifactUploadManifest): void {
  if (
    !nonEmpty(manifest.artifactId) ||
    !nonEmpty(manifest.tenantId) ||
    !nonEmpty(manifest.projectId) ||
    !nonEmpty(manifest.runId) ||
    !nonEmpty(manifest.mediaType) ||
    !SHA256_HEX.test(manifest.sha256) ||
    !SENSITIVITIES.has(manifest.sensitivity) ||
    !Number.isSafeInteger(manifest.sizeBytes) ||
    manifest.sizeBytes < 0 ||
    manifest.chunkSizeBytes !== ARTIFACT_CHUNK_SIZE_BYTES ||
    manifest.totalChunks !== Math.ceil(manifest.sizeBytes / ARTIFACT_CHUNK_SIZE_BYTES)
  ) {
    throw new ArtifactUploadError("ArtifactUploadValidationFailed", "artifact manifest is missing required upload authority fields");
  }
}

function validateChunk(chunk: ArtifactUploadChunk): void {
  if (
    !nonEmpty(chunk.artifactId) ||
    !nonEmpty(chunk.tenantId) ||
    !nonEmpty(chunk.projectId) ||
    !nonEmpty(chunk.runId) ||
    !SHA256_HEX.test(chunk.sha256) ||
    !Number.isSafeInteger(chunk.offset) ||
    chunk.offset < 0 ||
    chunk.offset % ARTIFACT_CHUNK_SIZE_BYTES !== 0 ||
    chunk.bytes.length > ARTIFACT_CHUNK_SIZE_BYTES ||
    sha256Hex(chunk.bytes) !== chunk.sha256
  ) {
    throw new ArtifactUploadError("ArtifactUploadValidationFailed", "artifact chunk is malformed or hash-invalid");
  }
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
