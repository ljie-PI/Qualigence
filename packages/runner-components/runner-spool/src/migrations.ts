import type BetterSqlite3 from "better-sqlite3";

/**
 * Current spool schema version, tracked via SQLite's `PRAGMA user_version`.
 */
export const SPOOL_SCHEMA_VERSION = 1;

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

const MIGRATIONS: readonly SpoolMigration[] = [migration001];

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
