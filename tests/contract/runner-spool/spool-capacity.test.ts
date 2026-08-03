import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalPayloadHash,
  type TraceEvent,
} from "@qualigence/runner-protocol";
import { AesGcmSpoolCrypto, SqliteRunnerSpool } from "@qualigence/runner-spool";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), ".tmp-spool-cap-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function event(sequenceNumber: number): TraceEvent {
  const payload = { status: "ok" as const };
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

const MIB = 1024 * 1024;

describe("SqliteRunnerSpool capacity", () => {
  it("rejects an append that exceeds the hard limit without dropping data", async () => {
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await SqliteRunnerSpool.open({
      databaseFile: join(root, "spool.db"),
      crypto,
      softLimitBytes: 512 * MIB,
      hardLimitBytes: 1024 * MIB,
      measureEventBytes: () => 400 * MIB,
    });

    await spool.append(event(1));
    await spool.append(event(2));
    await expect(spool.append(event(3))).rejects.toMatchObject({
      code: "SpoolCapacityExceeded",
    });

    // The rejected event is not persisted; the earlier events remain.
    const pending = await spool.pending("r", 1, {
      maximumEvents: 100,
      maximumBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(pending).toEqual([event(1), event(2)]);
    await spool.close();
  });

  it("reports a soft-limit state while still accepting Trace", async () => {
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await SqliteRunnerSpool.open({
      databaseFile: join(root, "spool.db"),
      crypto,
      softLimitBytes: 512 * MIB,
      hardLimitBytes: 1024 * MIB,
      measureEventBytes: () => 300 * MIB,
    });

    await spool.append(event(1));
    expect(await spool.capacityState()).toMatchObject({ soft: false, hard: false });

    await spool.append(event(2));
    const state = await spool.capacityState();
    expect(state.soft).toBe(true);
    expect(state.hard).toBe(false);

    // Trace continues past the soft limit.
    await spool.append(event(3));
    expect((await spool.usage()).events).toBe(3);
    await spool.close();
  });

  it("enforces the batch event and byte limits when replaying", async () => {
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const spool = await SqliteRunnerSpool.open({
      databaseFile: join(root, "spool.db"),
      crypto,
    });
    for (let sequenceNumber = 1; sequenceNumber <= 5; sequenceNumber += 1) {
      await spool.append(event(sequenceNumber));
    }

    const byCount = await spool.pending("r", 1, {
      maximumEvents: 2,
      maximumBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(byCount.map((event) => event.sequenceNumber)).toEqual([1, 2]);

    const oneEventBytes = (await spool.usage()).bytes / 5;
    const byBytes = await spool.pending("r", 1, {
      maximumEvents: 100,
      maximumBytes: Math.ceil(oneEventBytes * 2.5),
    });
    expect(byBytes.map((event) => event.sequenceNumber)).toEqual([1, 2]);
    await spool.close();
  });
});
