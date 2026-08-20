import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { readSchemaVersion } from "@qualigence/postgres-runtime";
import { MetricsRegistry, StructuredLogger } from "@qualigence/observability";
import type { SelfHostedAdminConfig } from "./../config.js";
import { AdminCliError } from "./../errors.js";
import type { PgToolRunner } from "./../pg-tools.js";
import { BackupLease } from "./../backup/backup-lease.js";
import { createS3Client, enumerateObjects, getObjectBytes } from "./../s3-ops.js";
import {
  BACKUP_COMPLETE_MARKER,
  BACKUP_DATABASE_DUMP,
  BACKUP_INDEX_FILE,
  BACKUP_OBJECTS_DIR,
  canonicalizeIndex,
  objectRelativePath,
  parseIndex,
  sha256Hex,
  tenantsFromKeys,
  type BackupIndexV1,
  type BackupObjectRecord,
  type MigrationBackupBinding,
} from "./../backup/backup-index.js";

const { Client } = pg;

export interface BackupDeps {
  readonly pgTool: PgToolRunner;
  readonly s3Client?: S3Client;
  readonly now?: () => string;
  readonly logger?: StructuredLogger;
  readonly metrics?: MetricsRegistry;
  readonly migration?: MigrationBackupBinding;
}

export interface BackupResult {
  readonly directory: string;
  readonly index: BackupIndexV1;
}

/**
 * Produce a consistent, byte-complete point-in-time backup.
 *
 * A short backup lease is acquired first so Artifact GC cannot delete referenced
 * object bytes mid-backup. A `REPEATABLE READ` transaction exports a snapshot,
 * and `pg_dump --snapshot=<id>` captures the database at exactly that point.
 * Because object keys are content-addressed and immutable, every referenced
 * object is then streamed into a content-addressed backup directory and its
 * SHA-256/size are recomputed and recorded. The canonical `BackupIndexV1` and a
 * completion marker are written last and the directory is renamed into place
 * atomically, so a crash or a Manifest-only export can never be mistaken for a
 * finished backup. The lease is always released.
 */
export async function runBackup(
  config: SelfHostedAdminConfig,
  deps: BackupDeps,
): Promise<BackupResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const logger = deps.logger ?? new StructuredLogger({ service: "admin-cli:backup" });
  const metrics = deps.metrics ?? new MetricsRegistry();
  const objectCounter = metrics.counter("backup_objects_total", "objects copied during backup");
  const byteCounter = metrics.counter("backup_object_bytes_total", "object bytes copied during backup");

  const createdAt = now();
  const invocationSuffix = deps.migration === undefined
    ? ""
    : `-${sha256Hex(new TextEncoder().encode(deps.migration.invocationId)).slice(0, 12)}`;
  const slug = `${createdAt.replace(/[:.]/g, "-")}${invocationSuffix}`;
  const finalDir = join(config.backupDir, slug);
  const stagingDir = join(config.backupDir, `.staging-${slug}`);
  const objectsDir = join(stagingDir, BACKUP_OBJECTS_DIR);
  const s3Client = deps.s3Client ?? createS3Client(config.s3);
  const ownsClient = deps.s3Client === undefined;

  logger.info("backup started", { directory: finalDir });
  const lease = await BackupLease.acquire(config.postgres.admin);
  try {
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(objectsDir, { recursive: true });

    // 1. Consistent database dump pinned to an exported snapshot.
    const snapshotId = await withExportedSnapshot(config, async (id) => {
      await deps.pgTool.dump(config.postgres.admin, {
        snapshotId: id,
        outFile: join(stagingDir, BACKUP_DATABASE_DUMP),
      });
      return id;
    });
    const dumpDigest = await hashFile(join(stagingDir, BACKUP_DATABASE_DUMP));
    const schemaVersion = await readSchemaVersion(config.postgres.admin);

    // 2. Copy every referenced object's real bytes, recomputing SHA-256/size.
    const summaries = await enumerateObjects(s3Client, config.s3.bucket);
    const objects: BackupObjectRecord[] = [];
    let totalBytes = 0;
    for (const summary of summaries) {
      const bytes = await getObjectBytes(s3Client, config.s3.bucket, summary.key);
      const sha256 = sha256Hex(bytes);
      const relativePath = objectRelativePath(sha256);
      const absolute = join(objectsDir, relativePath);
      await mkdir(join(objectsDir, sha256.slice(0, 2)), { recursive: true });
      await writeFile(absolute, bytes);
      // Re-hash the bytes we actually wrote so the index never trusts memory alone.
      const written = await hashFile(absolute);
      if (written.sha256 !== sha256 || written.size !== bytes.length) {
        throw new AdminCliError("BackupFailed", `object ${summary.key} failed write verification`);
      }
      objects.push({ key: summary.key, relativePath, sizeBytes: bytes.length, sha256 });
      totalBytes += bytes.length;
      objectCounter.inc();
      byteCounter.inc(bytes.length);
    }

    const index: BackupIndexV1 = {
      version: "backup-index/v1",
      createdAt,
      productVersion: config.productVersion,
      database: {
        dumpFile: BACKUP_DATABASE_DUMP,
        format: "custom",
        sizeBytes: dumpDigest.size,
        sha256: dumpDigest.sha256,
        schemaVersion,
        snapshotId,
      },
      objects,
      tenants: tenantsFromKeys(objects.map((object) => object.key)),
      objectCount: objects.length,
      totalObjectBytes: totalBytes,
      ...(deps.migration === undefined ? {} : { migration: deps.migration }),
    };

    const canonicalIndex = canonicalizeIndex(index);
    await writeFile(join(stagingDir, BACKUP_INDEX_FILE), canonicalIndex, "utf8");
    if (canonicalizeIndex(parseIndex(canonicalIndex)) !== canonicalIndex) {
      throw new AdminCliError("BackupFailed", "the durable backup index failed verification");
    }
    // The completion marker is written last: an unmarked directory is never trusted.
    await writeFile(join(stagingDir, BACKUP_COMPLETE_MARKER), `${createdAt}\n`, "utf8");

    await rm(finalDir, { recursive: true, force: true });
    await rename(stagingDir, finalDir);

    logger.info("backup complete", {
      directory: finalDir,
      objectCount: index.objectCount,
      totalObjectBytes: totalBytes,
      schemaVersion,
    });
    return { directory: finalDir, index };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof AdminCliError) {
      throw error;
    }
    throw new AdminCliError("BackupFailed", "the backup could not be completed", { cause: error });
  } finally {
    if (ownsClient) {
      s3Client.destroy();
    }
    await lease.release();
  }
}

/**
 * Open a `REPEATABLE READ` transaction, export its snapshot id, run the caller
 * (which must complete its dump before the snapshot session ends), and always
 * roll the transaction back. Holding the transaction open guarantees the
 * exported snapshot remains importable by `pg_dump --snapshot`.
 */
async function withExportedSnapshot<T>(
  config: SelfHostedAdminConfig,
  use: (snapshotId: string) => Promise<T>,
): Promise<T> {
  const client = new Client(config.postgres.admin);
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const row = await client.query<{ snapshot: string }>("SELECT pg_export_snapshot() AS snapshot");
    const snapshotId = row.rows[0]?.snapshot;
    if (snapshotId === undefined) {
      throw new AdminCliError("BackupFailed", "unable to export a database snapshot");
    }
    const result = await use(snapshotId);
    await client.query("ROLLBACK");
    return result;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const { createReadStream } = await import("node:fs");
  const info = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return { sha256: hash.digest("hex"), size: info.size };
}
