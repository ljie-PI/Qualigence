import type { FastifyInstance } from "fastify";
import type { CreateTargetBody, TargetDto } from "@qualigence/public-api";
import { ProjectTargetError, type TargetRevision } from "@qualigence/project-target";
import {
  authenticateOidc,
  requireIdempotencyKey,
  requireRole,
  projectTargetService,
  projectTargets,
  withTenant,
  type ServerDeps,
} from "../server-context.js";
import { commandEnvelope, listEnvelope } from "../envelopes.js";
import { newCorrelationId, notFound, validationFailed, versionConflict } from "../errors.js";

function toDto(row: TargetRevision): TargetDto {
  return {
    targetId: row.targetId,
    projectId: row.projectId,
    kind: row.configuration.kind,
    displayName: row.displayName,
    runnerId: row.runnerId,
    version: row.version,
    snapshotHash: row.snapshotHash,
    configuration: row.configuration,
  };
}

export function registerTargetRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/targets",
    async (request, reply) => {
      const principal = await authenticateOidc(deps, request);
      requireRole(deps, principal, "viewer");
      const rows = await withTenant(deps, principal.tenantId, (stores) => projectTargets(deps, stores, principal.tenantId).listProjectTargets(request.params.projectId));
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
      if (typeof body.displayName !== "string" || body.displayName.trim().length === 0) {
        throw validationFailed("target displayName is required");
      }
      if (typeof body.runnerId !== "string" || typeof body.expectedVersion !== "number" || body.configuration === undefined) throw validationFailed("runnerId, expectedVersion and configuration are required");
      if (typeof body.targetId !== "string" || body.targetId.trim().length === 0) throw validationFailed("targetId is required");
      const targetId = body.targetId;
      const displayName = body.displayName;
      const runnerId = body.runnerId;
      const expectedVersion = body.expectedVersion;

      const dto = await withTenant(deps, principal.tenantId, async (stores) => {
        const project = await stores.aux
          .selectFrom("projects")
          .select("project_id")
          .where("project_id", "=", request.params.projectId)
          .executeTakeFirst();
        if (project === undefined) {
          throw notFound("project not found");
        }
        try {
          return toDto(await projectTargetService(deps, stores, principal.tenantId).createRevision({ targetId, projectId: request.params.projectId, displayName, runnerId, expectedVersion, configuration: body.configuration, idempotencyKey }));
        } catch (error) {
          if (error instanceof ProjectTargetError && (error.code === "TargetVersionConflict" || error.code === "TargetIdempotencyConflict")) throw versionConflict({ actualVersion: error.currentVersion });
          if (error instanceof ProjectTargetError) throw validationFailed(error.code);
          throw error;
        }
      });

      return reply.status(201).send(commandEnvelope(dto, dto.version, newCorrelationId()));
    },
  );
}
