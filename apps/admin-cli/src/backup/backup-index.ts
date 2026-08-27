import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PgConnectionInfo } from "../pg-tools.js";
import type { S3Config } from "../s3-ops.js";

/** The verifiable digest + size of one byte stream captured by a backup. */
export interface BackupObjectRecord {
  /** Content-addressed S3/MinIO object key (immutable). */
  readonly key: string;
  /** Path of the copied byte stream relative to the backup's `objects/` dir. */
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** The verifiable digest + size of the PostgreSQL logical dump. */
export interface BackupDatabaseRecord {
  readonly dumpFile: string;
  readonly format: "custom";
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly schemaVersion: number;
  readonly snapshotId: string;
}

export interface BackupTargetBinding {
  /** Stable non-secret hash of the intended PostgreSQL deployment identity. */
  readonly databaseSha256: string;
  /** Stable non-secret hash of the intended object-store endpoint/bucket. */
  readonly objectStoreSha256: string;
}

export interface MigrationBackupBinding {
  readonly invocationId: string;
  readonly targetDatabaseSha256: string;
  readonly targetSchemaVersion: number;
}

/**
 * The canonical, self-describing manifest that binds a PostgreSQL dump and every
 * copied object byte stream to its SHA-256 and size. A restore validates every
 * entry against the real bytes on disk before it mutates any target, so a
 * Manifest-only export or a corrupted/missing byte stream can never be mistaken
 * for a successful backup.
 */
export interface BackupIndexV1 {
  readonly version: "backup-index/v1";
  /** Operator invocation that produced this backup; prevents stale success reuse. */
  readonly invocationId: string;
  readonly createdAt: string;
  readonly productVersion: string;
  readonly database: BackupDatabaseRecord;
  /** Non-secret target binding: restore rejects a backup for another deployment. */
  readonly target: BackupTargetBinding;
  readonly objects: readonly BackupObjectRecord[];
  /** Distinct tenants observed across the object keyspace, for a sanity check. */
  readonly tenants: readonly string[];
  readonly objectCount: number;
  readonly totalObjectBytes: number;
  readonly migration?: MigrationBackupBinding;
}

/** The name of the file that carries the canonical index inside a backup. */
export const BACKUP_INDEX_FILE = "backup-index.json";
/** Written last, after every check passes, so a partial backup is never trusted. */
export const BACKUP_COMPLETE_MARKER = "backup-complete";
/** The directory (relative to a backup root) that holds copied object bytes. */
export const BACKUP_OBJECTS_DIR = "objects";
/** The PostgreSQL custom-format dump file name inside a backup. */
export const BACKUP_DATABASE_DUMP = "database.dump";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Serialize an index with stable key ordering so its bytes are reproducible and
 * can themselves be hashed/compared. Objects are sorted by key.
 */
export function canonicalizeIndex(index: BackupIndexV1): string {
  const sortedObjects = [...index.objects].sort((a, b) => a.key.localeCompare(b.key));
  const canonical = {
    version: index.version,
    invocationId: index.invocationId,
    createdAt: index.createdAt,
    productVersion: index.productVersion,
    database: {
      dumpFile: index.database.dumpFile,
      format: index.database.format,
      sizeBytes: index.database.sizeBytes,
      sha256: index.database.sha256,
      schemaVersion: index.database.schemaVersion,
      snapshotId: index.database.snapshotId,
    },
    target: {
      databaseSha256: index.target.databaseSha256,
      objectStoreSha256: index.target.objectStoreSha256,
    },
    objects: sortedObjects.map((object) => ({
      key: object.key,
      relativePath: object.relativePath,
      sizeBytes: object.sizeBytes,
      sha256: object.sha256,
    })),
    tenants: [...index.tenants].sort((a, b) => a.localeCompare(b)),
    objectCount: index.objectCount,
    totalObjectBytes: index.totalObjectBytes,
    ...(index.migration === undefined
      ? {}
      : {
          migration: {
            invocationId: index.migration.invocationId,
            targetDatabaseSha256: index.migration.targetDatabaseSha256,
            targetSchemaVersion: index.migration.targetSchemaVersion,
          },
        }),
  };
  return JSON.stringify(canonical, null, 2);
}

/** Parse a canonical index and validate its shape (never trusts an alien file). */
export function parseIndex(text: string): BackupIndexV1 {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("backup index must be an object");
  }
  const candidate = raw as Partial<BackupIndexV1>;
  if (candidate.version !== "backup-index/v1") {
    throw new Error(`unsupported backup index version: ${String(candidate.version)}`);
  }
  if (typeof candidate.invocationId !== "string" || candidate.invocationId.length === 0) {
    throw new Error("backup index is missing its invocation id");
  }
  if (candidate.database === undefined || candidate.target === undefined || !Array.isArray(candidate.objects)) {
    throw new Error("backup index is missing its database record, target binding, or objects");
  }
  if (
    candidate.database.dumpFile !== BACKUP_DATABASE_DUMP ||
    candidate.database.format !== "custom" ||
    !isNonNegativeInteger(candidate.database.sizeBytes) ||
    !isSha256(candidate.database.sha256) ||
    !isNonNegativeInteger(candidate.database.schemaVersion) ||
    typeof candidate.database.snapshotId !== "string" ||
    candidate.database.snapshotId.length === 0
  ) {
    throw new Error("backup index has an invalid database record");
  }
  if (!isSha256(candidate.target.databaseSha256) || !isSha256(candidate.target.objectStoreSha256)) {
    throw new Error("backup index has an invalid target binding");
  }
  const keys = new Set<string>();
  for (const object of candidate.objects) {
    if (
      typeof object.key !== "string" || object.key.length === 0 || keys.has(object.key) ||
      !isSha256(object.sha256) ||
      object.relativePath !== objectRelativePath(object.sha256) ||
      !isNonNegativeInteger(object.sizeBytes)
    ) {
      throw new Error("backup index has an invalid or duplicate object record");
    }
    keys.add(object.key);
  }
  if (
    candidate.objectCount !== candidate.objects.length ||
    !isNonNegativeInteger(candidate.totalObjectBytes) ||
    candidate.totalObjectBytes !== candidate.objects.reduce((total, object) => total + object.sizeBytes, 0)
  ) {
    throw new Error("backup index object totals do not match its records");
  }
  if (candidate.migration !== undefined && (
    typeof candidate.migration.invocationId !== "string" ||
    candidate.migration.invocationId.length === 0 ||
    !isSha256(candidate.migration.targetDatabaseSha256) ||
    !isNonNegativeInteger(candidate.migration.targetSchemaVersion)
  )) {
    throw new Error("backup index has an invalid migration binding");
  }
  return candidate as BackupIndexV1;
}

export function databaseTargetSha256(connection: Pick<PgConnectionInfo, "host" | "port" | "database">): string {
  return createHash("sha256")
    .update(`${connection.host.toLowerCase()}:${connection.port}/${connection.database}`)
    .digest("hex");
}

export function objectStoreTargetSha256(config: Pick<S3Config, "region" | "endpoint" | "bucket" | "forcePathStyle">): string {
  return createHash("sha256")
    .update([
      config.region.toLowerCase(),
      config.endpoint?.toLowerCase() ?? "",
      config.bucket,
      config.forcePathStyle ? "path-style" : "virtual-hosted",
    ].join("\0"))
    .digest("hex");
}

export function backupTargetBinding(config: {
  readonly postgres: { readonly admin: Pick<PgConnectionInfo, "host" | "port" | "database"> };
  readonly s3: Pick<S3Config, "region" | "endpoint" | "bucket" | "forcePathStyle">;
}): BackupTargetBinding {
  return {
    databaseSha256: databaseTargetSha256(config.postgres.admin),
    objectStoreSha256: objectStoreTargetSha256(config.s3),
  };
}

export async function verifyBackupDirectory(directory: string): Promise<BackupIndexV1> {
  await stat(join(directory, BACKUP_COMPLETE_MARKER)).catch(() => {
    throw new Error("backup completion marker is missing");
  });
  const indexText = await readFile(join(directory, BACKUP_INDEX_FILE), "utf8");
  const index = parseIndex(indexText);
  if (canonicalizeIndex(index) !== indexText) {
    throw new Error("backup index is not canonical");
  }
  await verifyFile(
    join(directory, index.database.dumpFile),
    index.database.sizeBytes,
    index.database.sha256,
    "database dump",
  );
  for (const object of index.objects) {
    await verifyFile(
      join(directory, BACKUP_OBJECTS_DIR, object.relativePath),
      object.sizeBytes,
      object.sha256,
      `object ${object.key}`,
    );
  }
  return index;
}

async function verifyFile(
  path: string,
  expectedSize: number,
  expectedSha256: string,
  label: string,
): Promise<void> {
  const bytes = await readFile(path).catch(() => {
    throw new Error(`backup ${label} is missing`);
  });
  if (bytes.length !== expectedSize || sha256Hex(bytes) !== expectedSha256) {
    throw new Error(`backup ${label} failed byte verification`);
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Derive the content-addressed relative path for an object's bytes inside the
 * backup. Sharding by the SHA prefix keeps directory fan-out bounded and mirrors
 * the store's own `<sha-prefix>/<sha>` layout so identical bytes are stored once.
 */
export function objectRelativePath(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256}`;
}

/** Distinct tenant ids parsed from `<tenant>/<project>/...` object keys. */
export function tenantsFromKeys(keys: readonly string[]): string[] {
  const tenants = new Set<string>();
  for (const key of keys) {
    const tenant = key.split("/")[0];
    if (tenant !== undefined && tenant.length > 0) {
      tenants.add(tenant);
    }
  }
  return [...tenants].sort((a, b) => a.localeCompare(b));
}
