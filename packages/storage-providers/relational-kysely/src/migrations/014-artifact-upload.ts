import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Migration } from "../migrations.js";
import type { Database } from "../schema.js";

/** Migration 014: resumable Artifact manifest/chunk/ACK state. */
export const migration014: Migration = {
  version: 14,
  name: "artifact-upload",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("artifact_upload_manifests")
      .addColumn("artifact_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("project_id", "text", (column) => column.notNull())
      .addColumn("run_id", "text", (column) => column.notNull().references("execution_runs.run_id"))
      .addColumn("job_id", "text", (column) => column.notNull())
      .addColumn("size_bytes", "integer", (column) => column.notNull())
      .addColumn("sha256", "text", (column) => column.notNull())
      .addColumn("media_type", "text", (column) => column.notNull())
      .addColumn("sensitivity", "text", (column) => column.notNull())
      .addColumn("chunk_size_bytes", "integer", (column) => column.notNull())
      .addColumn("total_chunks", "integer", (column) => column.notNull())
      .addColumn("registered_by_runner_id", "text", (column) => column.notNull())
      .addColumn("registered_lease_epoch", "integer", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("relative_path", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("verified_at", "text")
      .addCheckConstraint(
        "artifact_upload_manifests_status_check",
        sql`status IN ('registered', 'verified')`,
      )
      .addCheckConstraint("artifact_upload_manifests_size_check", sql`size_bytes >= 0`)
      .addCheckConstraint("artifact_upload_manifests_chunk_size_check", sql`chunk_size_bytes = 262144`)
      .addCheckConstraint("artifact_upload_manifests_total_chunks_check", sql`total_chunks >= 0`)
      .execute();

    await db.schema
      .createTable("artifact_upload_chunks")
      .addColumn("artifact_id", "text", (column) => column.notNull().references("artifact_upload_manifests.artifact_id"))
      .addColumn("offset_bytes", "integer", (column) => column.notNull())
      .addColumn("size_bytes", "integer", (column) => column.notNull())
      .addColumn("sha256", "text", (column) => column.notNull())
      .addColumn("bytes", "blob", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("artifact_upload_chunks_pk", ["artifact_id", "offset_bytes"])
      .addCheckConstraint("artifact_upload_chunks_offset_check", sql`offset_bytes >= 0`)
      .addCheckConstraint("artifact_upload_chunks_size_check", sql`size_bytes > 0 AND size_bytes <= 262144`)
      .execute();
  },
};
