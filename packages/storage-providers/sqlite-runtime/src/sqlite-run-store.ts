import type {
  ExecutionRunRecord,
  RunStatus,
  RunStore,
  RunTerminalUpdate,
} from "@qualigence/evidence";
import type { RunId } from "@qualigence/runner-protocol";
import type { SqliteRuntime } from "./database.js";
import { SqliteRuntimeError } from "./errors.js";
import { runInImmediateTransaction } from "./transaction.js";

export class SqliteRunStore implements RunStore {
  constructor(private readonly runtime: SqliteRuntime) {}

  async create(record: ExecutionRunRecord): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .insertInto("execution_runs")
        .values({
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
    });
  }

  async complete(
    runId: RunId,
    terminal: RunTerminalUpdate,
  ): Promise<"completed" | "duplicate"> {
    return runInImmediateTransaction(this.runtime, async () => {
      const db = this.runtime.db;
      const row = await db
        .selectFrom("execution_runs")
        .select(["status", "completed_at", "error_code"])
        .where("run_id", "=", runId)
        .executeTakeFirst();

      if (!row) {
        throw new SqliteRuntimeError(
          "RunTerminalConflict",
          `cannot complete unknown run ${runId}`,
        );
      }

      const targetErrorCode = terminal.errorCode ?? null;

      if (row.status === "running") {
        await db
          .updateTable("execution_runs")
          .set({
            status: terminal.status,
            completed_at: terminal.completedAt,
            error_code: targetErrorCode,
          })
          .where("run_id", "=", runId)
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

      throw new SqliteRuntimeError(
        "RunTerminalConflict",
        `run ${runId} already completed as ${row.status}; refusing to overwrite with ${terminal.status}`,
      );
    });
  }

  async get(runId: RunId): Promise<ExecutionRunRecord | undefined> {
    const row = await this.runtime.db
      .selectFrom("execution_runs")
      .selectAll()
      .where("run_id", "=", runId)
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }
    return {
      runId: row.run_id,
      jobId: row.job_id,
      targetKind: row.target_kind as "web" | "app",
      objective: row.objective,
      status: row.status as RunStatus,
      nextSequenceNumber: row.next_sequence_number,
      createdAt: row.created_at,
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
      ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    };
  }
}
