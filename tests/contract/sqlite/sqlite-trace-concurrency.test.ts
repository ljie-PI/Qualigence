import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalTraceEventHash,
  type TraceEvent,
  type TraceEventHashInput,
} from "@qualigence/runner-protocol";
import {
  isSqliteBusyError,
  mapBusyError,
  SqliteRuntime,
  SqliteTraceStore,
} from "@qualigence/sqlite-runtime";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";

let dir: string;
let filename: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), ".tmp-sqlite-conc-"));
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

function event(
  sequenceNumber: number,
  variant: string,
  graphId: string,
): TraceEvent {
  const hashInput: TraceEventHashInput = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `m-${sequenceNumber}-${variant}`,
    idempotencyKey: `i-${sequenceNumber}-${variant}`,
    runId: "run-1",
    sequenceNumber,
    stage: "observation",
    occurredAt: "2026-08-01T00:00:00.000Z",
    payload: observationGraphV1(graphId),
  };
  return {
    ...hashInput,
    payloadHash: canonicalTraceEventHash(hashInput),
  } as TraceEvent;
}

describe("SqliteTraceStore concurrency", () => {
  it("maps SQLITE_BUSY to a StorageBusy error instead of retrying forever", () => {
    const busy = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });
    expect(isSqliteBusyError(busy)).toBe(true);
    expect(isSqliteBusyError(new Error("unrelated"))).toBe(false);
    expect(mapBusyError(busy)).toMatchObject({ code: "StorageBusy" });
  });

  it("serializes cross-connection appends through the durable cursor", async () => {
    const runtimeA = await openRuntime();
    await createRun(runtimeA, "run-1");
    const runtimeB = await openRuntime();
    const storeA = new SqliteTraceStore(runtimeA);
    const storeB = new SqliteTraceStore(runtimeB);

    expect(await storeA.appendTraceEvent(event(1, "a", "graph-a"))).toMatchObject(
      { status: "accepted", nextSequenceNumber: 2 },
    );
    // Connection B sees A's committed row and rejects a conflicting sequence 1.
    expect(await storeB.appendTraceEvent(event(1, "b", "graph-b"))).toMatchObject(
      { status: "integrity_violation", code: "TraceIntegrityViolation" },
    );
    // Connection B can still advance the shared cursor with the next sequence.
    expect(await storeB.appendTraceEvent(event(2, "b", "graph-2"))).toMatchObject(
      { status: "accepted", nextSequenceNumber: 3 },
    );

    await runtimeA.close();
    await runtimeB.close();
  });
});
