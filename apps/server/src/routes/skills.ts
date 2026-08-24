import type { FastifyInstance } from "fastify";
import type { DeprecateSkillBody, PromoteSkillBody, SkillVersionDto } from "@qualigence/public-api";
import { REQUIRED_REPLAY_ORACLES, SkillError, type ProcedureSkillVersion, type SkillRepository } from "@qualigence/skill";
import { authenticateOidc, requireIdempotencyKey, requireRole, skills, withTenant, type ServerDeps } from "../server-context.js";
import { commandEnvelope, listEnvelope } from "../envelopes.js";
import { newCorrelationId, notFound, validationFailed, versionConflict } from "../errors.js";

export function registerSkillRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/v1/skills", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const items = await withTenant(deps, principal.tenantId, async (stores) => {
      const repository = skills(deps, stores, principal.tenantId);
      return Promise.all((await repository.latestVersions()).map((version) => toDto(repository, version)));
    });
    return reply.send(listEnvelope(items, deps.clock.now()));
  });

  app.get<{ Params: { skillId: string } }>("/v1/skills/:skillId", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const dto = await withTenant(deps, principal.tenantId, async (stores) => {
      const repository = skills(deps, stores, principal.tenantId);
      const version = await repository.latestVersion(request.params.skillId);
      return version === undefined ? undefined : toDto(repository, version);
    });
    if (dto === undefined) throw notFound("Skill not found");
    return reply.send(dto);
  });

  app.get<{ Params: { skillId: string } }>("/v1/skills/:skillId/versions", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const items = await withTenant(deps, principal.tenantId, async (stores) => {
      const repository = skills(deps, stores, principal.tenantId);
      const versions = await repository.versions(request.params.skillId);
      return Promise.all(versions.map((version) => toDto(repository, version)));
    });
    if (items.length === 0) throw notFound("Skill not found");
    return reply.send(listEnvelope(items, deps.clock.now()));
  });

  app.post<{ Params: { skillId: string }; Body: Partial<PromoteSkillBody> }>("/v1/skills/:skillId/promote", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "tester");
    const idempotencyKey = requireIdempotencyKey(request);
    const expectedVersion = expectedVersionFrom(request.body);
    const dto = await withTenant(deps, principal.tenantId, async (stores) => {
      const repository = skills(deps, stores, principal.tenantId);
      try {
        const version = await repository.applyLifecycleCommand({
          operation: "promote",
          skillId: request.params.skillId,
          expectedVersion,
          idempotencyKey,
          requiredOracles: REQUIRED_REPLAY_ORACLES,
          actor: { actorId: principal.subject, tenantId: principal.tenantId, roles: principal.roles },
          occurredAt: deps.clock.now(),
        });
        return toDto(repository, version);
      } catch (error) {
        return rethrowSkillError(error, expectedVersion);
      }
    });
    return reply.send(commandEnvelope(dto, dto.version, newCorrelationId()));
  });

  app.post<{ Params: { skillId: string }; Body: Partial<DeprecateSkillBody> }>("/v1/skills/:skillId/deprecate", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "tester");
    const idempotencyKey = requireIdempotencyKey(request);
    const expectedVersion = expectedVersionFrom(request.body);
    if (typeof request.body.reason !== "string" || request.body.reason.trim().length === 0) {
      throw validationFailed("reason is required");
    }
    const dto = await withTenant(deps, principal.tenantId, async (stores) => {
      const repository = skills(deps, stores, principal.tenantId);
      try {
        const version = await repository.applyLifecycleCommand({
          operation: "deprecate",
          skillId: request.params.skillId,
          expectedVersion,
          idempotencyKey,
          reason: request.body.reason as string,
          actor: { actorId: principal.subject, tenantId: principal.tenantId, roles: principal.roles },
          occurredAt: deps.clock.now(),
        });
        return toDto(repository, version);
      } catch (error) {
        return rethrowSkillError(error, expectedVersion);
      }
    });
    return reply.send(commandEnvelope(dto, dto.version, newCorrelationId()));
  });
}

async function toDto(repository: SkillRepository, version: ProcedureSkillVersion): Promise<SkillVersionDto> {
  const signedVersion = await signedEvaluatedVersion(repository, version);
  const latestEvaluation = signedVersion === undefined ? undefined : (await repository.evaluations(version.skillId, signedVersion.version)).at(-1);
  const bundle = signedVersion === undefined ? undefined : await repository.bundle(version.skillId, signedVersion.version);
  const revoked = await repository.isRevoked(version.skillId, version.version);
  return {
    skillId: version.skillId,
    version: version.version,
    state: version.state,
    contentSha256: version.contentSha256,
    signatureStatus: revoked ? "revoked" : signedVersion !== undefined && bundleMatchesVersion(bundle, signedVersion) && latestEvaluation?.signatureValid === true ? "valid" : "invalid",
    evaluationStatus: latestEvaluation === undefined ? "pending" : latestEvaluation.outcome,
  };
}

async function signedEvaluatedVersion(repository: SkillRepository, version: ProcedureSkillVersion): Promise<ProcedureSkillVersion | undefined> {
  const lineage = await repository.versions(version.skillId);
  for (const candidate of [...lineage].reverse()) {
    if (candidate.version > version.version || candidate.contentSha256 !== version.contentSha256) continue;
    const evaluation = (await repository.evaluations(candidate.skillId, candidate.version)).at(-1);
    const bundle = await repository.bundle(candidate.skillId, candidate.version);
    if (evaluation?.signatureValid === true && bundleMatchesVersion(bundle, candidate)) return candidate;
  }
  return undefined;
}

function expectedVersionFrom(body: Partial<PromoteSkillBody>): number {
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    throw validationFailed("expectedVersion is required");
  }
  return body.expectedVersion;
}

function rethrowSkillError(error: unknown, expectedVersion: number): never {
  if (!(error instanceof SkillError)) throw error;
  if (error.code === "SkillNotFound") throw notFound("Skill not found");
  if (error.code === "SkillVersionConflict" || error.code === "SkillIdempotencyConflict" || error.code === "SkillAlreadyDeprecated" || error.code === "SkillStateReversal" || error.code === "SkillNotVerified") {
    throw versionConflict({ expectedVersion, ...error.details }, error.code === "SkillIdempotencyConflict" ? "idempotency key is bound to another Skill lifecycle command" : error.code);
  }
  throw validationFailed(error.code);
}

function bundleMatchesVersion(bundle: Awaited<ReturnType<SkillRepository["bundle"]>>, version: ProcedureSkillVersion): boolean {
  return bundle !== undefined &&
    bundle.manifest.skillId === version.skillId &&
    bundle.manifest.skillVersion === version.version &&
    bundle.manifest.contentSha256 === version.contentSha256 &&
    bundle.payload.skillId === version.skillId &&
    bundle.payload.version === version.version &&
    bundle.payload.contentSha256 === version.contentSha256;
}
