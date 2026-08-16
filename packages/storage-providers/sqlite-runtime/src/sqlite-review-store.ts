import {
  openReviewTask,
  type ClaimReviewTaskCommand,
  type ResolveReviewTaskCommand,
  type ReviewTask,
  type ReviewTaskDraft,
  type ReviewTaskRepository,
} from "@qualigence/review";
import type { Kysely, Transaction } from "kysely";
import type { SqliteRuntime } from "./database.js";
import { isSqliteBusyError, mapBusyError } from "./errors.js";
import type { Database } from "./schema.js";

/**
 * SQLite-backed {@link ReviewTaskRepository}. Claims and resolutions are applied
 * inside one transaction with its idempotency audit. The audit key is reserved
 * before the compare-and-set so simultaneous retries either apply once or replay
 * the committed result, while reuse of a key for a different task cannot advance
 * both aggregates. A failed compare-and-set removes its reservation before the
 * transaction commits.
 */
export class SqliteReviewStore implements ReviewTaskRepository {
  constructor(private readonly runtime: SqliteRuntime) {}

  async create(tenantId: string, task: ReviewTask): Promise<void> {
    this.requireLocalTenant(tenantId);
    const now = new Date().toISOString();
    await this.runtime.db
      .insertInto("review_tasks")
      .values({
        task_id: task.taskId,
        case_id: task.caseId,
        status: task.status,
        reason: task.reason,
        priority: task.priority,
        evidence_completeness: task.evidenceCompleteness,
        assignee_id: task.assigneeId ?? null,
        version: task.version,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column("task_id").doNothing())
      .execute();
  }

  /** Convenience: open a fresh task from a draft and persist it. */
  async open(draft: ReviewTaskDraft): Promise<ReviewTask> {
    const task = openReviewTask(draft);
    await this.create("local", task);
    return task;
  }

  async find(tenantId: string, taskId: string): Promise<ReviewTask | undefined> {
    this.requireLocalTenant(tenantId);
    return this.findWith(this.runtime.db, taskId);
  }

  async claim(
    tenantId: string,
    command: ClaimReviewTaskCommand,
  ): Promise<ReviewTask | undefined> {
    this.requireLocalTenant(tenantId);
    return this.withWriteTransaction(async (db) => {
      const now = new Date().toISOString();
      const reservation = await db
        .insertInto("review_claims")
        .values({
          idempotency_key: command.idempotencyKey,
          task_id: command.taskId,
          reviewer_id: command.reviewerId,
          claimed_version: command.expectedVersion + 1,
          created_at: now,
        })
        .onConflict((oc) => oc.column("idempotency_key").doNothing())
        .returning("idempotency_key")
        .executeTakeFirst();

      if (reservation === undefined) {
        const replay = await db
          .selectFrom("review_claims")
          .select(["task_id", "reviewer_id", "claimed_version"])
          .where("idempotency_key", "=", command.idempotencyKey)
          .executeTakeFirst();
        return replay?.task_id === command.taskId &&
          replay.reviewer_id === command.reviewerId &&
          replay.claimed_version === command.expectedVersion + 1
          ? this.findWith(db, command.taskId)
          : undefined;
      }

      const result = await db
        .updateTable("review_tasks")
        .set({
          status: "claimed",
          assignee_id: command.reviewerId,
          version: command.expectedVersion + 1,
          updated_at: now,
        })
        .where("task_id", "=", command.taskId)
        .where("status", "=", "open")
        .where("version", "=", command.expectedVersion)
        .executeTakeFirst();

      if (result.numUpdatedRows === 0n) {
        await db
          .deleteFrom("review_claims")
          .where("idempotency_key", "=", command.idempotencyKey)
          .where("task_id", "=", command.taskId)
          .execute();
        return undefined;
      }

      return this.findWith(db, command.taskId);
    });
  }

  async resolve(
    tenantId: string,
    command: ResolveReviewTaskCommand,
  ): Promise<ReviewTask | undefined> {
    this.requireLocalTenant(tenantId);
    const current = await this.find(tenantId, command.taskId);
    if (current === undefined) {
      return undefined;
    }

    return this.withWriteTransaction(async (db) => {
      const now = new Date().toISOString();
      const reservation = await db
        .insertInto("review_resolutions")
        .values({
          idempotency_key: command.idempotencyKey,
          task_id: command.taskId,
          case_id: current.caseId,
          reviewer_id: command.reviewerId,
          disposition: command.disposition,
          evidence_refs_json: JSON.stringify(command.evidenceRefs),
          resolved_version: command.expectedVersion + 1,
          created_at: now,
        })
        .onConflict((oc) => oc.column("idempotency_key").doNothing())
        .returning("idempotency_key")
        .executeTakeFirst();

      if (reservation === undefined) {
        const replay = await db
          .selectFrom("review_resolutions")
          .select([
            "task_id",
            "reviewer_id",
            "disposition",
            "evidence_refs_json",
            "resolved_version",
          ])
          .where("idempotency_key", "=", command.idempotencyKey)
          .executeTakeFirst();
        return replay?.task_id === command.taskId &&
          replay.reviewer_id === command.reviewerId &&
          replay.disposition === command.disposition &&
          replay.evidence_refs_json === JSON.stringify(command.evidenceRefs) &&
          replay.resolved_version === command.expectedVersion + 1
          ? this.findWith(db, command.taskId)
          : undefined;
      }

      const result = await db
        .updateTable("review_tasks")
        .set({
          status: "resolved",
          version: command.expectedVersion + 1,
          updated_at: now,
        })
        .where("task_id", "=", command.taskId)
        .where("status", "=", "claimed")
        .where("version", "=", command.expectedVersion)
        .where("assignee_id", "=", command.reviewerId)
        .executeTakeFirst();

      if (result.numUpdatedRows === 0n) {
        await db
          .deleteFrom("review_resolutions")
          .where("idempotency_key", "=", command.idempotencyKey)
          .where("task_id", "=", command.taskId)
          .execute();
        return undefined;
      }

      return this.findWith(db, command.taskId);
    });
  }

  private async withWriteTransaction<TResult>(
    operation: (db: Transaction<Database>) => Promise<TResult>,
  ): Promise<TResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.runtime.db.transaction().execute(operation);
      } catch (error) {
        if (!isSqliteBusyError(error) || attempt === 1) {
          throw isSqliteBusyError(error) ? mapBusyError(error) : error;
        }
        // better-sqlite3 blocks the event loop while its busy timeout runs. Let
        // the transaction that already owns the write lock commit before the
        // single bounded replay attempt reads the durable idempotency record.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    throw new Error("Unreachable SQLite review transaction retry state.");
  }

  private async findWith(
    db: Kysely<Database> | Transaction<Database>,
    taskId: string,
  ): Promise<ReviewTask | undefined> {
    const row = await db
      .selectFrom("review_tasks")
      .selectAll()
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    return row === undefined ? undefined : this.rowToTask(row);
  }

  private requireLocalTenant(tenantId: string): void {
    if (tenantId !== "local") {
      throw new Error("SQLite review storage only supports the local tenant.");
    }
  }

  private rowToTask(row: {
    task_id: string;
    case_id: string;
    status: string;
    reason: string;
    priority: string;
    evidence_completeness: string;
    assignee_id: string | null;
    version: number;
  }): ReviewTask {
    return {
      taskId: row.task_id,
      caseId: row.case_id,
      status: row.status as ReviewTask["status"],
      reason: row.reason,
      priority: row.priority as ReviewTask["priority"],
      evidenceCompleteness:
        row.evidence_completeness as ReviewTask["evidenceCompleteness"],
      ...(row.assignee_id === null ? {} : { assigneeId: row.assignee_id }),
      version: row.version,
    };
  }
}
