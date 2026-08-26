import type { FastifyInstance } from "fastify";
import type { ArtifactMetadataDto } from "@qualigence/public-api";
import { EvidenceAccessService, EvidenceLifecycleError, EvidenceLifecycleService } from "@qualigence/evidence";
import type { ArtifactKind, ArtifactManifest, ArtifactStore } from "@qualigence/evidence";
import {
  authenticateOidc,
  requireRole,
  withTenant,
  type ServerDeps,
  type TenantStores,
} from "../server-context.js";
import { ApiError, notFound, validationFailed } from "../errors.js";

const EVIDENCE_PURPOSE: "investigation" = "investigation";

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
    const access = await authorizeEvidenceAccess(deps, principal.tenantId, {
      capsuleId: manifest.artifactId,
      actorId: principal.subject,
      correlationId: request.id,
      operation: "metadata",
    });
    return reply.send(toMetadataDto(manifest, access.downloadAllowed));
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
    await authorizeEvidenceAccess(deps, principal.tenantId, {
      capsuleId: manifest.artifactId,
      actorId: principal.subject,
      correlationId: request.id,
      operation: "bytes",
    });
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

  app.delete<{
    Params: { projectId: string; runId: string; artifactId: string };
    Querystring: { purpose?: string };
  }>("/v1/projects/:projectId/runs/:runId/artifacts/:artifactId", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "admin");
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
    const result = await deleteEvidence(deps, principal.tenantId, {
      capsuleId: manifest.artifactId,
      actorId: principal.subject,
      correlationId: request.id,
    });
    return reply.status(202).send({ artifactId: manifest.artifactId, lifecycleState: result.state });
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

function toMetadataDto(manifest: ArtifactManifest, downloadAllowed: boolean): ArtifactMetadataDto {
  return {
    artifactId: manifest.artifactId,
    runId: manifest.runId,
    kind: manifest.kind,
    mediaType: manifest.mediaType,
    size: manifest.size,
    sha256: manifest.sha256,
    downloadAllowed,
  };
}

async function authorizeEvidenceAccess(
  deps: ServerDeps,
  tenantId: string,
  input: {
    readonly capsuleId: string;
    readonly actorId: string;
    readonly correlationId: string;
    readonly operation: "metadata" | "bytes";
  },
): Promise<{ readonly downloadAllowed: boolean }> {
  if (deps.evidenceLifecycleStore === undefined || deps.evidenceKeyPolicy === undefined) {
    throw evidenceUnavailable("Evidence lifecycle/KMS is not configured");
  }
  const outcome = await withTenant(deps, tenantId, async (stores) => {
    const service = new EvidenceAccessService(
      deps.evidenceLifecycleStore!(stores, tenantId),
      deps.evidenceKeyPolicy!,
    );
    const request = {
      capsuleId: input.capsuleId,
      tenantId,
      purpose: EVIDENCE_PURPOSE,
      actor: evidenceActor(input.actorId, input.correlationId),
      occurredAt: deps.clock.now(),
    };
    try {
      return {
        ok: true as const,
        value: input.operation === "metadata"
          ? await service.authorizeMetadata(request)
          : await service.authorizePlaintext(request),
      };
    } catch (cause) {
      return { ok: false as const, cause };
    }
  });
  if (outcome.ok) return outcome.value;
  const cause = outcome.cause;
  if (cause instanceof EvidenceLifecycleError && cause.code === "EvidenceCapsuleNotFound") {
    throw notFound("Evidence artifact not found");
  }
  if (cause instanceof EvidenceLifecycleError && cause.code === "EvidenceAccessDenied") {
    throw notFound("Evidence artifact not found");
  }
  throw evidenceUnavailable("Evidence access is unavailable", cause);
}

async function deleteEvidence(
  deps: ServerDeps,
  tenantId: string,
  input: {
    readonly capsuleId: string;
    readonly actorId: string;
    readonly correlationId: string;
  },
): Promise<{ readonly state: string }> {
  if (deps.evidenceLifecycleStore === undefined || deps.evidenceKeyPolicy === undefined) {
    throw evidenceUnavailable("Evidence lifecycle/KMS is not configured");
  }
  const outcome = await withTenant(deps, tenantId, async (stores) => {
    try {
      return {
        ok: true as const,
        value: await new EvidenceLifecycleService(
          deps.evidenceLifecycleStore!(stores, tenantId),
          deps.evidenceKeyPolicy!,
        ).deleteEvidence({
          capsuleId: input.capsuleId,
          reason: "public_api_delete",
          actor: evidenceActor(input.actorId, input.correlationId),
          occurredAt: deps.clock.now(),
        }),
      };
    } catch (cause) {
      return { ok: false as const, cause };
    }
  });
  if (outcome.ok) return outcome.value;
  const cause = outcome.cause;
  if (cause instanceof EvidenceLifecycleError && cause.code === "EvidenceCapsuleNotFound") {
    throw notFound("Evidence artifact not found");
  }
  throw evidenceUnavailable("Evidence lifecycle command failed", cause);
}

function evidenceActor(actorId: string, correlationId: string) {
  return {
    actorType: "user" as const,
    actorId,
    correlationId,
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
