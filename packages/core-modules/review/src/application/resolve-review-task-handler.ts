import {
  ReviewTaskError,
  ReviewTaskVersionConflict,
  type ResolveReviewTaskCommand,
  type ReviewTask,
  type ReviewTaskRepository,
} from "../domain/review-task.js";

/**
 * Resolves a claimed Review Task. Only the current assignee, at the expected
 * version, may resolve; the repository's atomic conditional write enforces this.
 * A non-assignee or stale-version resolve is rejected with the current aggregate
 * truth; a duplicate idempotency key returns the already-resolved aggregate.
 */
export class ResolveReviewTaskHandler {
  constructor(private readonly repository: ReviewTaskRepository) {}

  async handle(command: ResolveReviewTaskCommand): Promise<ReviewTask> {
    const updated = await this.repository.resolve(command);
    if (updated !== undefined) {
      return updated;
    }
    const current = await this.repository.find(command.taskId);
    if (current === undefined) {
      throw new ReviewTaskVersionConflict(0, undefined);
    }
    if (current.status === "resolved") {
      throw new ReviewTaskError(
        "ReviewTaskAlreadyResolved",
        `Review task ${command.taskId} is already resolved.`,
        { currentVersion: current.version },
      );
    }
    if (current.assigneeId !== command.reviewerId) {
      throw new ReviewTaskError(
        "ReviewTaskNotAssignee",
        `Review task ${command.taskId} can only be resolved by its assignee.`,
        {
          currentVersion: current.version,
          ...(current.assigneeId === undefined
            ? {}
            : { assigneeId: current.assigneeId }),
        },
      );
    }
    throw new ReviewTaskVersionConflict(current.version, current.assigneeId);
  }
}
