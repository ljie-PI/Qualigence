import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { redactSecrets } from "./config.js";
import { LauncherError } from "./errors.js";

/** A single file captured inside a backup, with its verifiable digest. */
export interface BackupFile {
  /** Path relative to the backup directory. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** An artifact-store entry recorded (not copied) for restore planning. */
export interface ArtifactInventoryEntry {
  /** Path relative to the artifact directory. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** The verified, self-describing record of a point-in-time backup. */
export interface BackupManifest {
  readonly reason: string;
  readonly createdAt: string;
  readonly productVersion: string;
  readonly schemaVersion: number;
  /** Absolute path of the finalized backup directory. */
  readonly directory: string;
  readonly files: readonly BackupFile[];
  readonly artifactInventory: readonly ArtifactInventoryEntry[];
  readonly complete: boolean;
}

export interface BackupManagerOptions {
  readonly dataDir: string;
  readonly dbFile: string;
  readonly artifactDir: string;
  readonly productVersion: string;
  /** Optional config file copied into the backup with secrets redacted. */
  readonly configFile?: string;
  /** Injectable ISO-8601 clock for deterministic tests. */
  readonly now?: () => string;
}

const COMPLETE_MARKER = "backup-complete";
const MANIFEST_FILE = "backup-manifest.json";
const DATABASE_COPY = "database.db";
const CONFIG_COPY = "config.yaml";

/**
 * Creates consistent, verifiable point-in-time backups of the local SQLite
 * database and an inventory of the artifact store. The database is captured via
 * SQLite's online backup API (never a raw file copy of a live database), so an
 * active WAL writer cannot corrupt the snapshot. The finalized directory is
 * produced atomically: everything is written to a staging directory, a
 * completion marker is written last, and only then is the directory renamed
 * into place.
 */
export class BackupManager {
  private readonly options: BackupManagerOptions;
  private readonly now: () => string;

  constructor(options: BackupManagerOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get backupRoot(): string {
    return join(this.options.dataDir, "backups");
  }

  async create(reason: string): Promise<BackupManifest> {
    const createdAt = this.now();
    const slug = createdAt.replace(/[:.]/g, "-");
    const finalDir = join(this.backupRoot, slug);
    const stagingDir = join(this.backupRoot, `.staging-${slug}`);

    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    try {
      const schemaVersion = await this.copyDatabase(stagingDir);
      const files: BackupFile[] = [];
      files.push(await this.describeFile(stagingDir, DATABASE_COPY));

      const configCopy = await this.copyConfig(stagingDir);
      if (configCopy !== undefined) {
        files.push(configCopy);
      }

      const artifactInventory = await this.inventoryArtifacts();

      const manifest: BackupManifest = {
        reason,
        createdAt,
        productVersion: this.options.productVersion,
        schemaVersion,
        directory: finalDir,
        files,
        artifactInventory,
        complete: true,
      };

      await writeFile(
        join(stagingDir, MANIFEST_FILE),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );
      // The completion marker is written last so a crash mid-backup is
      // detectable: an unmarked directory is never trusted.
      await writeFile(join(stagingDir, COMPLETE_MARKER), `${createdAt}\n`, "utf8");

      await rm(finalDir, { recursive: true, force: true });
      await rename(stagingDir, finalDir);

      return manifest;
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      if (error instanceof LauncherError) {
        throw error;
      }
      throw new LauncherError("BackupFailed", "Failed to create a local backup.", {
        cause: error,
      });
    }
  }

  async verify(manifest: BackupManifest): Promise<boolean> {
    try {
      const marker = join(manifest.directory, COMPLETE_MARKER);
      if (!(await pathExists(marker)) || !manifest.complete) {
        return false;
      }

      for (const file of manifest.files) {
        const absolute = join(manifest.directory, file.path);
        if (!(await pathExists(absolute))) {
          return false;
        }
        const digest = await hashFile(absolute);
        if (digest !== file.sha256) {
          return false;
        }
      }

      const databaseCopy = join(manifest.directory, DATABASE_COPY);
      const schemaVersion = readSchemaVersion(databaseCopy);
      if (schemaVersion !== manifest.schemaVersion) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  private async copyDatabase(stagingDir: string): Promise<number> {
    const destination = join(stagingDir, DATABASE_COPY);
    let source: BetterSqlite3.Database;
    try {
      source = new BetterSqlite3(this.options.dbFile, { fileMustExist: true });
    } catch (error) {
      throw new LauncherError(
        "BackupFailed",
        `Unable to open the source database at ${this.options.dbFile}.`,
        { cause: error },
      );
    }

    try {
      await source.backup(destination);
    } catch (error) {
      throw new LauncherError("BackupFailed", "SQLite online backup failed.", {
        cause: error,
      });
    } finally {
      source.close();
    }

    return readSchemaVersion(destination);
  }

  private async copyConfig(stagingDir: string): Promise<BackupFile | undefined> {
    const configFile = this.options.configFile;
    if (configFile === undefined || !(await pathExists(configFile))) {
      return undefined;
    }

    const raw = await readFile(configFile, "utf8");
    const parsed = parseYaml(raw) as unknown;
    const redacted = redactSecrets(parsed);
    await writeFile(join(stagingDir, CONFIG_COPY), stringifyYaml(redacted), "utf8");
    return this.describeFile(stagingDir, CONFIG_COPY);
  }

  private async inventoryArtifacts(): Promise<ArtifactInventoryEntry[]> {
    if (!(await pathExists(this.options.artifactDir))) {
      return [];
    }
    const entries: ArtifactInventoryEntry[] = [];
    for await (const file of walkFiles(this.options.artifactDir)) {
      const info = await stat(file);
      entries.push({
        path: relative(this.options.artifactDir, file).split(sep).join("/"),
        sizeBytes: info.size,
        sha256: await hashFile(file),
      });
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    return entries;
  }

  private async describeFile(baseDir: string, name: string): Promise<BackupFile> {
    const absolute = join(baseDir, name);
    const info = await stat(absolute);
    return {
      path: name,
      sizeBytes: info.size,
      sha256: await hashFile(absolute),
    };
  }
}

function readSchemaVersion(dbFile: string): number {
  const db = new BetterSqlite3(dbFile, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    return row.version ?? 0;
  } finally {
    db.close();
  }
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
