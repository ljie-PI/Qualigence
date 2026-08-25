import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ObservationMigrationStore,
  StoredObservationMigration,
} from "./migration-runner.js";
import { OBSERVATION_MIGRATOR_VERSION } from "./pre-v1-projector.js";

const ledgerAppendQueues = new Map<string, Promise<void>>();
const LEDGER_LOCK_WAIT_TIMEOUT_MS = 30_000;
const LEDGER_LOCK_STALE_AFTER_MS = 30_000;
const LEDGER_LOCK_POLL_MS = 10;

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
    const cache = await this.reload();
    return cache.get(this.key(assetId, sourceHash, migratorVersion));
  }

  async append(record: StoredObservationMigration): Promise<void> {
    await serializeLedgerAppend(this.ledgerPath, async () => {
      const cache = await this.reload();
      const key = this.key(
        record.result.assetId,
        record.result.sourceHash,
        record.result.migratorVersion,
      );
      if (cache.has(key)) {
        return;
      }
      const line = `${JSON.stringify(record)}\n`;
      // The per-ledger serializer and lock make check+append atomic for
      // concurrent callers sharing this operator ledger. Reloading while holding
      // that boundary makes sibling store instances observe the winner before
      // writing a JSONL line.
      await appendFile(this.ledgerPath, line, "utf8");
      cache.set(key, record);
      this.cache = cache;
    });
  }

  async list(): Promise<readonly StoredObservationMigration[]> {
    const cache = await this.reload();
    return [...cache.values()];
  }

  private async reload(): Promise<Map<string, StoredObservationMigration>> {
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

async function serializeLedgerAppend(
  ledgerPath: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = ledgerAppendQueues.get(ledgerPath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(ledgerPath), { recursive: true });
    const release = await acquireLedgerLock(`${ledgerPath}.lock`);
    try {
      await operation();
    } finally {
      await release();
    }
  });
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  ledgerAppendQueues.set(ledgerPath, tail);
  try {
    await current;
  } finally {
    if (ledgerAppendQueues.get(ledgerPath) === tail) {
      ledgerAppendQueues.delete(ledgerPath);
    }
  }
}

async function acquireLedgerLock(lockPath: string): Promise<() => Promise<void>> {
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await recoverStaleLedgerLock(lockPath)) {
        continue;
      }
      if (Date.now() - started > LEDGER_LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for observation migration ledger lock: ${lockPath}`);
      }
      await delay(LEDGER_LOCK_POLL_MS);
    }
  }
}

async function recoverStaleLedgerLock(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }

  const pid = Number.parseInt(raw.trim().split(/\s+/)[0] ?? "", 10);
  if (Number.isInteger(pid) && pid > 0) {
    if (pid === process.pid || isProcessAlive(pid)) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  }

  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs > LEDGER_LOCK_STALE_AFTER_MS) {
    await rm(lockPath, { force: true });
    return true;
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EINVAL") {
      return false;
    }
    return true;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
