import type { FastifyInstance } from "fastify";
import type { IngestPrdBody, PrdRevisionDto } from "@qualigence/public-api";
import { TestPlanServiceError } from "@qualigence/mission";
import {
  authenticateOidc,
  requireIdempotencyKey,
  requireRole,
  testPlanService,
  withTenant,
  type ServerDeps,
} from "../server-context.js";
import { commandEnvelope, listEnvelope } from "../envelopes.js";
import { newCorrelationId, notFound, validationFailed, versionConflict } from "../errors.js";

function toDto(row: {
  prd_id: string;
  project_id: string;
  revision: number;
  title: string;
  content_sha256: string;
  ingested_at: string;
}): PrdRevisionDto {
  return {
    prdId: row.prd_id,
    projectId: row.project_id,
    revision: row.revision,
    title: row.title,
    contentSha256: row.content_sha256,
    ingestedAt: row.ingested_at,
  };
}

export function registerPrdRevisionRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/prd-revisions",
    async (request, reply) => {
      const principal = await authenticateOidc(deps, request);
      requireRole(deps, principal, "viewer");
      const documents = await withTenant(deps, principal.tenantId, (stores) => testPlanService(deps, stores, principal.tenantId).listPrds(request.params.projectId));
      return reply.send(listEnvelope(documents.map((document) => toDto({ prd_id: document.prdId, project_id: document.projectId, revision: document.revision, title: document.title, content_sha256: document.contentSha256, ingested_at: document.ingestedAt })), deps.clock.now()));
    },
  );

  app.post<{ Params: { projectId: string }; Body: Partial<IngestPrdBody> }>(
    "/v1/projects/:projectId/prd-revisions",
    async (request, reply) => {
      const principal = await authenticateOidc(deps, request);
      requireRole(deps, principal, "tester");
      const idempotencyKey = requireIdempotencyKey(request);
      const body = request.body ?? {};
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        throw validationFailed("PRD title is required");
      }
      if (typeof body.content !== "string" || body.content.length === 0) {
        throw validationFailed("PRD content is required");
      }
      let document;
      try {
        document = await withTenant(deps, principal.tenantId, (stores) => testPlanService(deps, stores, principal.tenantId).ingestPrd({ idempotencyKey, projectId: request.params.projectId, title: body.title as string, content: body.content as string }));
      } catch (error) {
        if (error instanceof TestPlanServiceError && error.code === "PlanProjectMismatch") throw notFound("project not found");
        if (error instanceof TestPlanServiceError && error.code === "PrdIdempotencyConflict") throw versionConflict({}, "idempotency key is bound to another PRD revision");
        throw error;
      }
      const dto = toDto({ prd_id: document.prdId, project_id: document.projectId, revision: document.revision, title: document.title, content_sha256: document.contentSha256, ingested_at: document.ingestedAt });

      return reply.status(201).send(commandEnvelope(dto, dto.revision, newCorrelationId()));
    },
  );
}
