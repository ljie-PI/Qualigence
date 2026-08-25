import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalTraceEventHash,
  type ObservationGraphV1,
  type TraceEvent,
  type TraceEventHashInput,
} from "@qualigence/runner-protocol";
import { SqliteRuntime, SqliteTraceStore } from "@qualigence/sqlite-runtime";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";

let dir: string;
let filename: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), ".tmp-sqlite-"));
  filename = join(dir, "qualigence.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function openRuntime(): Promise<SqliteRuntime> {
  return SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
}

async function createRun(runtime: SqliteRuntime, runId: string): Promise<void> {
  await runtime.db
    .insertInto("execution_runs")
    .values({
      run_id: runId,
      job_id: "job-1",
      target_kind: "web",
      objective: "verify",
      status: "running",
      next_sequence_number: 1,
      created_at: "2026-08-01T00:00:00.000Z",
      completed_at: null,
      error_code: null,
    })
    .execute();
}

interface EventOptions {
  readonly runId?: string;
  readonly payload?: ObservationGraphV1;
  readonly messageId?: string;
  readonly idempotencyKey?: string;
}

function event(sequenceNumber: number, options: EventOptions = {}): TraceEvent {
  const hashInput: TraceEventHashInput = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: options.messageId ?? `m-${sequenceNumber}`,
    idempotencyKey: options.idempotencyKey ?? `i-${sequenceNumber}`,
    runId: options.runId ?? "run-1",
    sequenceNumber,
    stage: "observation",
    occurredAt: "2026-08-01T00:00:00.000Z",
    payload: options.payload ?? observationGraphV1(`g-${sequenceNumber}`),
  };
  return {
    ...hashInput,
    payloadHash: canonicalTraceEventHash(hashInput),
  } as TraceEvent;
}

describe("SqliteTraceStore", () => {
  it("accepts, deduplicates, gaps, and rejects integrity violations", async () => {
    const runtime = await openRuntime();
    await createRun(runtime, "run-1");
    const store = new SqliteTraceStore(runtime);

    expect(await store.appendTraceEvent(event(1))).toMatchObject({
      status: "accepted",
      nextSequenceNumber: 2,
    });
    expect(await store.appendTraceEvent(event(1))).toMatchObject({
      status: "duplicate",
      nextSequenceNumber: 2,
    });
    expect(await store.appendTraceEvent(event(3))).toMatchObject({
      status: "sequence_gap",
      code: "SequenceGap",
      expectedSequenceNumber: 2,
    });
    expect(
      await store.appendTraceEvent(
        event(1, {
          payload: observationGraphV1("changed"),
          messageId: "m-1b",
          idempotencyKey: "i-1b",
        }),
      ),
    ).toMatchObject({
      status: "integrity_violation",
      code: "TraceIntegrityViolation",
    });

    await runtime.close();
  });

  it("rejects a reused idempotency key that points at a different event", async () => {
    const runtime = await openRuntime();
    await createRun(runtime, "run-1");
    const store = new SqliteTraceStore(runtime);

    expect(await store.appendTraceEvent(event(1))).toMatchObject({
      status: "accepted",
    });
    const result = await store.appendTraceEvent(
      event(2, { idempotencyKey: "i-1", messageId: "m-2" }),
    );
    expect(result).toMatchObject({
      status: "integrity_violation",
      code: "TraceIntegrityViolation",
    });

    await runtime.close();
  });

  it("persists events across a restart and exposes them by sequence", async () => {
    const first = await openRuntime();
    await createRun(first, "run-1");
    const writer = new SqliteTraceStore(first);
    await writer.appendTraceEvent(event(1));
    await writer.appendTraceEvent(event(2));
    expect(await writer.nextTraceSequenceNumber("run-1")).toBe(3);
    await first.close();

    const second = await openRuntime();
    const reader = new SqliteTraceStore(second);
    expect(await reader.nextTraceSequenceNumber("run-1")).toBe(3);
    const stored = await reader.eventAt("run-1", 2);
    expect(stored).toMatchObject({ sequenceNumber: 2, stage: "observation" });
    expect(stored?.payloadHash).toBe(event(2).payloadHash);
    expect(await reader.eventAt("run-1", 99)).toBeUndefined();
    await second.close();
  });

  it("appends findings idempotently and rejects conflicting hashes", async () => {
    const runtime = await openRuntime();
    await createRun(runtime, "run-1");
    const store = new SqliteTraceStore(runtime);

    const finding = {
      findingId: "f-1",
      runId: "run-1",
      title: "Price mismatch",
      summary: "Displayed total differs from expected",
      severity: "high",
      evidenceRefs: ["run-1/before.png"],
    } as const;

    expect(await store.appendFinding(finding, "hash-a")).toMatchObject({
      status: "accepted",
    });
    expect(await store.appendFinding(finding, "hash-a")).toMatchObject({
      status: "duplicate",
    });
    expect(await store.appendFinding(finding, "hash-b")).toMatchObject({
      status: "integrity_violation",
      code: "FindingIntegrityViolation",
      existingPayloadHash: "hash-a",
    });

    await runtime.close();
  });

  it("throws StorageClosed once the runtime is closed", async () => {
    const runtime = await openRuntime();
    await createRun(runtime, "run-1");
    const store = new SqliteTraceStore(runtime);
    await store.appendTraceEvent(event(1));
    await runtime.close();

    await expect(store.appendTraceEvent(event(2))).rejects.toMatchObject({
      code: "StorageClosed",
    });
  });
});
