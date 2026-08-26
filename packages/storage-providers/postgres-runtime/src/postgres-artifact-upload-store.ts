import type {
  ArtifactKind,
  ArtifactManifest,
  ArtifactManifestStore,
  ArtifactUploadChunkRecord,
  ArtifactUploadChunkResult,
  ArtifactUploadManifestRecord,
  ArtifactUploadRegisterResult,
  ArtifactUploadStore,
} from "@qualigence/evidence";
import type { RunId } from "@qualigence/runner-protocol";
import type { Kysely, Transaction } from "kysely";
import type { PostgresDatabase } from "./postgres-database.js";

export class PostgresArtifactManifestStore implements ArtifactManifestStore {
  constructor(
    private readonly db: Kysely<PostgresDatabase> | Transaction<PostgresDatabase>,
    private readonly tenantId: string,
  ) {}

  async append(manifest: ArtifactManifest): Promise<"accepted" | "duplicate"> {
    const existing = await this.db
      .selectFrom("artifact_manifests")
      .select("sha256")
      .where("tenant_id", "=", this.tenantId)
      .where("artifact_id", "=", manifest.artifactId)
      .executeTakeFirst();
    if (existing !== undefined) return "duplicate";
    await this.db
      .insertInto("artifact_manifests")
      .values({
        tenant_id: this.tenantId,
        artifact_id: manifest.artifactId,
        run_id: manifest.runId,
        kind: manifest.kind,
        media_type: manifest.mediaType,
        relative_path: manifest.relativePath,
        sha256: manifest.sha256,
        size_bytes: manifest.size,
        created_at: manifest.createdAt,
      })
      .execute();
    return "accepted";
  }

  async listForRun(runId: RunId): Promise<readonly ArtifactManifest[]> {
    const rows = await this.db
      .selectFrom("artifact_manifests")
      .selectAll()
      .where("tenant_id", "=", this.tenantId)
      .where("run_id", "=", runId)
      .orderBy("created_at")
      .orderBy("artifact_id")
      .execute();
    return rows.map((row) => ({
      artifactId: row.artifact_id,
      runId: row.run_id,
      kind: row.kind as ArtifactKind,
      mediaType: row.media_type,
      relativePath: row.relative_path,
      sha256: row.sha256,
      size: row.size_bytes,
      createdAt: row.created_at,
    }));
  }
}

export class PostgresArtifactUploadStore implements ArtifactUploadStore {
  constructor(
    private readonly db: Kysely<PostgresDatabase> | Transaction<PostgresDatabase>,
    private readonly tenantId: string,
  ) {}

  async registerManifest(manifest: ArtifactUploadManifestRecord): Promise<ArtifactUploadRegisterResult> {
    const existing = await this.manifest(manifest);
    if (existing !== undefined) {
      return sameManifest(existing, manifest)
        ? { status: "duplicate", manifest: existing }
        : { status: "conflict", code: "ArtifactManifestConflict" };
    }
    await this.db
      .insertInto("artifact_upload_manifests")
      .values({
        tenant_id: this.tenantId,
        artifact_id: manifest.artifactId,
        project_id: manifest.projectId,
        run_id: manifest.runId,
        job_id: manifest.jobId,
        size_bytes: manifest.sizeBytes,
        sha256: manifest.sha256,
        media_type: manifest.mediaType,
        sensitivity: manifest.sensitivity,
        chunk_size_bytes: manifest.chunkSizeBytes,
        total_chunks: manifest.totalChunks,
        registered_by_runner_id: manifest.registeredByRunnerId,
        registered_lease_epoch: manifest.registeredLeaseEpoch,
        status: manifest.status,
        relative_path: manifest.relativePath ?? null,
        created_at: manifest.createdAt,
        verified_at: manifest.verifiedAt ?? null,
      })
      .execute();
    return { status: "accepted", manifest };
  }

  async manifest(input: { readonly tenantId: string; readonly projectId: string; readonly runId: RunId; readonly artifactId: string }): Promise<ArtifactUploadManifestRecord | undefined> {
    if (input.tenantId !== this.tenantId) return undefined;
    const row = await this.db
      .selectFrom("artifact_upload_manifests")
      .selectAll()
      .where("tenant_id", "=", this.tenantId)
      .where("project_id", "=", input.projectId)
      .where("run_id", "=", input.runId)
      .where("artifact_id", "=", input.artifactId)
      .executeTakeFirst();
    return row === undefined ? undefined : manifestRecord(row);
  }

  async appendChunk(chunk: ArtifactUploadChunkRecord): Promise<ArtifactUploadChunkResult> {
    if (chunk.tenantId !== this.tenantId) {
      return { status: "conflict", code: "ArtifactChunkConflict" };
    }
    const existing = await this.db
      .selectFrom("artifact_upload_chunks")
      .select(["sha256", "bytes"])
      .where("tenant_id", "=", this.tenantId)
      .where("artifact_id", "=", chunk.artifactId)
      .where("offset_bytes", "=", chunk.offset)
      .executeTakeFirst();
    if (existing !== undefined) {
      return existing.sha256 === chunk.sha256 && Buffer.from(existing.bytes).equals(Buffer.from(chunk.bytes))
        ? { status: "duplicate" }
        : { status: "conflict", code: "ArtifactChunkConflict" };
    }
    await this.db
      .insertInto("artifact_upload_chunks")
      .values({
        tenant_id: this.tenantId,
        artifact_id: chunk.artifactId,
        offset_bytes: chunk.offset,
        size_bytes: chunk.sizeBytes,
        sha256: chunk.sha256,
        bytes: chunk.bytes,
        created_at: chunk.createdAt,
      })
      .execute();
    return { status: "accepted" };
  }

  async chunks(input: { readonly tenantId: string; readonly projectId: string; readonly runId: RunId; readonly artifactId: string }): Promise<readonly ArtifactUploadChunkRecord[]> {
    if (input.tenantId !== this.tenantId) return [];
    const rows = await this.db
      .selectFrom("artifact_upload_chunks as c")
      .innerJoin("artifact_upload_manifests as m", (join) => join
        .onRef("m.tenant_id", "=", "c.tenant_id")
        .onRef("m.artifact_id", "=", "c.artifact_id"))
      .select([
        "c.artifact_id as artifact_id",
        "m.project_id as project_id",
        "m.run_id as run_id",
        "c.offset_bytes as offset_bytes",
        "c.size_bytes as size_bytes",
        "c.sha256 as sha256",
        "c.bytes as bytes",
        "c.created_at as created_at",
      ])
      .where("c.tenant_id", "=", this.tenantId)
      .where("m.project_id", "=", input.projectId)
      .where("m.run_id", "=", input.runId)
      .where("c.artifact_id", "=", input.artifactId)
      .orderBy("c.offset_bytes")
      .execute();
    return rows.map((row) => ({
      artifactId: row.artifact_id,
      tenantId: this.tenantId,
      projectId: row.project_id,
      runId: row.run_id,
      offset: row.offset_bytes,
      bytes: new Uint8Array(row.bytes),
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
    }));
  }

  async markVerified(input: { readonly tenantId: string; readonly projectId: string; readonly runId: RunId; readonly artifactId: string; readonly relativePath: string; readonly verifiedAt: string }): Promise<void> {
    if (input.tenantId !== this.tenantId) return;
    await this.db
      .updateTable("artifact_upload_manifests")
      .set({ status: "verified", relative_path: input.relativePath, verified_at: input.verifiedAt })
      .where("tenant_id", "=", this.tenantId)
      .where("project_id", "=", input.projectId)
      .where("run_id", "=", input.runId)
      .where("artifact_id", "=", input.artifactId)
      .execute();
  }

  async acknowledgedArtifactIds(runId: RunId, artifactIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (artifactIds.length === 0) return new Set();
    const rows = await this.db
      .selectFrom("artifact_upload_manifests")
      .select("artifact_id")
      .where("tenant_id", "=", this.tenantId)
      .where("run_id", "=", runId)
      .where("status", "=", "verified")
      .where("artifact_id", "in", [...artifactIds])
      .execute();
    return new Set(rows.map((row) => row.artifact_id));
  }
}

function sameManifest(left: ArtifactUploadManifestRecord, right: ArtifactUploadManifestRecord): boolean {
  return left.artifactId === right.artifactId &&
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.runId === right.runId &&
    left.jobId === right.jobId &&
    left.sizeBytes === right.sizeBytes &&
    left.sha256 === right.sha256 &&
    left.mediaType === right.mediaType &&
    left.sensitivity === right.sensitivity &&
    left.chunkSizeBytes === right.chunkSizeBytes &&
    left.totalChunks === right.totalChunks &&
    left.registeredByRunnerId === right.registeredByRunnerId &&
    left.registeredLeaseEpoch === right.registeredLeaseEpoch;
}

function manifestRecord(row: {
  readonly artifact_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly job_id: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly media_type: string;
  readonly sensitivity: string;
  readonly chunk_size_bytes: number;
  readonly total_chunks: number;
  readonly registered_by_runner_id: string;
  readonly registered_lease_epoch: number;
  readonly status: string;
  readonly relative_path: string | null;
  readonly created_at: string;
  readonly verified_at: string | null;
}): ArtifactUploadManifestRecord {
  return {
    artifactId: row.artifact_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    runId: row.run_id,
    jobId: row.job_id,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    mediaType: row.media_type,
    sensitivity: row.sensitivity as ArtifactUploadManifestRecord["sensitivity"],
    chunkSizeBytes: row.chunk_size_bytes as ArtifactUploadManifestRecord["chunkSizeBytes"],
    totalChunks: row.total_chunks,
    registeredByRunnerId: row.registered_by_runner_id,
    registeredLeaseEpoch: row.registered_lease_epoch,
    status: row.status as ArtifactUploadManifestRecord["status"],
    createdAt: row.created_at,
    ...(row.relative_path === null ? {} : { relativePath: row.relative_path }),
    ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
  };
}
