import {
  ReviewTaskVersionConflict,
  type ClaimReviewTaskCommand,
  type ReviewTask,
  type ReviewTaskRepository,
} from "../domain/review-task.js";

/**
 * Claims a Review Task under expected-version optimistic concurrency. The
 * repository performs the atomic conditional write; if it does not apply (the
 * task is no longer Open at the expected version, and this is not an idempotent
 * replay), the handler reads the current aggregate truth and throws an explicit
 * {@link ReviewTaskVersionConflict}. It never overwrites with a stale value.
 */
export class ClaimReviewTaskHandler {
  constructor(private readonly repository: ReviewTaskRepository) {}

  async handle(command: ClaimReviewTaskCommand): Promise<ReviewTask> {
    const updated = await this.repository.claim(command);
    if (updated !== undefined) {
      return updated;
    }
    const current = await this.repository.find(command.taskId);
    if (current === undefined) {
      throw new ReviewTaskVersionConflict(0, undefined);
    }
    throw new ReviewTaskVersionConflict(current.version, current.assigneeId);
  }
}
