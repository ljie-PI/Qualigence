import type { Kysely } from "kysely";
import { sql } from "kysely";
import type {
  ClaimReviewTaskCommand,
  ResolveReviewTaskCommand,
  ReviewTask,
  ReviewTaskRepository,
} from "@qualigence/review";
import type { PostgresDatabase } from "@qualigence/postgres-runtime";

/**
 * Tenant-transaction-bound PostgreSQL adapter for the Review Task aggregate.
 * The transaction's RLS context is the sole tenant boundary; no unscoped
 * database handle is accepted here.
 */
export class PostgresReviewTaskRepository implements ReviewTaskRepository {
  constructor(private readonly db: Kysely<PostgresDatabase>) {}

  async create(task: ReviewTask): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("review_tasks")
      .values({
        tenant_id: this.currentTenant(),
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
      .execute();
  }

  async find(taskId: string): Promise<ReviewTask | undefined> {
    const row = await this.db
      .selectFrom("review_tasks")
      .select([
        "task_id",
        "case_id",
        "status",
        "reason",
        "priority",
        "evidence_completeness",
        "assignee_id",
        "version",
      ])
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    return row === undefined ? undefined : this.toTask(row);
  }

  async claim(command: ClaimReviewTaskCommand): Promise<ReviewTask | undefined> {
    const now = new Date().toISOString();
    const reservation = await this.db
      .insertInto("review_claims")
      .values({
        tenant_id: this.currentTenant(),
        idempotency_key: command.idempotencyKey,
        task_id: command.taskId,
        reviewer_id: command.reviewerId,
        claimed_version: command.expectedVersion + 1,
        created_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "idempotency_key"]).doNothing(),
      )
      .returning("idempotency_key")
      .executeTakeFirst();
    if (reservation === undefined) {
      const replay = await this.db
        .selectFrom("review_claims")
        .select("task_id")
        .where("idempotency_key", "=", command.idempotencyKey)
        .executeTakeFirst();
      return replay?.task_id === command.taskId
        ? this.find(command.taskId)
        : undefined;
    }

    const result = await this.db
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
    if (result.numUpdatedRows !== 1n) {
      await this.db
        .deleteFrom("review_claims")
        .where("idempotency_key", "=", command.idempotencyKey)
        .where("task_id", "=", command.taskId)
        .execute();
      return undefined;
    }

    return this.find(command.taskId);
  }

  async resolve(command: ResolveReviewTaskCommand): Promise<ReviewTask | undefined> {
    const current = await this.find(command.taskId);
    if (current === undefined) {
      return undefined;
    }

    const now = new Date().toISOString();
    const reservation = await this.db
      .insertInto("review_resolutions")
      .values({
        tenant_id: this.currentTenant(),
        idempotency_key: command.idempotencyKey,
        task_id: command.taskId,
        case_id: current.caseId,
        reviewer_id: command.reviewerId,
        disposition: command.disposition,
        evidence_refs_json: JSON.stringify(command.evidenceRefs),
        resolved_version: command.expectedVersion + 1,
        created_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "idempotency_key"]).doNothing(),
      )
      .returning("idempotency_key")
      .executeTakeFirst();
    if (reservation === undefined) {
      const replay = await this.db
        .selectFrom("review_resolutions")
        .select("task_id")
        .where("idempotency_key", "=", command.idempotencyKey)
        .executeTakeFirst();
      return replay?.task_id === command.taskId
        ? this.find(command.taskId)
        : undefined;
    }

    const result = await this.db
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
    if (result.numUpdatedRows !== 1n) {
      await this.db
        .deleteFrom("review_resolutions")
        .where("idempotency_key", "=", command.idempotencyKey)
        .where("task_id", "=", command.taskId)
        .execute();
      return undefined;
    }

    const task = await this.find(command.taskId);
    if (task === undefined) {
      throw new Error("Claimed review task disappeared before its resolution was audited.");
    }
    return task;
  }

  private currentTenant() {
    return sql<string>`current_setting('app.tenant_id', true)`;
  }

  private toTask(row: {
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
      evidenceCompleteness: row.evidence_completeness as ReviewTask["evidenceCompleteness"],
      ...(row.assignee_id === null ? {} : { assigneeId: row.assignee_id }),
      version: row.version,
    };
  }
}
