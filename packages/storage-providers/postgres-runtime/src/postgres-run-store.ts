import type {
  ExecutionRunRecord,
  RunStatus,
  RunStore,
  RunTerminalUpdate,
} from "@qualigence/evidence";
import type { RunId } from "@qualigence/runner-protocol";
import type { Kysely, Transaction } from "kysely";
import type { PostgresDatabase } from "./postgres-database.js";

export type PostgresRunStoreErrorCode = "RunTerminalConflict";

export class PostgresRunStoreError extends Error {
  constructor(
    readonly code: PostgresRunStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PostgresRunStoreError";
  }
}

/**
 * PostgreSQL Run store over a tenant-scoped transaction/connection. It mirrors
 * the provider-neutral SQLite {@link RunStore} contract while relying on forced
 * RLS plus the explicit tenant predicate for Self-hosted isolation.
 */
export class PostgresRunStore implements RunStore {
  constructor(
    private readonly db: Kysely<PostgresDatabase> | Transaction<PostgresDatabase>,
    private readonly tenantId: string,
  ) {}

  async create(record: ExecutionRunRecord): Promise<void> {
    await this.db
      .insertInto("execution_runs")
      .values({
        tenant_id: this.tenantId,
        run_id: record.runId,
        job_id: record.jobId,
        target_kind: record.targetKind,
        objective: record.objective,
        status: record.status,
        next_sequence_number: record.nextSequenceNumber,
        created_at: record.createdAt,
        completed_at: record.completedAt ?? null,
        error_code: record.errorCode ?? null,
      })
      .execute();
  }

  async complete(
    runId: RunId,
    terminal: RunTerminalUpdate,
  ): Promise<"completed" | "duplicate"> {
    const row = await this.db
      .selectFrom("execution_runs")
      .select(["status", "completed_at", "error_code"])
      .where("tenant_id", "=", this.tenantId)
      .where("run_id", "=", runId)
      .executeTakeFirst();

    if (row === undefined) {
      throw new PostgresRunStoreError(
        "RunTerminalConflict",
        `cannot complete unknown run ${runId}`,
      );
    }

    const targetErrorCode = terminal.errorCode ?? null;

    if (row.status === "running") {
      await this.db
        .updateTable("execution_runs")
        .set({
          status: terminal.status,
          completed_at: terminal.completedAt,
          error_code: targetErrorCode,
        })
        .where("tenant_id", "=", this.tenantId)
        .where("run_id", "=", runId)
        .where("status", "=", "running")
        .execute();
      return "completed";
    }

    const sameTerminal =
      row.status === terminal.status &&
      row.completed_at === terminal.completedAt &&
      row.error_code === targetErrorCode;

    if (sameTerminal) {
      return "duplicate";
    }

    throw new PostgresRunStoreError(
      "RunTerminalConflict",
      `run ${runId} already completed as ${row.status}; refusing to overwrite with ${terminal.status}`,
    );
  }

  async get(runId: RunId): Promise<ExecutionRunRecord | undefined> {
    const row = await this.db
      .selectFrom("execution_runs")
      .selectAll()
      .where("tenant_id", "=", this.tenantId)
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return row === undefined ? undefined : runRecord(row);
  }

  async list(): Promise<readonly ExecutionRunRecord[]> {
    const rows = await this.db
      .selectFrom("execution_runs")
      .selectAll()
      .where("tenant_id", "=", this.tenantId)
      .orderBy("created_at")
      .orderBy("run_id")
      .execute();
    return rows.map(runRecord);
  }
}

function runRecord(row: {
  readonly run_id: string;
  readonly job_id: string;
  readonly target_kind: string;
  readonly objective: string;
  readonly status: string;
  readonly next_sequence_number: number;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly error_code: string | null;
}): ExecutionRunRecord {
  return {
    runId: row.run_id,
    jobId: row.job_id,
    targetKind: row.target_kind as "web" | "app",
    objective: row.objective,
    status: row.status as RunStatus,
    nextSequenceNumber: row.next_sequence_number,
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  };
}
