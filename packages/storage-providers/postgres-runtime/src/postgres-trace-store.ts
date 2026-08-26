import type {
  FindingAppendResult,
  TraceAppendResult,
  TraceStore,
} from "@qualigence/evidence";
import type {
  FindingEnvelope,
  RunId,
  TraceEvent,
} from "@qualigence/runner-protocol";
import type { Kysely, Transaction } from "kysely";

export interface PostgresTraceClock {
  now(): string;
}

import type { PostgresDatabase } from "./postgres-database.js";

/**
 * PostgreSQL Trace store over an already tenant-scoped transaction/connection.
 * Production composition should obtain this through `TenantTransactionProvider`
 * for operation-scoped RLS transactions rather than retaining a long-lived
 * transaction-backed instance.
 */
export class PostgresTraceStore implements TraceStore {
  constructor(
    private readonly db: Kysely<PostgresDatabase> | Transaction<PostgresDatabase>,
    private readonly tenantId: string,
    private readonly clock: PostgresTraceClock = { now: () => new Date().toISOString() },
  ) {}

  async appendTraceEvent(event: TraceEvent): Promise<TraceAppendResult> {
    const run = await this.db
      .selectFrom("execution_runs")
      .select("next_sequence_number")
      .where("run_id", "=", event.runId)
      .executeTakeFirst();
    const cursor = run?.next_sequence_number ?? 1;

    const existing = await this.db
      .selectFrom("trace_events")
      .select("payload_hash")
      .where("run_id", "=", event.runId)
      .where("sequence_number", "=", event.sequenceNumber)
      .executeTakeFirst();

    if (existing !== undefined) {
      if (existing.payload_hash === event.payloadHash) {
        return { status: "duplicate", nextSequenceNumber: cursor };
      }
      return {
        status: "integrity_violation",
        code: "TraceIntegrityViolation",
        existingPayloadHash: existing.payload_hash,
      };
    }

    if (event.sequenceNumber !== cursor) {
      return {
        status: "sequence_gap",
        code: "SequenceGap",
        expectedSequenceNumber: cursor,
      };
    }

    const idempotencyConflict = await this.db
      .selectFrom("trace_events")
      .select("payload_hash")
      .where("idempotency_key", "=", event.idempotencyKey)
      .executeTakeFirst();
    if (idempotencyConflict !== undefined) {
      return {
        status: "integrity_violation",
        code: "TraceIntegrityViolation",
        existingPayloadHash: idempotencyConflict.payload_hash,
      };
    }

    const messageConflict = await this.db
      .selectFrom("trace_events")
      .select("payload_hash")
      .where("message_id", "=", event.messageId)
      .executeTakeFirst();
    if (messageConflict !== undefined) {
      return {
        status: "integrity_violation",
        code: "TraceIntegrityViolation",
        existingPayloadHash: messageConflict.payload_hash,
      };
    }

    await this.db
      .insertInto("trace_events")
      .values({
        tenant_id: this.tenantId,
        run_id: event.runId,
        sequence_number: event.sequenceNumber,
        message_id: event.messageId,
        idempotency_key: event.idempotencyKey,
        stage: event.stage,
        occurred_at: event.occurredAt,
        payload_hash: event.payloadHash,
        envelope_json: JSON.stringify(event),
      })
      .execute();

    await this.db
      .updateTable("execution_runs")
      .set({ next_sequence_number: cursor + 1 })
      .where("run_id", "=", event.runId)
      .execute();

    return { status: "accepted", nextSequenceNumber: cursor + 1 };
  }

  async appendFinding(
    finding: FindingEnvelope,
    payloadHash: string,
  ): Promise<FindingAppendResult> {
    const existing = await this.db
      .selectFrom("findings")
      .select("payload_hash")
      .where("finding_id", "=", finding.findingId)
      .executeTakeFirst();

    if (existing !== undefined) {
      if (existing.payload_hash === payloadHash) {
        return { status: "duplicate" };
      }
      return {
        status: "integrity_violation",
        code: "FindingIntegrityViolation",
        existingPayloadHash: existing.payload_hash,
      };
    }

    await this.db
      .insertInto("findings")
      .values({
        tenant_id: this.tenantId,
        finding_id: finding.findingId,
        run_id: finding.runId,
        payload_hash: payloadHash,
        envelope_json: JSON.stringify(finding),
        created_at: this.clock.now(),
      })
      .execute();

    return { status: "accepted" };
  }

  async eventAt(
    runId: RunId,
    sequenceNumber: number,
  ): Promise<TraceEvent | undefined> {
    const row = await this.db
      .selectFrom("trace_events")
      .select("envelope_json")
      .where("run_id", "=", runId)
      .where("sequence_number", "=", sequenceNumber)
      .executeTakeFirst();
    return row === undefined ? undefined : JSON.parse(row.envelope_json) as TraceEvent;
  }

  async nextTraceSequenceNumber(runId: RunId): Promise<number> {
    const run = await this.db
      .selectFrom("execution_runs")
      .select("next_sequence_number")
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return run?.next_sequence_number ?? 1;
  }

  async findingReferences(runId: RunId): Promise<readonly { readonly findingId: string; readonly createdAt: string }[]> {
    const rows = await this.db
      .selectFrom("findings")
      .select(["finding_id", "created_at"])
      .where("run_id", "=", runId)
      .orderBy("created_at")
      .orderBy("finding_id")
      .execute();
    return rows.map((row) => ({ findingId: row.finding_id, createdAt: row.created_at }));
  }
}
