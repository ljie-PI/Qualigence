import { createHash } from "node:crypto";

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

/**
 * The canonical, self-describing manifest that binds a PostgreSQL dump and every
 * copied object byte stream to its SHA-256 and size. A restore validates every
 * entry against the real bytes on disk before it mutates any target, so a
 * Manifest-only export or a corrupted/missing byte stream can never be mistaken
 * for a successful backup.
 */
export interface BackupIndexV1 {
  readonly version: "backup-index/v1";
  readonly createdAt: string;
  readonly productVersion: string;
  readonly database: BackupDatabaseRecord;
  readonly objects: readonly BackupObjectRecord[];
  /** Distinct tenants observed across the object keyspace, for a sanity check. */
  readonly tenants: readonly string[];
  readonly objectCount: number;
  readonly totalObjectBytes: number;
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
    objects: sortedObjects.map((object) => ({
      key: object.key,
      relativePath: object.relativePath,
      sizeBytes: object.sizeBytes,
      sha256: object.sha256,
    })),
    tenants: [...index.tenants].sort((a, b) => a.localeCompare(b)),
    objectCount: index.objectCount,
    totalObjectBytes: index.totalObjectBytes,
  };
  return JSON.stringify(canonical, null, 2);
}

/** Parse a canonical index and validate its shape (never trusts an alien file). */
export function parseIndex(text: string): BackupIndexV1 {
  const raw = JSON.parse(text) as Partial<BackupIndexV1>;
  if (raw.version !== "backup-index/v1") {
    throw new Error(`unsupported backup index version: ${String(raw.version)}`);
  }
  if (raw.database === undefined || !Array.isArray(raw.objects)) {
    throw new Error("backup index is missing its database record or objects");
  }
  return raw as BackupIndexV1;
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
