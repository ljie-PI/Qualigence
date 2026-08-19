import { sql } from "kysely";
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
import type { Clock } from "@qualigence/shared-kernel";
import { SystemClock } from "@qualigence/shared-kernel";
import type { SqliteRuntime } from "./database.js";
import { isSqliteBusyError, mapBusyError } from "./errors.js";

export class SqliteTraceStore implements TraceStore {
  constructor(
    private readonly runtime: SqliteRuntime,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async appendTraceEvent(event: TraceEvent): Promise<TraceAppendResult> {
    return this.withImmediateTransaction(async () => {
      const db = this.runtime.db;

      const run = await db
        .selectFrom("execution_runs")
        .select("next_sequence_number")
        .where("run_id", "=", event.runId)
        .executeTakeFirst();
      const cursor = run?.next_sequence_number ?? 1;

      const existing = await db
        .selectFrom("trace_events")
        .select("payload_hash")
        .where("run_id", "=", event.runId)
        .where("sequence_number", "=", event.sequenceNumber)
        .executeTakeFirst();

      if (existing) {
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

      const idempotencyConflict = await db
        .selectFrom("trace_events")
        .select("payload_hash")
        .where("idempotency_key", "=", event.idempotencyKey)
        .executeTakeFirst();
      if (idempotencyConflict) {
        return {
          status: "integrity_violation",
          code: "TraceIntegrityViolation",
          existingPayloadHash: idempotencyConflict.payload_hash,
        };
      }

      const messageConflict = await db
        .selectFrom("trace_events")
        .select("payload_hash")
        .where("message_id", "=", event.messageId)
        .executeTakeFirst();
      if (messageConflict) {
        return {
          status: "integrity_violation",
          code: "TraceIntegrityViolation",
          existingPayloadHash: messageConflict.payload_hash,
        };
      }

      await db
        .insertInto("trace_events")
        .values({
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

      await db
        .updateTable("execution_runs")
        .set({ next_sequence_number: cursor + 1 })
        .where("run_id", "=", event.runId)
        .execute();

      return { status: "accepted", nextSequenceNumber: cursor + 1 };
    });
  }

  async appendFinding(
    finding: FindingEnvelope,
    payloadHash: string,
  ): Promise<FindingAppendResult> {
    return this.withImmediateTransaction(async () => {
      const db = this.runtime.db;

      const existing = await db
        .selectFrom("findings")
        .select("payload_hash")
        .where("finding_id", "=", finding.findingId)
        .executeTakeFirst();

      if (existing) {
        if (existing.payload_hash === payloadHash) {
          return { status: "duplicate" };
        }
        return {
          status: "integrity_violation",
          code: "FindingIntegrityViolation",
          existingPayloadHash: existing.payload_hash,
        };
      }

      await db
        .insertInto("findings")
        .values({
          finding_id: finding.findingId,
          run_id: finding.runId,
          payload_hash: payloadHash,
          envelope_json: JSON.stringify(finding),
          created_at: this.clock.now(),
        })
        .execute();

      return { status: "accepted" };
    });
  }

  async eventAt(
    runId: RunId,
    sequenceNumber: number,
  ): Promise<TraceEvent | undefined> {
    const row = await this.runtime.db
      .selectFrom("trace_events")
      .select("envelope_json")
      .where("run_id", "=", runId)
      .where("sequence_number", "=", sequenceNumber)
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }
    return JSON.parse(row.envelope_json) as TraceEvent;
  }

  async nextTraceSequenceNumber(runId: RunId): Promise<number> {
    const run = await this.runtime.db
      .selectFrom("execution_runs")
      .select("next_sequence_number")
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return run?.next_sequence_number ?? 1;
  }

  async findingReferences(runId: RunId) {
    const rows = await this.runtime.db.selectFrom("findings").select(["finding_id", "created_at"])
      .where("run_id", "=", runId).orderBy("created_at").orderBy("finding_id").execute();
    return rows.map((row) => ({ findingId: row.finding_id, createdAt: row.created_at }));
  }

  private async withImmediateTransaction<TResult>(
    body: () => Promise<TResult>,
  ): Promise<TResult> {
    const db = this.runtime.db;
    try {
      await sql`BEGIN IMMEDIATE`.execute(db);
    } catch (error) {
      if (isSqliteBusyError(error)) {
        throw mapBusyError(error);
      }
      throw error;
    }

    try {
      const result = await body();
      await sql`COMMIT`.execute(db);
      return result;
    } catch (error) {
      await sql`ROLLBACK`.execute(db).catch(() => undefined);
      if (isSqliteBusyError(error)) {
        throw mapBusyError(error);
      }
      throw error;
    }
  }
}
