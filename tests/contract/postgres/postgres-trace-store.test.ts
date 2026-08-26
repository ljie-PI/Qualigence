import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalTraceEventHash,
  type ObservationGraphV1,
  type TraceEvent,
  type TraceEventHashInput,
} from "@qualigence/runner-protocol";
import {
  createPostgresRuntime,
  PostgresTraceStore,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import {
  executionRunRow,
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";

const TENANT_ID = "tenant-postgres-trace";

describe.skipIf(!dockerAvailable())("PostgresTraceStore", () => {
  let fixture: PostgresFixture;
  let runtime: TenantTransactionProvider;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
    runtime = createPostgresRuntime(fixture.serverConfig);
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await fixture?.stop();
  });

  it("accepts, deduplicates, gaps, and rejects integrity violations under tenant RLS", async () => {
    await runtime.withTenant(TENANT_ID, async ({ db }) => {
      await createRun(db, TENANT_ID, "run-1");
      const store = new PostgresTraceStore(db, TENANT_ID);

      await expect(store.appendTraceEvent(event(1))).resolves.toMatchObject({
        status: "accepted",
        nextSequenceNumber: 2,
      });
      await expect(store.appendTraceEvent(event(1))).resolves.toMatchObject({
        status: "duplicate",
        nextSequenceNumber: 2,
      });
      await expect(store.appendTraceEvent(event(3))).resolves.toMatchObject({
        status: "sequence_gap",
        code: "SequenceGap",
        expectedSequenceNumber: 2,
      });
      await expect(
        store.appendTraceEvent(
          event(1, {
            payload: observationGraphV1("changed"),
            messageId: "m-1b",
            idempotencyKey: "i-1b",
          }),
        ),
      ).resolves.toMatchObject({
        status: "integrity_violation",
        code: "TraceIntegrityViolation",
      });
    });
  });

  it("persists events and finding references without crossing tenants", async () => {
    await runtime.withTenant("tenant-trace-a", async ({ db }) => {
      await createRun(db, "tenant-trace-a", "shared-run");
      const store = new PostgresTraceStore(db, "tenant-trace-a", { now: () => "2026-08-01T00:03:00.000Z" });
      await store.appendTraceEvent(event(1, { runId: "shared-run" }));
      await store.appendTraceEvent(event(2, { runId: "shared-run", messageId: "m-2a", idempotencyKey: "i-2a" }));
      await expect(store.nextTraceSequenceNumber("shared-run")).resolves.toBe(3);
      await expect(store.eventAt("shared-run", 2)).resolves.toMatchObject({ sequenceNumber: 2, stage: "observation" });
      const finding = { findingId: "finding-a", runId: "shared-run", title: "Mismatch", summary: "Observed mismatch", severity: "high", evidenceRefs: ["artifact-a"] } as const;
      await expect(store.appendFinding(finding, "hash-a")).resolves.toEqual({ status: "accepted" });
      await expect(store.appendFinding(finding, "hash-a")).resolves.toEqual({ status: "duplicate" });
      await expect(store.appendFinding(finding, "hash-b")).resolves.toMatchObject({ status: "integrity_violation", code: "FindingIntegrityViolation", existingPayloadHash: "hash-a" });
      await expect(store.findingReferences("shared-run")).resolves.toEqual([{ findingId: "finding-a", createdAt: "2026-08-01T00:03:00.000Z" }]);
    });

    await runtime.withTenant("tenant-trace-b", async ({ db }) => {
      const store = new PostgresTraceStore(db, "tenant-trace-b");
      await expect(store.eventAt("shared-run", 1)).resolves.toBeUndefined();
      await expect(store.nextTraceSequenceNumber("shared-run")).resolves.toBe(1);
      await expect(store.findingReferences("shared-run")).resolves.toEqual([]);
    });
  });
});

type TenantDb = Parameters<Parameters<TenantTransactionProvider["withTenant"]>[1]>[0]["db"];

async function createRun(db: TenantDb, tenantId: string, runId: string): Promise<void> {
  await db
    .insertInto("execution_runs")
    .values({ ...executionRunRow({ tenantId, runId }), next_sequence_number: 1 } as never)
    .execute();
}

interface EventOptions {
  readonly runId?: string;
  readonly payload?: ObservationGraphV1;
  readonly messageId?: string;
  readonly idempotencyKey?: string;
}

function event(sequenceNumber: number, options: EventOptions = {}): TraceEvent {
  const runId = options.runId ?? "run-1";
  const hashInput: TraceEventHashInput = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: options.messageId ?? `m-${sequenceNumber}`,
    idempotencyKey: options.idempotencyKey ?? `i-${sequenceNumber}`,
    runId,
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
