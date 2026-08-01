import type { FastifyInstance } from "fastify";
import type { CreateTargetBody, TargetDto } from "@qualigence/public-api";
import {
  authenticateOidc,
  requireIdempotencyKey,
  requireRole,
  withTenant,
  type ServerDeps,
} from "../server-context.js";
import { commandEnvelope, listEnvelope } from "../envelopes.js";
import { newCorrelationId, notFound, validationFailed } from "../errors.js";

function toDto(row: {
  target_id: string;
  project_id: string;
  kind: string;
  display_name: string;
  version: number;
}): TargetDto {
  return {
    targetId: row.target_id,
    projectId: row.project_id,
    kind: row.kind as TargetDto["kind"],
    displayName: row.display_name,
    version: row.version,
  };
}

export function registerTargetRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/targets",
    async (request, reply) => {
      const principal = await authenticateOidc(deps, request);
      requireRole(deps, principal, "viewer");
      const rows = await withTenant(deps, principal.tenantId, (stores) =>
        stores.aux
          .selectFrom("targets")
          .select(["target_id", "project_id", "kind", "display_name", "version"])
          .where("project_id", "=", request.params.projectId)
          .orderBy("created_at", "asc")
          .execute(),
      );
      return reply.send(listEnvelope(rows.map(toDto), deps.clock.now()));
    },
  );

  app.post<{ Params: { projectId: string }; Body: Partial<CreateTargetBody> }>(
    "/v1/projects/:projectId/targets",
    async (request, reply) => {
      const principal = await authenticateOidc(deps, request);
      requireRole(deps, principal, "tester");
      const idempotencyKey = requireIdempotencyKey(request);
      const body = request.body ?? {};
      if (body.kind !== "web" && body.kind !== "app") {
        throw validationFailed("target kind must be 'web' or 'app'");
      }
      if (typeof body.displayName !== "string" || body.displayName.trim().length === 0) {
        throw validationFailed("target displayName is required");
      }
      const now = deps.clock.now();
      const targetId = idempotencyKey;

      const dto = await withTenant(deps, principal.tenantId, async (stores) => {
        const project = await stores.aux
          .selectFrom("projects")
          .select("project_id")
          .where("project_id", "=", request.params.projectId)
          .executeTakeFirst();
        if (project === undefined) {
          throw notFound("project not found");
        }
        await stores.aux
          .insertInto("targets")
          .values({
            tenant_id: principal.tenantId,
            target_id: targetId,
            project_id: request.params.projectId,
            kind: body.kind as string,
            display_name: body.displayName as string,
            version: 1,
            created_at: now,
          })
          .onConflict((oc) => oc.columns(["tenant_id", "target_id"]).doNothing())
          .execute();
        const row = await stores.aux
          .selectFrom("targets")
          .select(["target_id", "project_id", "kind", "display_name", "version"])
          .where("target_id", "=", targetId)
          .executeTakeFirst();
        if (row === undefined) {
          throw notFound("target could not be created");
        }
        return toDto(row);
      });

      return reply.status(201).send(commandEnvelope(dto, dto.version, newCorrelationId()));
    },
  );
}
