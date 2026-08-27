import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { MetricsRegistry, StructuredLogger } from "@qualigence/observability";
import type { SelfHostedAdminConfig } from "./../config.js";
import { AdminCliError } from "./../errors.js";
import type { PgToolRunner } from "./../pg-tools.js";
import { BackupLease } from "./../backup/backup-lease.js";
import { createS3Client, getObjectBytes } from "./../s3-ops.js";
import {
  BACKUP_COMPLETE_MARKER,
  BACKUP_DATABASE_DUMP,
  BACKUP_INDEX_FILE,
  BACKUP_OBJECTS_DIR,
  backupTargetBinding,
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
  readonly acquireLease?: (config: SelfHostedAdminConfig["postgres"]["admin"]) => Promise<{ release(): Promise<void> }>;
  readonly withSnapshot?: typeof withExportedSnapshot;
  readonly readObject?: (key: string) => Promise<Uint8Array>;
}

export interface SnapshotArtifactManifest {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface BackupSnapshot {
  readonly snapshotId: string;
  readonly schemaVersion: number;
  readonly artifactManifests: readonly SnapshotArtifactManifest[];
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
  const s3Client = deps.s3Client ?? (deps.readObject === undefined ? createS3Client(config.s3) : undefined);
  const ownsClient = deps.s3Client === undefined && s3Client !== undefined;

  logger.info("backup started", { directory: finalDir });
  const lease = await (deps.acquireLease ?? BackupLease.acquire)(config.postgres.admin);
  try {
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(objectsDir, { recursive: true });

    // 1. Consistent database dump pinned to an exported snapshot.
    const snapshot = await (deps.withSnapshot ?? withExportedSnapshot)(config, async (captured) => {
      await deps.pgTool.dump(config.postgres.admin, {
        snapshotId: captured.snapshotId,
        outFile: join(stagingDir, BACKUP_DATABASE_DUMP),
      });
      return captured;
    });
    const dumpDigest = await hashFile(join(stagingDir, BACKUP_DATABASE_DUMP));

    // 2. Copy exactly the objects referenced by snapshot-visible manifests.
    const objects: BackupObjectRecord[] = [];
    let totalBytes = 0;
    for (const manifest of snapshot.artifactManifests) {
      const bytes = await (deps.readObject ?? ((key) => {
        if (s3Client === undefined) throw new Error("S3 client is unavailable");
        return getObjectBytes(s3Client, config.s3.bucket, key);
      }))(manifest.key);
      const sha256 = sha256Hex(bytes);
      if (bytes.length !== manifest.sizeBytes || sha256 !== manifest.sha256) {
        throw new AdminCliError("BackupFailed", `object ${manifest.key} does not match its snapshot manifest`);
      }
      const relativePath = objectRelativePath(sha256);
      const absolute = join(objectsDir, relativePath);
      await mkdir(join(objectsDir, sha256.slice(0, 2)), { recursive: true });
      await writeFile(absolute, bytes);
      // Re-hash the bytes we actually wrote so the index never trusts memory alone.
      const written = await hashFile(absolute);
      if (written.sha256 !== sha256 || written.size !== bytes.length) {
        throw new AdminCliError("BackupFailed", `object ${manifest.key} failed write verification`);
      }
      objects.push({ key: manifest.key, relativePath, sizeBytes: bytes.length, sha256 });
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
        schemaVersion: snapshot.schemaVersion,
        snapshotId: snapshot.snapshotId,
      },
      target: backupTargetBinding(config),
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
      schemaVersion: snapshot.schemaVersion,
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
      s3Client?.destroy();
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
  use: (snapshot: BackupSnapshot) => Promise<T>,
): Promise<T> {
  const client = new Client(config.postgres.admin);
  await client.connect();
  let completed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const row = await client.query<{ snapshot: string }>("SELECT pg_export_snapshot() AS snapshot");
    const snapshotId = row.rows[0]?.snapshot;
    if (snapshotId === undefined) {
      throw new AdminCliError("BackupFailed", "unable to export a database snapshot");
    }
    const tables = await client.query<{ migrations: boolean; manifests: boolean }>(`
      select to_regclass('public.schema_migrations') is not null as migrations,
             to_regclass('public.artifact_manifests') is not null as manifests
    `);
    const versions = tables.rows[0]?.migrations === true
      ? await client.query<{ version: number }>("select version from schema_migrations order by version")
      : { rows: [] };
    const schemaVersion = Number(versions.rows.at(-1)?.version ?? 0);
    const manifests = tables.rows[0]?.manifests === true
      ? await client.query<{ key: string; sha256: string; size_bytes: string | number }>(
          `select relative_path as key, sha256, size_bytes
             from artifact_manifests order by relative_path`,
        )
      : { rows: [] };
    const result = await use({
      snapshotId,
      schemaVersion,
      artifactManifests: manifests.rows.map((manifest) => ({
        key: manifest.key,
        sha256: manifest.sha256,
        sizeBytes: Number(manifest.size_bytes),
      })),
    });
    await client.query("ROLLBACK");
    completed = true;
    return result;
  } finally {
    if (!completed) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
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
