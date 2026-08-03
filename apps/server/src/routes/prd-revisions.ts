import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { IngestPrdBody, PrdRevisionDto } from "@qualigence/public-api";
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
      const rows = await withTenant(deps, principal.tenantId, (stores) =>
        stores.aux
          .selectFrom("prd_revisions")
          .select(["prd_id", "project_id", "revision", "title", "content_sha256", "ingested_at"])
          .where("project_id", "=", request.params.projectId)
          .orderBy("revision", "asc")
          .execute(),
      );
      return reply.send(listEnvelope(rows.map(toDto), deps.clock.now()));
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
      const now = deps.clock.now();
      const contentSha256 = createHash("sha256").update(body.content).digest("hex");

      const dto = await withTenant(deps, principal.tenantId, async (stores) => {
        const project = await stores.aux
          .selectFrom("projects")
          .select("project_id")
          .where("project_id", "=", request.params.projectId)
          .executeTakeFirst();
        if (project === undefined) {
          throw notFound("project not found");
        }
        // The revision number is monotonic per project; the Idempotency-Key is
        // the prd_id so a retried ingest of the same document is a no-op.
        const existing = await stores.aux
          .selectFrom("prd_revisions")
          .select(["prd_id", "project_id", "revision", "title", "content_sha256", "ingested_at"])
          .where("prd_id", "=", idempotencyKey)
          .executeTakeFirst();
        if (existing !== undefined) {
          return toDto(existing);
        }
        const maxRow = await stores.aux
          .selectFrom("prd_revisions")
          .select((eb) => eb.fn.max("revision").as("max"))
          .where("project_id", "=", request.params.projectId)
          .executeTakeFirst();
        const revision = Number(maxRow?.max ?? 0) + 1;
        await stores.aux
          .insertInto("prd_revisions")
          .values({
            tenant_id: principal.tenantId,
            prd_id: idempotencyKey,
            project_id: request.params.projectId,
            revision,
            title: body.title as string,
            content_sha256: contentSha256,
            ingested_at: now,
          })
          .onConflict((oc) => oc.columns(["tenant_id", "prd_id"]).doNothing())
          .execute();
        const row = await stores.aux
          .selectFrom("prd_revisions")
          .select(["prd_id", "project_id", "revision", "title", "content_sha256", "ingested_at"])
          .where("prd_id", "=", idempotencyKey)
          .executeTakeFirst();
        if (row === undefined) {
          throw notFound("PRD revision could not be created");
        }
        return toDto(row);
      });

      return reply.status(201).send(commandEnvelope(dto, dto.revision, newCorrelationId()));
    },
  );
}
