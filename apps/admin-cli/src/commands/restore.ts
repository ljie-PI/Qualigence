import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { MetricsRegistry, StructuredLogger } from "@qualigence/observability";
import { tenantOwnedTableNames } from "@qualigence/relational-kysely";
import type { SelfHostedAdminConfig } from "./../config.js";
import { AdminCliError } from "./../errors.js";
import type { PgToolRunner } from "./../pg-tools.js";
import {
  createS3Client,
  enumerateObjects,
  getObjectBytes,
  putObjectBytes,
} from "./../s3-ops.js";
import {
  BACKUP_COMPLETE_MARKER,
  BACKUP_DATABASE_DUMP,
  BACKUP_INDEX_FILE,
  BACKUP_OBJECTS_DIR,
  parseIndex,
  sha256Hex,
  type BackupIndexV1,
} from "./../backup/backup-index.js";

const { Client } = pg;

export interface RestoreDeps {
  readonly pgTool: PgToolRunner;
  readonly s3Client?: S3Client;
  readonly logger?: StructuredLogger;
  readonly metrics?: MetricsRegistry;
  /** Skip the empty-target guard (used only when restoring into a scratch DB). */
  readonly allowNonEmptyTarget?: boolean;
}

export interface RestoreVerification {
  readonly missing: readonly string[];
  readonly corrupt: readonly string[];
}

export interface RestoreResult {
  readonly restoredObjects: number;
  readonly schemaVersion: number;
  readonly verification: RestoreVerification;
}

/**
 * Restore a backup into a clean environment, byte-for-byte.
 *
 * The full index and every referenced byte stream (database dump + each object)
 * are validated against their recorded SHA-256/size BEFORE any target is
 * mutated, so a corrupted or missing object — or a Manifest-only export with no
 * completion marker — fails the restore before it touches PostgreSQL or the
 * object store. The database dump is then restored, every object is re-uploaded,
 * and finally every restored object is fetched back and its SHA-256/size are
 * recomputed and compared. A tenant/reference integrity check confirms forced
 * RLS and the composite-key tables survived the round trip.
 */
export async function runRestore(
  config: SelfHostedAdminConfig,
  deps: RestoreDeps,
): Promise<RestoreResult> {
  const logger = deps.logger ?? new StructuredLogger({ service: "admin-cli:restore" });
  const metrics = deps.metrics ?? new MetricsRegistry();
  const restoredCounter = metrics.counter("restore_objects_total", "objects restored");
  const s3Client = deps.s3Client ?? createS3Client(config.s3);
  const ownsClient = deps.s3Client === undefined;

  try {
    // 1. Load and structurally validate the index + completion marker.
    const marker = join(config.backupDir, BACKUP_COMPLETE_MARKER);
    if (!(await exists(marker))) {
      throw new AdminCliError(
        "BackupIncomplete",
        "the backup has no completion marker and cannot be trusted",
      );
    }
    const index = parseIndex(
      await readFile(join(config.backupDir, BACKUP_INDEX_FILE), "utf8"),
    );

    // 2. Verify every backed-up byte stream against the index, before mutating.
    await verifyBackupBytes(config, index);

    // 3. Require an empty target unless explicitly restoring into a scratch DB.
    if (deps.allowNonEmptyTarget !== true) {
      await assertEmptyTarget(config, s3Client);
    }

    // 4. Restore the database dump, then re-upload every object's real bytes.
    await deps.pgTool.restore(config.postgres.admin, {
      inFile: join(config.backupDir, BACKUP_DATABASE_DUMP),
    });

    for (const object of index.objects) {
      const bytes = await readFile(join(config.backupDir, BACKUP_OBJECTS_DIR, object.relativePath));
      await putObjectBytes(s3Client, config.s3.bucket, object.key, bytes);
      restoredCounter.inc();
    }

    // 5. GET every restored object back and re-verify SHA-256/size.
    const verification = await verifyRestoredObjects(config, index, s3Client);
    if (verification.missing.length > 0 || verification.corrupt.length > 0) {
      throw new AdminCliError("RestoreFailed", "restored objects failed byte verification", {
        details: { missing: verification.missing, corrupt: verification.corrupt },
      });
    }

    // 6. Integrity: forced RLS + composite-key tables survived the restore.
    await assertTenantIntegrity(config);

    logger.info("restore complete", {
      restoredObjects: index.objectCount,
      schemaVersion: index.database.schemaVersion,
    });
    return {
      restoredObjects: index.objectCount,
      schemaVersion: index.database.schemaVersion,
      verification,
    };
  } finally {
    if (ownsClient) {
      s3Client.destroy();
    }
  }
}

/** Recompute SHA-256/size for the dump and every object file in the backup. */
async function verifyBackupBytes(
  config: SelfHostedAdminConfig,
  index: BackupIndexV1,
): Promise<void> {
  const dumpPath = join(config.backupDir, BACKUP_DATABASE_DUMP);
  if (!(await exists(dumpPath))) {
    throw new AdminCliError("BackupIncomplete", "the database dump is missing from the backup");
  }
  const dump = await readFile(dumpPath);
  if (dump.length !== index.database.sizeBytes || sha256Hex(dump) !== index.database.sha256) {
    throw new AdminCliError("BackupIncomplete", "the database dump failed integrity verification");
  }
  for (const object of index.objects) {
    const path = join(config.backupDir, BACKUP_OBJECTS_DIR, object.relativePath);
    if (!(await exists(path))) {
      throw new AdminCliError("BackupIncomplete", `backup object bytes are missing for ${object.key}`, {
        details: { key: object.key },
      });
    }
    const bytes = await readFile(path);
    if (bytes.length !== object.sizeBytes || sha256Hex(bytes) !== object.sha256) {
      throw new AdminCliError("BackupIncomplete", `backup object bytes are corrupt for ${object.key}`, {
        details: { key: object.key },
      });
    }
  }
}

async function verifyRestoredObjects(
  config: SelfHostedAdminConfig,
  index: BackupIndexV1,
  s3Client: S3Client,
): Promise<RestoreVerification> {
  const missing: string[] = [];
  const corrupt: string[] = [];
  for (const object of index.objects) {
    let bytes: Uint8Array;
    try {
      bytes = await getObjectBytes(s3Client, config.s3.bucket, object.key);
    } catch {
      missing.push(object.key);
      continue;
    }
    if (bytes.length !== object.sizeBytes || sha256Hex(bytes) !== object.sha256) {
      corrupt.push(object.key);
    }
  }
  return { missing, corrupt };
}

async function assertEmptyTarget(
  config: SelfHostedAdminConfig,
  s3Client: S3Client,
): Promise<void> {
  const objects = await enumerateObjects(s3Client, config.s3.bucket);
  if (objects.length > 0) {
    throw new AdminCliError("RestoreTargetNotEmpty", "the target object store bucket is not empty");
  }
  const client = new Client(config.postgres.admin);
  try {
    await client.connect();
    for (const table of tenantOwnedTableNames()) {
      const exists = await client.query<{ exists: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS exists",
        [`public.${table}`],
      );
      if (exists.rows[0]?.exists === true) {
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::int8 AS count FROM ${table}`,
        );
        if (Number(count.rows[0]?.count ?? "0") > 0) {
          throw new AdminCliError(
            "RestoreTargetNotEmpty",
            `the target database is not empty (${table} has rows)`,
          );
        }
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function assertTenantIntegrity(config: SelfHostedAdminConfig): Promise<void> {
  const client = new Client(config.postgres.admin);
  try {
    await client.connect();
    for (const table of tenantOwnedTableNames()) {
      const row = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)",
        [`public.${table}`],
      );
      const flags = row.rows[0];
      if (flags === undefined || !flags.relrowsecurity || !flags.relforcerowsecurity) {
        throw new AdminCliError(
          "IntegrityViolation",
          `forced row-level security is missing on ${table} after restore`,
          { details: { table } },
        );
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
