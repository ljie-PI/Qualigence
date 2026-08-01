import type {
  ArtifactKind,
  ArtifactManifest,
  ArtifactManifestStore,
} from "@qualigence/evidence";
import type { RunId } from "@qualigence/runner-protocol";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

export class SqliteArtifactManifestStore implements ArtifactManifestStore {
  constructor(private readonly runtime: SqliteRuntime) {}

  async append(
    manifest: ArtifactManifest,
  ): Promise<"accepted" | "duplicate"> {
    return runInImmediateTransaction(this.runtime, async () => {
      const db = this.runtime.db;
      const existing = await db
        .selectFrom("artifact_manifests")
        .select("artifact_id")
        .where("artifact_id", "=", manifest.artifactId)
        .executeTakeFirst();

      if (existing) {
        return "duplicate";
      }

      await db
        .insertInto("artifact_manifests")
        .values({
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
    });
  }

  async listForRun(runId: RunId): Promise<readonly ArtifactManifest[]> {
    const rows = await this.runtime.db
      .selectFrom("artifact_manifests")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "asc")
      .orderBy("artifact_id", "asc")
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
