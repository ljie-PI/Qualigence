import type { FastifyInstance } from "fastify";
import type {
  ClaimReviewTaskBody,
  ResolveReviewTaskBody,
  ReviewTaskDto,
} from "@qualigence/public-api";
import {
  ClaimReviewTaskHandler,
  ResolveReviewTaskHandler,
  ReviewTaskError,
  type ReviewTask,
} from "@qualigence/review";
import {
  authenticateOidc,
  requireIdempotencyKey,
  requireRole,
  withTenant,
  type ServerDeps,
} from "../server-context.js";
import { commandEnvelope, listEnvelope } from "../envelopes.js";
import {
  newCorrelationId,
  validationFailed,
  versionConflict,
} from "../errors.js";

interface TaskRow {
  task_id: string;
  case_id: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  version: number;
}

function toDto(row: TaskRow): ReviewTaskDto {
  return {
    taskId: row.task_id,
    caseId: row.case_id,
    status: row.status as ReviewTaskDto["status"],
    priority: row.priority as ReviewTaskDto["priority"],
    ...(row.assignee_id !== null ? { assigneeId: row.assignee_id } : {}),
    version: row.version,
  };
}

function taskToDto(task: ReviewTask): ReviewTaskDto {
  return {
    taskId: task.taskId,
    caseId: task.caseId,
    status: task.status,
    priority: task.priority,
    ...(task.assigneeId === undefined ? {} : { assigneeId: task.assigneeId }),
    version: task.version,
  };
}

function rethrowSafeReviewError(error: unknown, expectedVersion: number): never {
  if (!(error instanceof ReviewTaskError)) {
    throw error;
  }
  throw versionConflict(
    {
      expectedVersion,
      ...(error.currentVersion === undefined ? {} : { actualVersion: error.currentVersion }),
      ...(error.assigneeId === undefined ? {} : { assigneeId: error.assigneeId }),
    },
  );
}

export function registerReviewTaskRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/v1/review-tasks", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "reviewer");
    const rows = await withTenant(deps, principal.tenantId, (stores) =>
      (stores.db
        .selectFrom("review_tasks")
        .select(["task_id", "case_id", "status", "priority", "assignee_id", "version"])
        .orderBy("created_at", "asc")
        .execute()) as Promise<TaskRow[]>,
    );
    return reply.send(listEnvelope(rows.map(toDto), deps.clock.now()));
  });

  app.post<{ Params: { taskId: string }; Body: Partial<ClaimReviewTaskBody> }>(
    "/v1/review-tasks/:taskId/claim",
    async (request, reply) => {
      const principal = await authenticateOidc(deps, request);
      requireRole(deps, principal, "reviewer");
      const idempotencyKey = requireIdempotencyKey(request);
      const body = request.body ?? {};
      if (typeof body.expectedVersion !== "number") {
        throw validationFailed("expectedVersion is required");
      }
      if (typeof body.reviewerId !== "string" || body.reviewerId.length === 0) {
        throw validationFailed("reviewerId is required");
      }
      const dto = await withTenant(deps, principal.tenantId, async (stores) => {
        try {
          const task = await new ClaimReviewTaskHandler(deps.reviewRepository(stores)).handle({
            taskId: request.params.taskId,
            expectedVersion: body.expectedVersion as number,
            reviewerId: body.reviewerId as string,
            idempotencyKey,
          });
          return taskToDto(task);
        } catch (error) {
          return rethrowSafeReviewError(error, body.expectedVersion as number);
        }
      });

      return reply.send(commandEnvelope(dto, dto.version, newCorrelationId()));
    },
  );

  app.post<{ Params: { taskId: string }; Body: Partial<ResolveReviewTaskBody> }>(
    "/v1/review-tasks/:taskId/resolve",
    async (request, reply) => {
      const principal = await authenticateOidc(deps, request);
      requireRole(deps, principal, "reviewer");
      const idempotencyKey = requireIdempotencyKey(request);
      const body = request.body ?? {};
      if (typeof body.expectedVersion !== "number") {
        throw validationFailed("expectedVersion is required");
      }
      if (typeof body.reviewerId !== "string" || body.reviewerId.length === 0) {
        throw validationFailed("reviewerId is required");
      }
      if (typeof body.disposition !== "string" || body.disposition.length === 0) {
        throw validationFailed("disposition is required");
      }
      const evidenceRefs = Array.isArray(body.evidenceRefs) ? body.evidenceRefs : [];

      const dto = await withTenant(deps, principal.tenantId, async (stores) => {
        try {
          const task = await new ResolveReviewTaskHandler(deps.reviewRepository(stores)).handle({
            taskId: request.params.taskId,
            expectedVersion: body.expectedVersion as number,
            reviewerId: body.reviewerId as string,
            disposition: body.disposition as string,
            evidenceRefs,
            idempotencyKey,
          });
          return taskToDto(task);
        } catch (error) {
          return rethrowSafeReviewError(error, body.expectedVersion as number);
        }
      });

      return reply.send(commandEnvelope(dto, dto.version, newCorrelationId()));
    },
  );
}
