import type {
  ArtifactByteRange,
  ArtifactUploadChunk,
  ArtifactUploadManifest as RunnerArtifactUploadManifest,
  RunId,
} from "@qualigence/runner-protocol";

export type RunStatus =
  | "running"
  | "passed"
  | "finding"
  | "blocked"
  | "error";

export interface ExecutionRunRecord {
  readonly runId: RunId;
  readonly jobId: string;
  readonly targetKind: "web" | "app";
  readonly objective: string;
  readonly status: RunStatus;
  readonly nextSequenceNumber: number;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly errorCode?: string;
}

export interface RunTerminalUpdate {
  readonly status: Exclude<RunStatus, "running">;
  readonly completedAt: string;
  readonly errorCode?: string;
}

export interface RunStore {
  create(record: ExecutionRunRecord): Promise<void>;
  complete(
    runId: RunId,
    terminal: RunTerminalUpdate,
  ): Promise<"completed" | "duplicate">;
  get(runId: RunId): Promise<ExecutionRunRecord | undefined>;
}

export type ArtifactKind = "observation" | "screenshot" | "log" | "other";

export interface ArtifactWriteRequest {
  readonly artifactId: string;
  readonly runId: RunId;
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ArtifactManifest {
  readonly artifactId: string;
  readonly runId: RunId;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly createdAt: string;
}

export interface ArtifactStore {
  write(request: ArtifactWriteRequest): Promise<ArtifactManifest>;
  read(manifest: ArtifactManifest): Promise<Uint8Array>;
  verify(manifest: ArtifactManifest): Promise<boolean>;
  delete?(manifest: ArtifactManifest): Promise<void>;
}

export interface FindingReference {
  readonly findingId: string;
  readonly createdAt: string;
}

export interface ArtifactManifestStore {
  append(manifest: ArtifactManifest): Promise<"accepted" | "duplicate">;
  listForRun(runId: RunId): Promise<readonly ArtifactManifest[]>;
}

export type ArtifactUploadStatus = "registered" | "verified";

export interface ArtifactUploadManifestRecord extends RunnerArtifactUploadManifest {
  readonly jobId: string;
  readonly registeredByRunnerId: string;
  readonly registeredLeaseEpoch: number;
  readonly status: ArtifactUploadStatus;
  readonly createdAt: string;
  readonly relativePath?: string;
  readonly verifiedAt?: string;
}

export interface ArtifactUploadChunkRecord extends ArtifactUploadChunk {
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export type ArtifactUploadRegisterResult =
  | { readonly status: "accepted" | "duplicate"; readonly manifest: ArtifactUploadManifestRecord }
  | { readonly status: "conflict"; readonly code: "ArtifactManifestConflict" };

export type ArtifactUploadChunkResult =
  | { readonly status: "accepted" | "duplicate" }
  | { readonly status: "conflict"; readonly code: "ArtifactChunkConflict" };

export interface ArtifactUploadStore {
  registerManifest(manifest: ArtifactUploadManifestRecord): Promise<ArtifactUploadRegisterResult>;
  manifest(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: RunId;
    readonly artifactId: string;
  }): Promise<ArtifactUploadManifestRecord | undefined>;
  appendChunk(chunk: ArtifactUploadChunkRecord): Promise<ArtifactUploadChunkResult>;
  chunks(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: RunId;
    readonly artifactId: string;
  }): Promise<readonly ArtifactUploadChunkRecord[]>;
  markVerified(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: RunId;
    readonly artifactId: string;
    readonly relativePath: string;
    readonly verifiedAt: string;
  }): Promise<void>;
  acknowledgedArtifactIds(runId: RunId, artifactIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface ArtifactReferenceAuthority {
  acknowledgedArtifactIds(runId: RunId, artifactIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface ArtifactRangePlanner {
  missingRanges(manifest: RunnerArtifactUploadManifest, chunks: readonly ArtifactUploadChunkRecord[]): readonly ArtifactByteRange[];
}

export interface ModelInvocationSummary {
  readonly invocationId: string;
  readonly runId: RunId;
  readonly operation: string;
  readonly model: string;
  readonly status: "succeeded" | "failed";
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly providerRequestId?: string;
  readonly errorCode?: string;
  readonly occurredAt: string;
}

export interface ModelInvocationStore {
  append(summary: ModelInvocationSummary): Promise<void>;
  listForRun(runId: RunId): Promise<readonly ModelInvocationSummary[]>;
}
