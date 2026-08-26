import type { FastifyInstance } from "fastify";
import type { ArtifactMetadataDto } from "@qualigence/public-api";
import type { ArtifactKind, ArtifactManifest, ArtifactStore } from "@qualigence/evidence";
import {
  authenticateOidc,
  requireRole,
  withTenant,
  type ServerDeps,
  type TenantStores,
} from "../server-context.js";
import { ApiError, notFound, validationFailed } from "../errors.js";

const EVIDENCE_PURPOSE = "investigation";

export function registerEvidenceRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{
    Params: { projectId: string; runId: string; artifactId: string };
    Querystring: { purpose?: string };
  }>("/v1/projects/:projectId/runs/:runId/artifacts/:artifactId", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    assertEvidencePurpose(request.query.purpose);
    const manifest = await withTenant(deps, principal.tenantId, (stores) =>
      loadAuthorizedArtifact(stores, {
        tenantId: principal.tenantId,
        projectId: request.params.projectId,
        runId: request.params.runId,
        artifactId: request.params.artifactId,
      }),
    );
    if (manifest === undefined) throw notFound("Evidence artifact not found");
    return reply.send(toMetadataDto(manifest));
  });

  app.get<{
    Params: { projectId: string; runId: string; artifactId: string };
    Querystring: { purpose?: string };
  }>("/v1/projects/:projectId/runs/:runId/artifacts/:artifactId/bytes", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    assertEvidencePurpose(request.query.purpose);
    const manifest = await withTenant(deps, principal.tenantId, (stores) =>
      loadAuthorizedArtifact(stores, {
        tenantId: principal.tenantId,
        projectId: request.params.projectId,
        runId: request.params.runId,
        artifactId: request.params.artifactId,
      }),
    );
    if (manifest === undefined) throw notFound("Evidence artifact not found");
    const artifactStore = deps.artifactStore?.({
      tenantId: principal.tenantId,
      projectId: request.params.projectId,
    });
    if (artifactStore === undefined) {
      throw evidenceUnavailable("Evidence byte storage is not configured");
    }
    let bytes: Uint8Array;
    try {
      bytes = await artifactStore.read(manifest);
    } catch (cause) {
      throw evidenceUnavailable("Evidence bytes are unavailable", cause);
    }
    return reply
      .type(manifest.mediaType)
      .header("content-length", String(bytes.byteLength))
      .send(Buffer.from(bytes));
  });
}

interface AuthorizedArtifactKey {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly artifactId: string;
}

async function loadAuthorizedArtifact(
  stores: TenantStores,
  key: AuthorizedArtifactKey,
): Promise<ArtifactManifest | undefined> {
  const row = await stores.db
    .selectFrom("artifact_manifests as artifact")
    .innerJoin("artifact_upload_manifests as upload", (join) =>
      join
        .onRef("upload.tenant_id", "=", "artifact.tenant_id")
        .onRef("upload.artifact_id", "=", "artifact.artifact_id")
        .onRef("upload.run_id", "=", "artifact.run_id"),
    )
    .innerJoin("mission_job_attempts as attempt", (join) =>
      join
        .onRef("attempt.tenant_id", "=", "artifact.tenant_id")
        .onRef("attempt.run_id", "=", "artifact.run_id"),
    )
    .innerJoin("missions as mission", (join) =>
      join
        .onRef("mission.tenant_id", "=", "attempt.tenant_id")
        .onRef("mission.mission_id", "=", "attempt.mission_id")
        .onRef("mission.revision", "=", "attempt.mission_revision"),
    )
    .select([
      "artifact.artifact_id as artifact_id",
      "artifact.run_id as run_id",
      "artifact.kind as kind",
      "artifact.media_type as media_type",
      "artifact.relative_path as relative_path",
      "artifact.sha256 as sha256",
      "artifact.size_bytes as size_bytes",
      "artifact.created_at as created_at",
    ])
    .where("artifact.tenant_id", "=", key.tenantId)
    .where("artifact.artifact_id", "=", key.artifactId)
    .where("artifact.run_id", "=", key.runId)
    .where("upload.project_id", "=", key.projectId)
    .where("mission.project_id", "=", key.projectId)
    .where("upload.status", "=", "verified")
    .whereRef("upload.relative_path", "=", "artifact.relative_path")
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    kind: row.kind as ArtifactKind,
    mediaType: row.media_type,
    relativePath: row.relative_path,
    sha256: row.sha256,
    size: row.size_bytes,
    createdAt: row.created_at,
  };
}

function toMetadataDto(manifest: ArtifactManifest): ArtifactMetadataDto {
  return {
    artifactId: manifest.artifactId,
    runId: manifest.runId,
    kind: manifest.kind,
    mediaType: manifest.mediaType,
    size: manifest.size,
    sha256: manifest.sha256,
    downloadAllowed: true,
  };
}

function assertEvidencePurpose(purpose: string | undefined): void {
  if (purpose !== EVIDENCE_PURPOSE) {
    throw validationFailed("purpose must be investigation");
  }
}

function evidenceUnavailable(message: string, cause?: unknown): ApiError {
  return new ApiError(503, "Internal", message, cause instanceof Error ? { error: cause.name } : undefined);
}

export type EvidenceArtifactStoreFactory = (scope: {
  readonly tenantId: string;
  readonly projectId: string;
}) => ArtifactStore;
