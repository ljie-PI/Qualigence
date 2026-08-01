import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { SqliteRuntime } from "@qualigence/sqlite-runtime";
import { SystemClock } from "@qualigence/shared-kernel";
import { BackupManager } from "../../../apps/local-launcher/src/backup-manager.js";
import { MigrationGuard } from "../../../apps/local-launcher/src/migration-guard.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

interface Fixture {
  readonly dataDir: string;
  readonly dbFile: string;
  readonly artifactDir: string;
  readonly liveConnection: BetterSqlite3.Database;
}

/** Build a data dir with a migrated, *active* WAL database and an artifact tree. */
async function makeFixture(name: string): Promise<Fixture> {
  const dataDir = await mkdtemp(join(process.cwd(), `.tmp-backup-${name}-`));
  const dbFile = join(dataDir, "qualigence.db");
  const artifactDir = join(dataDir, "artifacts");
  await mkdir(join(artifactDir, "run-1"), { recursive: true });
  await writeFile(join(artifactDir, "run-1", "screenshot.png"), "fake-bytes");

  const runtime = await SqliteRuntime.open({
    filename: dbFile,
    busyTimeoutMs: 5_000,
    clock: new SystemClock(),
  });
  await runtime.close();

  // Keep a live WAL writer open so the backup must capture a consistent snapshot.
  const liveConnection = new BetterSqlite3(dbFile);
  liveConnection.pragma("journal_mode = WAL");
  liveConnection.prepare("CREATE TABLE IF NOT EXISTS scratch (id INTEGER)").run();
  liveConnection.prepare("INSERT INTO scratch (id) VALUES (1)").run();

  cleanups.push(async () => {
    liveConnection.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  return { dataDir, dbFile, artifactDir, liveConnection };
}

function manager(fixture: Fixture): BackupManager {
  return new BackupManager({
    dataDir: fixture.dataDir,
    dbFile: fixture.dbFile,
    artifactDir: fixture.artifactDir,
    productVersion: "9.9.9",
  });
}

describe("BackupManager", () => {
  it("creates a consistent, verifiable point-in-time backup of an active DB", async () => {
    const fixture = await makeFixture("consistent");
    const backups = manager(fixture);

    const backup = await backups.create("before schema 2");

    expect(backup.complete).toBe(true);
    expect(backup.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(backup.files.some((file) => file.path.endsWith("database.db"))).toBe(true);
    expect(await backups.verify(backup)).toBe(true);

    // The backed-up database reopens at the same schema version.
    const backupDb = new BetterSqlite3(join(backup.directory, "database.db"), {
      readonly: true,
    });
    const row = backupDb
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    backupDb.close();
    expect(row.version).toBe(backup.schemaVersion);
  });

  it("records an artifact inventory without copying the artifact bytes", async () => {
    const fixture = await makeFixture("inventory");
    const backups = manager(fixture);

    const backup = await backups.create("inventory check");

    expect(backup.artifactInventory.length).toBeGreaterThan(0);
    const entries = await readdir(backup.directory);
    // The large artifact bytes are inventoried, not copied into the backup dir.
    expect(entries).not.toContain("artifacts");
  });

  it("fails when the source database cannot be copied", async () => {
    const fixture = await makeFixture("copy-failure");
    const broken = new BackupManager({
      dataDir: fixture.dataDir,
      dbFile: join(fixture.dataDir, "does-not-exist.db"),
      artifactDir: fixture.artifactDir,
      productVersion: "9.9.9",
    });

    await expect(broken.create("doomed")).rejects.toMatchObject({ code: "BackupFailed" });
  });

  it("reports an incomplete backup as unverifiable", async () => {
    const fixture = await makeFixture("incomplete");
    const backups = manager(fixture);
    const backup = await backups.create("incomplete");

    await rm(join(backup.directory, "backup-complete"), { force: true });
    expect(await backups.verify(backup)).toBe(false);
  });

  it("detects a corrupted backup file via hash mismatch", async () => {
    const fixture = await makeFixture("mismatch");
    const backups = manager(fixture);
    const backup = await backups.create("mismatch");

    await writeFile(join(backup.directory, "database.db"), "tampered");
    expect(await backups.verify(backup)).toBe(false);
  });
});

describe("MigrationGuard", () => {
  it("runs the migration only after a fresh, verified backup", async () => {
    const fixture = await makeFixture("guard-ok");
    const backups = manager(fixture);
    const guard = new MigrationGuard(backups);
    const backup = await backups.create("before schema 2");
    const migrate = vi.fn(async () => undefined);

    await guard.run(backup, migrate);

    expect(migrate).toHaveBeenCalledOnce();
  });

  it("refuses to migrate when the backup fails verification", async () => {
    const fixture = await makeFixture("guard-block");
    const backups = manager(fixture);
    const guard = new MigrationGuard(backups);
    const backup = await backups.create("before schema 2");
    await writeFile(join(backup.directory, "database.db"), "tampered");
    const migrate = vi.fn(async () => undefined);

    await expect(guard.run(backup, migrate)).rejects.toMatchObject({ code: "MigrationBlocked" });
    expect(migrate).not.toHaveBeenCalled();
  });

  it("creates and verifies a backup before running a guarded migration", async () => {
    const fixture = await makeFixture("guard-protect");
    const backups = manager(fixture);
    const guard = new MigrationGuard(backups);
    const migrate = vi.fn(async () => undefined);

    const backup = await guard.protect("before upgrade", migrate);

    expect(migrate).toHaveBeenCalledOnce();
    expect(backup.complete).toBe(true);
    expect(await backups.verify(backup)).toBe(true);
  });
});
