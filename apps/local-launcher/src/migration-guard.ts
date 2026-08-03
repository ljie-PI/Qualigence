import type { BackupManager, BackupManifest } from "./backup-manager.js";
import { LauncherError } from "./errors.js";

/**
 * Enforces the hard invariant that a pending schema migration is never applied
 * without a fresh, verified backup. The guard re-verifies the backup (marker
 * present, file hashes intact, database reopenable at the recorded schema
 * version) immediately before running the migration, so a stale or corrupted
 * backup can never satisfy the precondition.
 */
export class MigrationGuard {
  private readonly backups: BackupManager;

  constructor(backups: BackupManager) {
    this.backups = backups;
  }

  /**
   * Runs {@link migrate} only if {@link manifest} passes verification. A failed
   * verification refuses the migration with {@link LauncherError} code
   * `MigrationBlocked`, and the migration callback is never invoked.
   */
  async run(manifest: BackupManifest, migrate: () => Promise<void>): Promise<void> {
    const verified = await this.backups.verify(manifest);
    if (!verified) {
      throw new LauncherError(
        "MigrationBlocked",
        "Refusing to run a schema migration without a fresh, verified backup.",
        { details: { backupDirectory: manifest.directory } },
      );
    }
    await migrate();
  }

  /**
   * Creates a fresh backup, verifies it, and then runs the migration. This is
   * the convenience path used by the Launcher: there is no way to reach the
   * migration without a verified backup existing first.
   */
  async protect(reason: string, migrate: () => Promise<void>): Promise<BackupManifest> {
    const manifest = await this.backups.create(reason);
    await this.run(manifest, migrate);
    return manifest;
  }
}
