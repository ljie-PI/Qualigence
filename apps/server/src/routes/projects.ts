import type { FastifyInstance } from "fastify";
import type {
  CreateProjectBody,
  ProjectDto,
} from "@qualigence/public-api";
import {
  authenticateOidc,
  requireIdempotencyKey,
  requireRole,
  withTenant,
  type ServerDeps,
} from "../server-context.js";
import { commandEnvelope, listEnvelope } from "../envelopes.js";
import { newCorrelationId, notFound, validationFailed } from "../errors.js";

function toDto(row: { project_id: string; name: string; version: number }): ProjectDto {
  return { projectId: row.project_id, name: row.name, version: row.version };
}

export function registerProjectRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/v1/projects", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const rows = await withTenant(deps, principal.tenantId, (stores) =>
      stores.aux
        .selectFrom("projects")
        .select(["project_id", "name", "version"])
        .orderBy("created_at", "asc")
        .execute(),
    );
    return reply.send(listEnvelope(rows.map(toDto), deps.clock.now()));
  });

  app.post("/v1/projects", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "tester");
    const idempotencyKey = requireIdempotencyKey(request);
    const body = (request.body ?? {}) as Partial<CreateProjectBody>;
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw validationFailed("project name is required");
    }
    const now = deps.clock.now();

    const dto = await withTenant(deps, principal.tenantId, async (stores) => {
      // Idempotent create: the Idempotency-Key is the project id, so a retried
      // POST returns the same resource instead of creating a duplicate.
      await stores.aux
        .insertInto("projects")
        .values({
          tenant_id: principal.tenantId,
          project_id: idempotencyKey,
          name: body.name as string,
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "project_id"]).doNothing())
        .execute();
      const row = await stores.aux
        .selectFrom("projects")
        .select(["project_id", "name", "version"])
        .where("project_id", "=", idempotencyKey)
        .executeTakeFirst();
      if (row === undefined) {
        throw notFound("project could not be created");
      }
      return toDto(row);
    });

    return reply.status(201).send(commandEnvelope(dto, dto.version, newCorrelationId()));
  });
}
