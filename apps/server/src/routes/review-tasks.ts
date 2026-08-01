import type { FastifyInstance } from "fastify";
import type {
  ClaimReviewTaskBody,
  ResolveReviewTaskBody,
  ReviewTaskDto,
} from "@qualigence/public-api";
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
  notFound,
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
      const now = deps.clock.now();

      const dto = await withTenant(deps, principal.tenantId, async (stores) => {
        const existingClaim = await stores.db
          .selectFrom("review_claims")
          .select("task_id")
          .where("idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        const current = (await stores.db
          .selectFrom("review_tasks")
          .select(["task_id", "case_id", "status", "priority", "assignee_id", "version"])
          .where("task_id", "=", request.params.taskId)
          .executeTakeFirst()) as TaskRow | undefined;
        if (current === undefined) {
          throw notFound("review task not found");
        }
        // Idempotent replay: the same key returns the already-applied state.
        if (existingClaim !== undefined) {
          return toDto(current);
        }
        if (current.version !== body.expectedVersion) {
          throw versionConflict({ expectedVersion: body.expectedVersion, actualVersion: current.version });
        }
        const nextVersion = current.version + 1;
        await stores.db
          .updateTable("review_tasks")
          .set({ status: "claimed", assignee_id: body.reviewerId as string, version: nextVersion, updated_at: now })
          .where("task_id", "=", request.params.taskId)
          .where("version", "=", body.expectedVersion as number)
          .execute();
        await stores.db
          .insertInto("review_claims")
          .values({
            tenant_id: principal.tenantId,
            idempotency_key: idempotencyKey,
            task_id: request.params.taskId,
            reviewer_id: body.reviewerId as string,
            claimed_version: nextVersion,
            created_at: now,
          } as never)
          .execute();
        return {
          taskId: current.task_id,
          caseId: current.case_id,
          status: "claimed" as const,
          priority: current.priority as ReviewTaskDto["priority"],
          assigneeId: body.reviewerId as string,
          version: nextVersion,
        } satisfies ReviewTaskDto;
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
      const now = deps.clock.now();
      const evidenceRefs = Array.isArray(body.evidenceRefs) ? body.evidenceRefs : [];

      const dto = await withTenant(deps, principal.tenantId, async (stores) => {
        const existing = await stores.db
          .selectFrom("review_resolutions")
          .select("task_id")
          .where("idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        const current = (await stores.db
          .selectFrom("review_tasks")
          .select(["task_id", "case_id", "status", "priority", "assignee_id", "version"])
          .where("task_id", "=", request.params.taskId)
          .executeTakeFirst()) as TaskRow | undefined;
        if (current === undefined) {
          throw notFound("review task not found");
        }
        if (existing !== undefined) {
          return toDto(current);
        }
        if (current.version !== body.expectedVersion) {
          throw versionConflict({ expectedVersion: body.expectedVersion, actualVersion: current.version });
        }
        const nextVersion = current.version + 1;
        await stores.db
          .updateTable("review_tasks")
          .set({ status: "resolved", version: nextVersion, updated_at: now })
          .where("task_id", "=", request.params.taskId)
          .where("version", "=", body.expectedVersion as number)
          .execute();
        await stores.db
          .insertInto("review_resolutions")
          .values({
            tenant_id: principal.tenantId,
            idempotency_key: idempotencyKey,
            task_id: request.params.taskId,
            case_id: current.case_id,
            reviewer_id: body.reviewerId as string,
            disposition: body.disposition as string,
            evidence_refs_json: JSON.stringify(evidenceRefs),
            resolved_version: nextVersion,
            created_at: now,
          } as never)
          .execute();
        return {
          taskId: current.task_id,
          caseId: current.case_id,
          status: "resolved" as const,
          priority: current.priority as ReviewTaskDto["priority"],
          ...(current.assignee_id !== null ? { assigneeId: current.assignee_id } : {}),
          version: nextVersion,
        } satisfies ReviewTaskDto;
      });

      return reply.send(commandEnvelope(dto, dto.version, newCorrelationId()));
    },
  );
}
