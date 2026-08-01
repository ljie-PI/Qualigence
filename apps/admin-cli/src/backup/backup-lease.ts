import pg from "pg";
import type { PgConnectionInfo } from "../pg-tools.js";

const { Client } = pg;

/**
 * The advisory-lock key that guards Artifact garbage collection during a
 * backup. A backup holds this session-level lock for its whole duration; any
 * Artifact GC must try to take the same lock and back off while it is held, so
 * content-addressed object bytes referenced by the in-flight snapshot are never
 * deleted mid-backup.
 */
export const BACKUP_LEASE_LOCK_KEY = 0x5175_616c; // "Qual"

/**
 * A held backup lease. While alive it owns {@link BACKUP_LEASE_LOCK_KEY} on a
 * dedicated session; releasing it (always, even on failure) frees Artifact GC.
 */
export class BackupLease {
  private constructor(private readonly client: pg.Client) {}

  static async acquire(conn: PgConnectionInfo): Promise<BackupLease> {
    const client = new Client(conn);
    await client.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [BACKUP_LEASE_LOCK_KEY]);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    return new BackupLease(client);
  }

  async release(): Promise<void> {
    try {
      await this.client.query("SELECT pg_advisory_unlock($1)", [BACKUP_LEASE_LOCK_KEY]);
    } finally {
      await this.client.end().catch(() => undefined);
    }
  }
}

/**
 * The GC side of the contract: an Artifact GC calls this before deleting object
 * bytes. It returns `false` (deletion must be delayed) whenever a backup holds
 * the lease, and `true` (safe to proceed) otherwise. The caller must release
 * the lock via the returned handle when it is done.
 */
export async function tryAcquireGcLock(
  conn: PgConnectionInfo,
): Promise<{ acquired: boolean; release: () => Promise<void> }> {
  const client = new Client(conn);
  await client.connect();
  const result = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS acquired",
    [BACKUP_LEASE_LOCK_KEY],
  );
  const acquired = result.rows[0]?.acquired === true;
  return {
    acquired,
    release: async () => {
      if (acquired) {
        await client.query("SELECT pg_advisory_unlock($1)", [BACKUP_LEASE_LOCK_KEY]);
      }
      await client.end().catch(() => undefined);
    },
  };
}
