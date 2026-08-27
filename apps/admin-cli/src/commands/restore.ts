import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { MetricsRegistry, StructuredLogger } from "@qualigence/observability";
import {
  SUPPORTED_SCHEMA_VERSION,
  tenantOwnedTableNames,
  tenantOwnedTableNamesThroughVersion,
} from "@qualigence/relational-kysely";
import { readSchemaVersion } from "@qualigence/postgres-runtime";
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
  BACKUP_DATABASE_DUMP,
  BACKUP_OBJECTS_DIR,
  backupTargetBinding,
  sha256Hex,
  verifyBackupDirectory,
  type BackupIndexV1,
} from "./../backup/backup-index.js";

const { Client } = pg;

export interface RestoreDeps {
  readonly pgTool: PgToolRunner;
  readonly s3Client?: S3Client;
  readonly logger?: StructuredLogger;
  readonly metrics?: MetricsRegistry;
  /** Pre-dispatch cancel/timeout signal. A pre-aborted signal mutates no target. */
  readonly abortSignal?: AbortSignal;
  /** Skip the empty-target guard (used only when restoring into a scratch DB). */
  readonly allowNonEmptyTarget?: boolean;
  readonly readSchemaVersion?: typeof readSchemaVersion;
  readonly putObject?: (key: string, bytes: Uint8Array) => Promise<void>;
  readonly getObject?: (key: string) => Promise<Uint8Array>;
  readonly enumerateObjects?: () => Promise<readonly { readonly key: string }[]>;
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
    assertNotAborted(deps.abortSignal);
    const index = await verifyBackupDirectory(config.backupDir).catch((error) => {
      throw new AdminCliError("BackupIncomplete", "the backup failed byte verification", {
        cause: error,
      });
    });

    assertBackupSchemaSupported(index);

    const expectedTarget = backupTargetBinding(config);
    if (
      index.target.databaseSha256 !== expectedTarget.databaseSha256 ||
      index.target.objectStoreSha256 !== expectedTarget.objectStoreSha256
    ) {
      throw new AdminCliError("RestoreTargetMismatch", "backup target binding does not match this restore target", {
        details: {
          expected: expectedTarget,
          actual: index.target,
        },
      });
    }

    // 3. Require an empty target unless explicitly restoring into a scratch DB.
    if (deps.allowNonEmptyTarget !== true) {
      await assertEmptyTarget(config, s3Client, deps.enumerateObjects);
    }

    // 4. Restore the database dump, then re-upload every object's real bytes.
    await deps.pgTool.restore(config.postgres.admin, {
      inFile: join(config.backupDir, BACKUP_DATABASE_DUMP),
    });

    const restoredSchemaVersion = await (deps.readSchemaVersion ?? readSchemaVersion)(config.postgres.admin);
    if (
      restoredSchemaVersion !== index.database.schemaVersion ||
      restoredSchemaVersion < 1 ||
      restoredSchemaVersion > SUPPORTED_SCHEMA_VERSION
    ) {
      throw new AdminCliError("RestoreSchemaMismatch", "restored database schema version does not match the backup index", {
        details: {
          expected: index.database.schemaVersion,
          restored: restoredSchemaVersion,
          supported: SUPPORTED_SCHEMA_VERSION,
        },
      });
    }

    for (const object of index.objects) {
      const bytes = await readFile(join(config.backupDir, BACKUP_OBJECTS_DIR, object.relativePath));
      await (deps.putObject ?? ((key, value) => putObjectBytes(s3Client, config.s3.bucket, key, value)))(object.key, bytes);
      restoredCounter.inc();
    }

    // 5. GET every restored object back and re-verify SHA-256/size.
    const verification = await verifyRestoredObjects(config, index, s3Client, deps.getObject);
    if (verification.missing.length > 0 || verification.corrupt.length > 0) {
      throw new AdminCliError("RestoreFailed", "restored objects failed byte verification", {
        details: { missing: verification.missing, corrupt: verification.corrupt },
      });
    }

    // 6. Integrity: forced RLS + composite-key tables survived the restore.
    await assertTenantIntegrity(config, restoredSchemaVersion);

    logger.info("restore complete", {
      restoredObjects: index.objectCount,
      schemaVersion: restoredSchemaVersion,
    });
    return {
      restoredObjects: index.objectCount,
      schemaVersion: restoredSchemaVersion,
      verification,
    };
  } finally {
    if (ownsClient) {
      s3Client.destroy();
    }
  }
}

function assertBackupSchemaSupported(index: BackupIndexV1): void {
  if (index.database.schemaVersion < 1 || index.database.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new AdminCliError("RestoreSchemaMismatch", "backup schema version is not supported by this restore binary", {
      details: {
        expected: index.database.schemaVersion,
        supported: SUPPORTED_SCHEMA_VERSION,
      },
    });
  }
}

async function verifyRestoredObjects(
  config: SelfHostedAdminConfig,
  index: BackupIndexV1,
  s3Client: S3Client,
  getObject: ((key: string) => Promise<Uint8Array>) | undefined,
): Promise<RestoreVerification> {
  const missing: string[] = [];
  const corrupt: string[] = [];
  for (const object of index.objects) {
    let bytes: Uint8Array;
    try {
      bytes = await (getObject ?? ((key) => getObjectBytes(s3Client, config.s3.bucket, key)))(object.key);
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
  enumerate: (() => Promise<readonly { readonly key: string }[]>) | undefined,
): Promise<void> {
  const objects = await (enumerate ?? (() => enumerateObjects(s3Client, config.s3.bucket)))();
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

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AdminCliError("RestoreCancelled", "restore was cancelled before dispatch", {
      details: { reason: abortReason(signal) },
    });
  }
}

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  return reason === undefined ? "aborted" : String(reason);
}

async function assertTenantIntegrity(
  config: SelfHostedAdminConfig,
  schemaVersion: number,
): Promise<void> {
  const client = new Client(config.postgres.admin);
  try {
    await client.connect();
    for (const table of tenantOwnedTableNamesThroughVersion(schemaVersion)) {
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
