import {
  openReviewTask,
  type ClaimReviewTaskCommand,
  type ResolveReviewTaskCommand,
  type ReviewTask,
  type ReviewTaskDraft,
  type ReviewTaskRepository,
} from "@qualigence/review";
import type { SqliteRuntime } from "./database.js";

/**
 * SQLite-backed {@link ReviewTaskRepository}. Claims and resolutions are applied
 * by a single atomic conditional write (`UPDATE ... WHERE version = ? AND
 * status = ?`) executed in autocommit — the statement acquires and releases the
 * write lock synchronously, so two concurrent claimants on the same task can
 * never both win. The losing writer's UPDATE matches zero rows and the store
 * returns `undefined`, letting the handler surface the current aggregate truth
 * as an explicit conflict rather than a silent overwrite. The idempotency ledger
 * (`review_claims` / `review_resolutions`) makes a duplicate command replay the
 * original result instead of applying a second time.
 */
export class SqliteReviewStore implements ReviewTaskRepository {
  constructor(private readonly runtime: SqliteRuntime) {}

  async create(task: ReviewTask): Promise<void> {
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
    await this.create(task);
    return task;
  }

  async find(taskId: string): Promise<ReviewTask | undefined> {
    const row = await this.runtime.db
      .selectFrom("review_tasks")
      .selectAll()
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    return row === undefined ? undefined : this.rowToTask(row);
  }

  async claim(command: ClaimReviewTaskCommand): Promise<ReviewTask | undefined> {
    const db = this.runtime.db;
    const replay = await db
      .selectFrom("review_claims")
      .select("task_id")
      .where("idempotency_key", "=", command.idempotencyKey)
      .executeTakeFirst();
    if (replay !== undefined) {
      return replay.task_id === command.taskId ? this.find(replay.task_id) : undefined;
    }

    // Single atomic compare-and-set; only one concurrent claimant can match.
    const result = await db
      .updateTable("review_tasks")
      .set({
        status: "claimed",
        assignee_id: command.reviewerId,
        version: command.expectedVersion + 1,
        updated_at: new Date().toISOString(),
      })
      .where("task_id", "=", command.taskId)
      .where("status", "=", "open")
      .where("version", "=", command.expectedVersion)
      .executeTakeFirst();

    if (result.numUpdatedRows === 0n) {
      return undefined;
    }

    await db
      .insertInto("review_claims")
      .values({
        idempotency_key: command.idempotencyKey,
        task_id: command.taskId,
        reviewer_id: command.reviewerId,
        claimed_version: command.expectedVersion + 1,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.column("idempotency_key").doNothing())
      .execute();

    return this.find(command.taskId);
  }

  async resolve(
    command: ResolveReviewTaskCommand,
  ): Promise<ReviewTask | undefined> {
    const db = this.runtime.db;
    const replay = await db
      .selectFrom("review_resolutions")
      .select("task_id")
      .where("idempotency_key", "=", command.idempotencyKey)
      .executeTakeFirst();
    if (replay !== undefined) {
      return replay.task_id === command.taskId ? this.find(replay.task_id) : undefined;
    }

    const result = await db
      .updateTable("review_tasks")
      .set({
        status: "resolved",
        version: command.expectedVersion + 1,
        updated_at: new Date().toISOString(),
      })
      .where("task_id", "=", command.taskId)
      .where("status", "=", "claimed")
      .where("version", "=", command.expectedVersion)
      .where("assignee_id", "=", command.reviewerId)
      .executeTakeFirst();

    if (result.numUpdatedRows === 0n) {
      return undefined;
    }

    const current = await this.find(command.taskId);
    await db
      .insertInto("review_resolutions")
      .values({
        idempotency_key: command.idempotencyKey,
        task_id: command.taskId,
        case_id: current?.caseId ?? "",
        reviewer_id: command.reviewerId,
        disposition: command.disposition,
        evidence_refs_json: JSON.stringify(command.evidenceRefs),
        resolved_version: command.expectedVersion + 1,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.column("idempotency_key").doNothing())
      .execute();

    return current;
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
