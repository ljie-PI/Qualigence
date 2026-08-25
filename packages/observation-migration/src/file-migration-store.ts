import { createHash } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ObservationMigrationStore,
  StoredObservationMigration,
} from "./migration-runner.js";
import { OBSERVATION_MIGRATOR_VERSION } from "./pre-v1-projector.js";

/**
 * A durable, append-only, resumable {@link ObservationMigrationStore} backed by
 * a JSONL ledger file. Each successful migration appends exactly one line; a
 * crash mid-run leaves a truncated final line that is skipped on reload, so a
 * resumed run replays only the assets that were never durably recorded.
 *
 * The ledger is content-keyed by `(assetId, sourceHash)`: a re-run with an
 * unchanged source finds the existing line and never re-projects, and a changed
 * source becomes a new attempt. Historical source assets are never touched — the
 * ledger is a derived, additive record.
 *
 * This is deliberately NOT wired into the shared multi-tenant relational schema:
 * the migration ledger is an operator artifact, not tenant-owned data, so it
 * lives in an operator-controlled file rather than adding a table that the
 * relational-schema conformance/RLS invariants would have to police.
 */
export class FileObservationMigrationStore implements ObservationMigrationStore {
  private cache: Map<string, StoredObservationMigration> | undefined;

  constructor(private readonly ledgerPath: string) {}

  async find(
    assetId: string,
    sourceHash: string,
    migratorVersion: string = OBSERVATION_MIGRATOR_VERSION,
  ): Promise<StoredObservationMigration | undefined> {
    const cache = await this.load();
    return cache.get(this.key(assetId, sourceHash, migratorVersion));
  }

  async append(record: StoredObservationMigration): Promise<void> {
    const cache = await this.load();
    const key = this.key(
      record.result.assetId,
      record.result.sourceHash,
      record.result.migratorVersion,
    );
    if (cache.has(key)) {
      return;
    }
    const line = `${JSON.stringify(record)}\n`;
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    // A single small JSONL append is atomic on POSIX; a torn tail is skipped on
    // reload, so a crash can never corrupt an already-recorded entry.
    await appendFile(this.ledgerPath, line, "utf8");
    cache.set(key, record);
  }

  async list(): Promise<readonly StoredObservationMigration[]> {
    const cache = await this.load();
    return [...cache.values()];
  }

  private async load(): Promise<Map<string, StoredObservationMigration>> {
    if (this.cache !== undefined) {
      return this.cache;
    }
    const cache = new Map<string, StoredObservationMigration>();
    let raw: string;
    try {
      raw = await readFile(this.ledgerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = cache;
        return cache;
      }
      throw error;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      let record: StoredObservationMigration;
      try {
        record = JSON.parse(trimmed) as StoredObservationMigration;
      } catch {
        // A torn final line from an interrupted append: skip it and resume.
        continue;
      }
      cache.set(
        this.key(
          record.result.assetId,
          record.result.sourceHash,
          record.result.migratorVersion,
        ),
        record,
      );
    }
    this.cache = cache;
    return cache;
  }

  private key(
    assetId: string,
    sourceHash: string,
    migratorVersion: string | undefined,
  ): string {
    const hash = createHash("sha256")
      .update(assetId)
      .update("\u0000")
      .update(sourceHash);
    if (migratorVersion !== undefined) {
      hash.update("\u0000").update(migratorVersion);
    }
    return hash.digest("hex");
  }
}
