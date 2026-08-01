import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalPayloadHash,
  type TraceEvent,
} from "@qualigence/runner-protocol";
import {
  AesGcmSpoolCrypto,
  loadOrCreateSpoolKey,
  SqliteRunnerSpool,
  type SpoolLeaseRecord,
} from "@qualigence/runner-spool";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), ".tmp-spool-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function event(sequenceNumber: number, marker = "trace-marker"): TraceEvent {
  const payload = { status: "failed" as const, errorCode: marker };
  return {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `msg-${sequenceNumber}`,
    idempotencyKey: `idem-${sequenceNumber}`,
    runId: "r",
    sequenceNumber,
    stage: "action_executed",
    occurredAt: "2026-08-01T00:00:00.000Z",
    payloadHash: canonicalPayloadHash(payload),
    payload,
  };
}

const limit = { maximumEvents: 10, maximumBytes: 4096 } as const;

function lease(secret: string): SpoolLeaseRecord {
  return {
    jobId: "job-1",
    runId: "r",
    leaseEpoch: 3,
    expiresAt: "2026-08-01T10:00:00.000Z",
    leaseToken: secret,
  };
}

async function openSpool(
  databaseFile: string,
  crypto?: AesGcmSpoolCrypto,
): Promise<SqliteRunnerSpool> {
  if (crypto === undefined) {
    return SqliteRunnerSpool.open({ databaseFile });
  }
  return SqliteRunnerSpool.open({ databaseFile, crypto });
}

describe("AesGcmSpoolCrypto", () => {
  it("round-trips an encrypted lease secret", async () => {
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const encrypted = await crypto.encryptLease({
      schemaVersion: "spool-lease/v1",
      jobId: "job-1",
      runId: "r",
      leaseEpoch: 3,
      expiresAt: "2026-08-01T10:00:00.000Z",
      secret: "lease-secret-value",
    });
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.tag).toHaveLength(16);
    expect(await crypto.decryptLease(encrypted)).toBe("lease-secret-value");
  });

  it("uses a distinct 96-bit nonce per lease", async () => {
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const first = await crypto.encryptLease({
      schemaVersion: "spool-lease/v1",
      jobId: "job-1",
      runId: "r",
      leaseEpoch: 3,
      expiresAt: "2026-08-01T10:00:00.000Z",
      secret: "lease-secret-value",
    });
    const second = await crypto.encryptLease({
      schemaVersion: "spool-lease/v1",
      jobId: "job-2",
      runId: "r",
      leaseEpoch: 4,
      expiresAt: "2026-08-01T10:00:00.000Z",
      secret: "lease-secret-value",
    });
    expect(first.nonce.equals(second.nonce)).toBe(false);
  });
});

describe("SqliteRunnerSpool", () => {
  it("appends and replays events in original order", async () => {
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await openSpool(join(root, "spool.db"), crypto);
    await spool.append(event(1));
    await spool.append(event(2));
    expect(await spool.pending("r", 1, limit)).toEqual([event(1), event(2)]);
    await spool.acknowledge("r", 2);
    expect(await spool.pending("r", 1, limit)).toEqual([event(2)]);
    await spool.close();
  });

  it("is idempotent for a duplicate sequence with the same hash", async () => {
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await openSpool(join(root, "spool.db"), crypto);
    await spool.append(event(1));
    await spool.append(event(1));
    expect(await spool.pending("r", 1, limit)).toEqual([event(1)]);
    await spool.close();
  });

  it("rejects a duplicate sequence with a different hash", async () => {
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await openSpool(join(root, "spool.db"), crypto);
    await spool.append(event(1, "first"));
    await expect(spool.append(event(1, "second"))).rejects.toMatchObject({
      code: "SpoolIntegrityViolation",
    });
    await spool.close();
  });

  it("recovers spooled events in order after a restart", async () => {
    const databaseFile = join(root, "spool.db");
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const first = await openSpool(databaseFile, crypto);
    await first.append(event(1));
    await first.append(event(2));
    await first.append(event(3));
    await first.acknowledge("r", 2);
    await first.close();

    const reopened = await openSpool(databaseFile, crypto);
    expect(await reopened.pending("r", 1, limit)).toEqual([event(2), event(3)]);
    await reopened.close();
  });

  it("saves and loads an encrypted lease", async () => {
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await openSpool(join(root, "spool.db"), crypto);
    await spool.saveLease(lease("lease-secret-value"));
    expect(await spool.loadLease("job-1")).toEqual(lease("lease-secret-value"));
    await spool.close();
  });

  it("never writes the lease secret to disk in plaintext", async () => {
    const databaseFile = join(root, "spool.db");
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await openSpool(databaseFile, crypto);
    await spool.append(event(1));
    await spool.saveLease(lease("lease-secret-value"));
    await spool.close();

    const bytes = await readFile(databaseFile);
    expect(bytes.includes(Buffer.from("lease-secret-value"))).toBe(false);
  });

  it("detects a flipped authentication tag as an integrity violation", async () => {
    const databaseFile = join(root, "spool.db");
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await openSpool(databaseFile, crypto);
    await spool.saveLease(lease("lease-secret-value"));
    await spool.close();

    const raw = new BetterSqlite3(databaseFile);
    const tag = raw.prepare("SELECT token_tag FROM spool_leases WHERE job_id = ?").get("job-1") as {
      token_tag: Buffer;
    };
    const corrupted = Buffer.from(tag.token_tag);
    corrupted.writeUInt8(corrupted.readUInt8(0) ^ 0xff, 0);
    raw.prepare("UPDATE spool_leases SET token_tag = ? WHERE job_id = ?").run(corrupted, "job-1");
    raw.close();

    const reopened = await openSpool(databaseFile, crypto);
    await expect(reopened.loadLease("job-1")).rejects.toMatchObject({
      code: "SpoolLeaseIntegrityViolation",
    });
    await reopened.close();
  });

  it("detects a flipped AAD field as an integrity violation", async () => {
    const databaseFile = join(root, "spool.db");
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await openSpool(databaseFile, crypto);
    await spool.saveLease(lease("lease-secret-value"));
    await spool.close();

    const raw = new BetterSqlite3(databaseFile);
    raw.prepare("UPDATE spool_leases SET lease_epoch = ? WHERE job_id = ?").run(99, "job-1");
    raw.close();

    const reopened = await openSpool(databaseFile, crypto);
    await expect(reopened.loadLease("job-1")).rejects.toMatchObject({
      code: "SpoolLeaseIntegrityViolation",
    });
    await reopened.close();
  });

  it("drops lease metadata but preserves events when the key is lost", async () => {
    const databaseFile = join(root, "spool.db");
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await openSpool(databaseFile, crypto);
    await spool.append(event(1));
    await spool.saveLease(lease("lease-secret-value"));
    await spool.close();

    const withoutKey = await openSpool(databaseFile);
    expect(await withoutKey.usage()).toEqual({ bytes: expect.any(Number), events: 1 });
    expect(await withoutKey.pending("r", 1, limit)).toEqual([event(1)]);
    await expect(withoutKey.loadLease("job-1")).rejects.toMatchObject({
      code: "SpoolKeyUnavailable",
    });
    await withoutKey.close();
  });

  it("persists a user-only 0600 spool key file", async () => {
    const keyFile = join(root, "spool.key");
    await loadOrCreateSpoolKey(keyFile);
    const { stat } = await import("node:fs/promises");
    const info = await stat(keyFile);
    if (process.platform !== "win32") {
      expect(info.mode & 0o777).toBe(0o600);
    }
  });
});
