import type {
  ArtifactUploadChunkRecord,
  ArtifactUploadChunkResult,
  ArtifactUploadManifestRecord,
  ArtifactUploadRegisterResult,
  ArtifactUploadStore,
} from "./persistence-ports.js";

function key(input: { readonly tenantId: string; readonly projectId: string; readonly runId: string; readonly artifactId: string }): string {
  return JSON.stringify([input.tenantId, input.projectId, input.runId, input.artifactId]);
}

function chunkKey(chunk: { readonly tenantId: string; readonly projectId: string; readonly runId: string; readonly artifactId: string; readonly offset: number }): string {
  return JSON.stringify([chunk.tenantId, chunk.projectId, chunk.runId, chunk.artifactId, chunk.offset]);
}

function sameManifest(left: ArtifactUploadManifestRecord, right: ArtifactUploadManifestRecord): boolean {
  const comparable = (value: ArtifactUploadManifestRecord): object => ({
    artifactId: value.artifactId,
    tenantId: value.tenantId,
    projectId: value.projectId,
    runId: value.runId,
    jobId: value.jobId,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
    mediaType: value.mediaType,
    sensitivity: value.sensitivity,
    chunkSizeBytes: value.chunkSizeBytes,
    totalChunks: value.totalChunks,
    registeredByRunnerId: value.registeredByRunnerId,
    registeredLeaseEpoch: value.registeredLeaseEpoch,
  });
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

export class InMemoryArtifactUploadStore implements ArtifactUploadStore {
  private readonly manifests = new Map<string, ArtifactUploadManifestRecord>();
  private readonly chunkRows = new Map<string, ArtifactUploadChunkRecord>();

  async registerManifest(manifest: ArtifactUploadManifestRecord): Promise<ArtifactUploadRegisterResult> {
    const id = key(manifest);
    const existing = this.manifests.get(id);
    if (existing !== undefined) {
      return sameManifest(existing, manifest)
        ? { status: "duplicate", manifest: existing }
        : { status: "conflict", code: "ArtifactManifestConflict" };
    }
    this.manifests.set(id, manifest);
    return { status: "accepted", manifest };
  }

  async manifest(input: { readonly tenantId: string; readonly projectId: string; readonly runId: string; readonly artifactId: string }): Promise<ArtifactUploadManifestRecord | undefined> {
    return this.manifests.get(key(input));
  }

  async appendChunk(chunk: ArtifactUploadChunkRecord): Promise<ArtifactUploadChunkResult> {
    const id = chunkKey(chunk);
    const existing = this.chunkRows.get(id);
    if (existing !== undefined) {
      return existing.sha256 === chunk.sha256 && Buffer.from(existing.bytes).equals(Buffer.from(chunk.bytes))
        ? { status: "duplicate" }
        : { status: "conflict", code: "ArtifactChunkConflict" };
    }
    this.chunkRows.set(id, chunk);
    return { status: "accepted" };
  }

  async chunks(input: { readonly tenantId: string; readonly projectId: string; readonly runId: string; readonly artifactId: string }): Promise<readonly ArtifactUploadChunkRecord[]> {
    return [...this.chunkRows.values()]
      .filter((chunk) => key(chunk) === key(input))
      .sort((left, right) => left.offset - right.offset);
  }

  async markVerified(input: { readonly tenantId: string; readonly projectId: string; readonly runId: string; readonly artifactId: string; readonly relativePath: string; readonly verifiedAt: string }): Promise<void> {
    const id = key(input);
    const manifest = this.manifests.get(id);
    if (manifest !== undefined) {
      this.manifests.set(id, {
        ...manifest,
        status: "verified",
        relativePath: input.relativePath,
        verifiedAt: input.verifiedAt,
      });
    }
  }

  async acknowledgedArtifactIds(runId: string, artifactIds: readonly string[]): Promise<ReadonlySet<string>> {
    const requested = new Set(artifactIds);
    const acknowledged = new Set<string>();
    for (const manifest of this.manifests.values()) {
      if (manifest.runId === runId && manifest.status === "verified" && requested.has(manifest.artifactId)) {
        acknowledged.add(manifest.artifactId);
      }
    }
    return acknowledged;
  }
}
