import { describe, expect, it } from "vitest";
import {
  canClaim,
  canResolve,
  claimReviewTask,
  openReviewTask,
  resolveReviewTask,
  ReviewTaskError,
  ReviewTaskVersionConflict,
  type ReviewTask,
} from "@qualigence/review";

function openTask(): ReviewTask {
  return openReviewTask({
    taskId: "task-1",
    caseId: "case-1",
    reason: "budget_exhausted",
    priority: "high",
    evidenceCompleteness: "complete",
  });
}

describe("ReviewTask domain", () => {
  it("opens a task at version 1", () => {
    const task = openTask();
    expect(task).toMatchObject({ status: "open", version: 1 });
    expect(task.assigneeId).toBeUndefined();
  });

  it("claims an open task, advancing status and version", () => {
    const task = openTask();
    const claimed = claimReviewTask(task, {
      taskId: "task-1",
      expectedVersion: 1,
      reviewerId: "alice",
      idempotencyKey: "k1",
    });
    expect(claimed).toMatchObject({
      status: "claimed",
      assigneeId: "alice",
      version: 2,
    });
  });

  it("rejects a claim at a stale version with the current truth", () => {
    const claimed = claimReviewTask(openTask(), {
      taskId: "task-1",
      expectedVersion: 1,
      reviewerId: "alice",
      idempotencyKey: "k1",
    });
    try {
      claimReviewTask(claimed, {
        taskId: "task-1",
        expectedVersion: 1,
        reviewerId: "bob",
        idempotencyKey: "k2",
      });
      throw new Error("expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewTaskVersionConflict);
      expect(error).toMatchObject({
        code: "ReviewTaskVersionConflict",
        currentVersion: 2,
        assigneeId: "alice",
      });
    }
  });

  it("reports canClaim only for an open task at the expected version", () => {
    const task = openTask();
    expect(canClaim(task, { taskId: "task-1", expectedVersion: 1, reviewerId: "a", idempotencyKey: "k" })).toBe(true);
    expect(canClaim(task, { taskId: "task-1", expectedVersion: 2, reviewerId: "a", idempotencyKey: "k" })).toBe(false);
  });

  it("resolves a claimed task by its assignee", () => {
    const claimed = claimReviewTask(openTask(), {
      taskId: "task-1",
      expectedVersion: 1,
      reviewerId: "alice",
      idempotencyKey: "k1",
    });
    const { task, resolution } = resolveReviewTask(claimed, {
      taskId: "task-1",
      expectedVersion: 2,
      reviewerId: "alice",
      disposition: "confirmed_bug",
      evidenceRefs: ["evidence-1"],
      idempotencyKey: "r1",
    });
    expect(task).toMatchObject({ status: "resolved", version: 3 });
    expect(resolution).toMatchObject({
      caseId: "case-1",
      disposition: "confirmed_bug",
      evidenceRefs: ["evidence-1"],
    });
  });

  it("refuses resolution by a non-assignee", () => {
    const claimed = claimReviewTask(openTask(), {
      taskId: "task-1",
      expectedVersion: 1,
      reviewerId: "alice",
      idempotencyKey: "k1",
    });
    expect(canResolve(claimed, {
      taskId: "task-1",
      expectedVersion: 2,
      reviewerId: "bob",
      disposition: "x",
      evidenceRefs: [],
      idempotencyKey: "r",
    })).toBe(false);
    try {
      resolveReviewTask(claimed, {
        taskId: "task-1",
        expectedVersion: 2,
        reviewerId: "bob",
        disposition: "x",
        evidenceRefs: [],
        idempotencyKey: "r",
      });
      throw new Error("expected a non-assignee rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewTaskError);
      expect((error as ReviewTaskError).code).toBe("ReviewTaskNotAssignee");
    }
  });

  it("refuses to resolve a task that was never claimed", () => {
    expect(() =>
      resolveReviewTask(openTask(), {
        taskId: "task-1",
        expectedVersion: 1,
        reviewerId: "alice",
        disposition: "x",
        evidenceRefs: [],
        idempotencyKey: "r",
      }),
    ).toThrowError(/ReviewTaskNotClaimed/);
  });
});
