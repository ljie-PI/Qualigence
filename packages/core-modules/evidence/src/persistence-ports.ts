import type { RunId } from "@qualigence/runner-protocol";

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
}

export interface ArtifactManifestStore {
  append(manifest: ArtifactManifest): Promise<"accepted" | "duplicate">;
  listForRun(runId: RunId): Promise<readonly ArtifactManifest[]>;
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
