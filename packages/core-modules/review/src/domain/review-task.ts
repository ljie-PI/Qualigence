/**
 * The Human Review Queue aggregate. A {@link ReviewTask} is created (typically
 * when an investigation exits to Needs Human) and moves Open → Claimed →
 * Resolved. Claiming and resolving are expected-version, idempotency-keyed
 * commands: two concurrent claimants can never both win, and a stale/losing
 * claimant always receives an explicit conflict carrying the current aggregate
 * truth (version + assignee) — never a silent overwrite by a lagging projection.
 */

export type ReviewTaskStatus = "open" | "claimed" | "resolved";
export type ReviewTaskPriority = "low" | "medium" | "high" | "urgent";
export type ReviewEvidenceCompleteness = "complete" | "limited" | "unavailable";

export interface ReviewTask {
  readonly taskId: string;
  readonly caseId: string;
  readonly status: ReviewTaskStatus;
  readonly reason: string;
  readonly priority: ReviewTaskPriority;
  readonly evidenceCompleteness: ReviewEvidenceCompleteness;
  readonly assigneeId?: string;
  readonly version: number;
}

export interface ReviewTaskDraft {
  readonly taskId: string;
  readonly caseId: string;
  readonly reason: string;
  readonly priority: ReviewTaskPriority;
  readonly evidenceCompleteness: ReviewEvidenceCompleteness;
}

export interface ClaimReviewTaskCommand {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly reviewerId: string;
  readonly idempotencyKey: string;
}

export interface ResolveReviewTaskCommand {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly reviewerId: string;
  readonly disposition: string;
  readonly evidenceRefs: readonly string[];
  readonly idempotencyKey: string;
}

/** The immutable record of a resolved review. */
export interface ReviewResolution {
  readonly taskId: string;
  readonly caseId: string;
  readonly reviewerId: string;
  readonly disposition: string;
  readonly evidenceRefs: readonly string[];
  readonly idempotencyKey: string;
}

export type ReviewTaskErrorCode =
  | "ReviewTaskVersionConflict"
  | "ReviewTaskNotOpen"
  | "ReviewTaskNotClaimed"
  | "ReviewTaskNotAssignee"
  | "ReviewTaskAlreadyResolved";

export class ReviewTaskError extends Error {
  readonly code: ReviewTaskErrorCode;
  readonly currentVersion?: number;
  readonly assigneeId?: string;

  constructor(
    code: ReviewTaskErrorCode,
    message: string,
    context: { readonly currentVersion?: number; readonly assigneeId?: string } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "ReviewTaskError";
    this.code = code;
    if (context.currentVersion !== undefined) {
      this.currentVersion = context.currentVersion;
    }
    if (context.assigneeId !== undefined) {
      this.assigneeId = context.assigneeId;
    }
  }
}

/** The explicit conflict returned when a losing/stale claimant cannot claim. */
export class ReviewTaskVersionConflict extends ReviewTaskError {
  constructor(currentVersion: number, assigneeId: string | undefined) {
    super(
      "ReviewTaskVersionConflict",
      `The review task has advanced to version ${currentVersion}.`,
      { currentVersion, ...(assigneeId === undefined ? {} : { assigneeId }) },
    );
    this.name = "ReviewTaskVersionConflict";
  }
}

export function openReviewTask(draft: ReviewTaskDraft): ReviewTask {
  return {
    taskId: draft.taskId,
    caseId: draft.caseId,
    status: "open",
    reason: draft.reason,
    priority: draft.priority,
    evidenceCompleteness: draft.evidenceCompleteness,
    version: 1,
  };
}

/** True when a claim command may be applied to the given task. */
export function canClaim(
  task: ReviewTask,
  command: ClaimReviewTaskCommand,
): boolean {
  return task.status === "open" && task.version === command.expectedVersion;
}

/**
 * Deterministically apply a claim, advancing Open → Claimed with a new version.
 * Throws {@link ReviewTaskVersionConflict} if the task is not Open at the
 * expected version.
 */
export function claimReviewTask(
  task: ReviewTask,
  command: ClaimReviewTaskCommand,
): ReviewTask {
  if (task.status !== "open") {
    throw new ReviewTaskVersionConflict(task.version, task.assigneeId);
  }
  if (task.version !== command.expectedVersion) {
    throw new ReviewTaskVersionConflict(task.version, task.assigneeId);
  }
  return {
    ...task,
    status: "claimed",
    assigneeId: command.reviewerId,
    version: task.version + 1,
  };
}

/** True when a resolve command may be applied to the given task. */
export function canResolve(
  task: ReviewTask,
  command: ResolveReviewTaskCommand,
): boolean {
  return (
    task.status === "claimed" &&
    task.version === command.expectedVersion &&
    task.assigneeId === command.reviewerId
  );
}

/**
 * Deterministically resolve a claimed task. Only the current assignee, at the
 * expected version, may resolve; anyone else — or a stale version — is rejected.
 */
export function resolveReviewTask(
  task: ReviewTask,
  command: ResolveReviewTaskCommand,
): { readonly task: ReviewTask; readonly resolution: ReviewResolution } {
  if (task.status === "resolved") {
    throw new ReviewTaskError(
      "ReviewTaskAlreadyResolved",
      `Review task ${task.taskId} is already resolved.`,
      { currentVersion: task.version },
    );
  }
  if (task.status !== "claimed") {
    throw new ReviewTaskError(
      "ReviewTaskNotClaimed",
      `Review task ${task.taskId} must be claimed before it can be resolved.`,
      { currentVersion: task.version },
    );
  }
  if (task.version !== command.expectedVersion) {
    throw new ReviewTaskVersionConflict(task.version, task.assigneeId);
  }
  if (task.assigneeId !== command.reviewerId) {
    throw new ReviewTaskError(
      "ReviewTaskNotAssignee",
      `Review task ${task.taskId} can only be resolved by its assignee.`,
      { currentVersion: task.version, ...(task.assigneeId === undefined ? {} : { assigneeId: task.assigneeId }) },
    );
  }
  return {
    task: {
      ...task,
      status: "resolved",
      version: task.version + 1,
    },
    resolution: {
      taskId: task.taskId,
      caseId: task.caseId,
      reviewerId: command.reviewerId,
      disposition: command.disposition,
      evidenceRefs: [...command.evidenceRefs],
      idempotencyKey: command.idempotencyKey,
    },
  };
}

/**
 * The persistence port for the Review Queue. `claim`/`resolve` MUST be atomic
 * conditional writes (expected-version compare-and-set); they return the updated
 * aggregate on success, the already-applied aggregate on an idempotent replay,
 * and `undefined` when the condition did not hold so the handler can surface the
 * current aggregate truth as a conflict.
 */
export interface ReviewTaskRepository {
  create(task: ReviewTask): Promise<void>;
  find(taskId: string): Promise<ReviewTask | undefined>;
  claim(command: ClaimReviewTaskCommand): Promise<ReviewTask | undefined>;
  resolve(command: ResolveReviewTaskCommand): Promise<ReviewTask | undefined>;
}
