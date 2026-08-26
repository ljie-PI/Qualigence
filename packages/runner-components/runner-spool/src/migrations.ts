import type BetterSqlite3 from "better-sqlite3";

/**
 * Current spool schema version, tracked via SQLite's `PRAGMA user_version`.
 */
export const SPOOL_SCHEMA_VERSION = 4;

export interface SpoolMigration {
  readonly version: number;
  apply(db: BetterSqlite3.Database): void;
}

const migration001: SpoolMigration = {
  version: 1,
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spool_events (
        run_id TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence_number)
      );

      CREATE TABLE IF NOT EXISTS spool_cursors (
        run_id TEXT PRIMARY KEY NOT NULL,
        next_ack_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS spool_leases (
        job_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        encrypted_token BLOB NOT NULL,
        token_nonce BLOB NOT NULL,
        token_tag BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};

const migration002: SpoolMigration = {
  version: 2,
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spool_artifact_manifests (
        artifact_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        chunk_size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS spool_artifact_chunks (
        artifact_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        offset_bytes INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (artifact_id, offset_bytes),
        FOREIGN KEY (artifact_id) REFERENCES spool_artifact_manifests(artifact_id) ON DELETE CASCADE
      );
    `);
  },
};

const migration003: SpoolMigration = {
  version: 3,
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spool_resume_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        session_id TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        encrypted_token BLOB NOT NULL,
        token_nonce BLOB NOT NULL,
        token_tag BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};

const migration004: SpoolMigration = {
  version: 4,
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spool_artifact_progress (
        artifact_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (artifact_id) REFERENCES spool_artifact_manifests(artifact_id) ON DELETE CASCADE
      );
    `);
  },
};

const MIGRATIONS: readonly SpoolMigration[] = [migration001, migration002, migration003, migration004];

/**
 * Apply any pending schema migrations to the spool database. Migrations are
 * idempotent and tracked with `PRAGMA user_version`, so reopening an existing
 * spool file after a restart recovers its schema without touching spooled data.
 */
export function migrateSpool(db: BetterSqlite3.Database): void {
  const current = Number(db.pragma("user_version", { simple: true }));
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    const run = db.transaction(() => {
      migration.apply(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    run();
  }
}
