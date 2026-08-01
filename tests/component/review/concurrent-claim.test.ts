import { describe, expect, it } from "vitest";
import {
  ClaimReviewTaskHandler,
  ResolveReviewTaskHandler,
  claimReviewTask,
  openReviewTask,
  resolveReviewTask,
  ReviewTaskError,
  ReviewTaskVersionConflict,
  type ClaimReviewTaskCommand,
  type ResolveReviewTaskCommand,
  type ReviewTask,
  type ReviewTaskRepository,
} from "@qualigence/review";

/**
 * An in-memory Review Task repository whose `claim`/`resolve` model a real
 * compare-and-set: they yield to the event loop while "reading", then perform
 * a synchronous critical section (no `await`) that re-reads the current state
 * and writes only if the expected version still holds. This lets two truly
 * interleaved claim attempts race — exactly one may win.
 */
class InMemoryReviewTaskRepository implements ReviewTaskRepository {
  private readonly tasks = new Map<string, ReviewTask>();
  private readonly claimIdempotency = new Map<string, ReviewTask>();
  private readonly resolveIdempotency = new Map<string, ReviewTask>();

  async create(task: ReviewTask): Promise<void> {
    this.tasks.set(task.taskId, task);
  }

  async find(taskId: string): Promise<ReviewTask | undefined> {
    return this.tasks.get(taskId);
  }

  async claim(command: ClaimReviewTaskCommand): Promise<ReviewTask | undefined> {
    // Simulate contention: yield before the atomic section so a concurrent
    // claim can interleave here.
    await Promise.resolve();
    // ---- begin synchronous critical section (no await) ----
    const replay = this.claimIdempotency.get(command.idempotencyKey);
    if (replay !== undefined) {
      return replay;
    }
    const current = this.tasks.get(command.taskId);
    if (
      current === undefined ||
      current.status !== "open" ||
      current.version !== command.expectedVersion
    ) {
      return undefined;
    }
    const next = claimReviewTask(current, command);
    this.tasks.set(next.taskId, next);
    this.claimIdempotency.set(command.idempotencyKey, next);
    return next;
    // ---- end synchronous critical section ----
  }

  async resolve(
    command: ResolveReviewTaskCommand,
  ): Promise<ReviewTask | undefined> {
    await Promise.resolve();
    const replay = this.resolveIdempotency.get(command.idempotencyKey);
    if (replay !== undefined) {
      return replay;
    }
    const current = this.tasks.get(command.taskId);
    if (
      current === undefined ||
      current.status !== "claimed" ||
      current.version !== command.expectedVersion ||
      current.assigneeId !== command.reviewerId
    ) {
      return undefined;
    }
    const { task } = resolveReviewTask(current, command);
    this.tasks.set(task.taskId, task);
    this.resolveIdempotency.set(command.idempotencyKey, task);
    return task;
  }
}

function seedTask(repo: InMemoryReviewTaskRepository): Promise<void> {
  return repo.create(
    openReviewTask({
      taskId: "task-1",
      caseId: "case-1",
      reason: "needs_human",
      priority: "high",
      evidenceCompleteness: "limited",
    }),
  );
}

describe("concurrent review claim", () => {
  it("allows exactly one of two concurrent claimants to win", async () => {
    const repo = new InMemoryReviewTaskRepository();
    await seedTask(repo);
    const handler = new ClaimReviewTaskHandler(repo);

    const results = await Promise.allSettled([
      handler.handle({
        taskId: "task-1",
        expectedVersion: 1,
        reviewerId: "alice",
        idempotencyKey: "alice-key",
      }),
      handler.handle({
        taskId: "task-1",
        expectedVersion: 1,
        reviewerId: "bob",
        idempotencyKey: "bob-key",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = (fulfilled[0] as PromiseFulfilledResult<ReviewTask>).value;
    expect(winner.status).toBe("claimed");
    expect(winner.version).toBe(2);
    expect(["alice", "bob"]).toContain(winner.assigneeId);

    const conflict = (rejected[0] as PromiseRejectedResult).reason;
    expect(conflict).toBeInstanceOf(ReviewTaskVersionConflict);
    expect(conflict).toMatchObject({
      code: "ReviewTaskVersionConflict",
      currentVersion: 2,
      assigneeId: winner.assigneeId,
    });

    const persisted = await repo.find("task-1");
    expect(persisted?.assigneeId).toBe(winner.assigneeId);
    expect(persisted?.version).toBe(2);
  });

  it("returns the original claim for a duplicate idempotency key", async () => {
    const repo = new InMemoryReviewTaskRepository();
    await seedTask(repo);
    const handler = new ClaimReviewTaskHandler(repo);

    const first = await handler.handle({
      taskId: "task-1",
      expectedVersion: 1,
      reviewerId: "alice",
      idempotencyKey: "alice-key",
    });
    const replay = await handler.handle({
      taskId: "task-1",
      expectedVersion: 1,
      reviewerId: "alice",
      idempotencyKey: "alice-key",
    });

    expect(replay).toEqual(first);
    const persisted = await repo.find("task-1");
    expect(persisted?.version).toBe(2);
  });

  it("rejects resolution by a non-assignee", async () => {
    const repo = new InMemoryReviewTaskRepository();
    await seedTask(repo);
    const claimHandler = new ClaimReviewTaskHandler(repo);
    const resolveHandler = new ResolveReviewTaskHandler(repo);

    await claimHandler.handle({
      taskId: "task-1",
      expectedVersion: 1,
      reviewerId: "alice",
      idempotencyKey: "alice-key",
    });

    await expect(
      resolveHandler.handle({
        taskId: "task-1",
        expectedVersion: 2,
        reviewerId: "bob",
        disposition: "confirmed_bug",
        evidenceRefs: [],
        idempotencyKey: "bob-resolve",
      }),
    ).rejects.toMatchObject({ code: "ReviewTaskNotAssignee" });
  });

  it("resolves for the assignee and is idempotent on replay", async () => {
    const repo = new InMemoryReviewTaskRepository();
    await seedTask(repo);
    const claimHandler = new ClaimReviewTaskHandler(repo);
    const resolveHandler = new ResolveReviewTaskHandler(repo);

    await claimHandler.handle({
      taskId: "task-1",
      expectedVersion: 1,
      reviewerId: "alice",
      idempotencyKey: "alice-key",
    });
    const resolved = await resolveHandler.handle({
      taskId: "task-1",
      expectedVersion: 2,
      reviewerId: "alice",
      disposition: "confirmed_bug",
      evidenceRefs: ["evidence-1"],
      idempotencyKey: "alice-resolve",
    });
    expect(resolved).toMatchObject({ status: "resolved", version: 3 });

    const replay = await resolveHandler.handle({
      taskId: "task-1",
      expectedVersion: 2,
      reviewerId: "alice",
      disposition: "confirmed_bug",
      evidenceRefs: ["evidence-1"],
      idempotencyKey: "alice-resolve",
    });
    expect(replay).toEqual(resolved);
  });

  it("rejects a stale resolve version with a conflict", async () => {
    const repo = new InMemoryReviewTaskRepository();
    await seedTask(repo);
    const claimHandler = new ClaimReviewTaskHandler(repo);
    const resolveHandler = new ResolveReviewTaskHandler(repo);

    await claimHandler.handle({
      taskId: "task-1",
      expectedVersion: 1,
      reviewerId: "alice",
      idempotencyKey: "alice-key",
    });

    await expect(
      resolveHandler.handle({
        taskId: "task-1",
        expectedVersion: 1,
        reviewerId: "alice",
        disposition: "confirmed_bug",
        evidenceRefs: [],
        idempotencyKey: "alice-resolve",
      }),
    ).rejects.toBeInstanceOf(ReviewTaskError);
  });
});
