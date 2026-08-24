import type { FastifyInstance } from "fastify";
import type { DeprecateSkillBody, PromoteSkillBody, SkillVersionDto } from "@qualigence/public-api";
import { REQUIRED_REPLAY_ORACLES, SkillError, SkillLifecycleService, type SkillVersionView } from "@qualigence/skill";
import { authenticateOidc, requireIdempotencyKey, requireRole, skills, withTenant, type ServerDeps } from "../server-context.js";
import { commandEnvelope, listEnvelope } from "../envelopes.js";
import { ApiError, newCorrelationId, notFound, validationFailed, versionConflict } from "../errors.js";

export function registerSkillRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/v1/skills", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const items = await withTenant(deps, principal.tenantId, async (stores) => {
      const repository = skills(deps, stores, principal.tenantId);
      return Promise.all((await new SkillLifecycleService({ repository, signer: deps.skillSigner }).latestViews()).map(toDto));
    });
    return reply.send(listEnvelope(items, deps.clock.now()));
  });

  app.get<{ Params: { skillId: string } }>("/v1/skills/:skillId", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const dto = await withTenant(deps, principal.tenantId, async (stores) => {
      const repository = skills(deps, stores, principal.tenantId);
      const version = await repository.latestVersion(request.params.skillId);
      return version === undefined ? undefined : toDto(await new SkillLifecycleService({ repository, signer: deps.skillSigner }).versionView(version));
    });
    if (dto === undefined) throw notFound("Skill not found");
    return reply.send(dto);
  });

  app.get<{ Params: { skillId: string } }>("/v1/skills/:skillId/versions", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const items = await withTenant(deps, principal.tenantId, async (stores) => {
      const repository = skills(deps, stores, principal.tenantId);
      return Promise.all((await new SkillLifecycleService({ repository, signer: deps.skillSigner }).versionViews(request.params.skillId)).map(toDto));
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
        const service = new SkillLifecycleService({ repository, signer: deps.skillSigner });
        const version = await service.promote({
          operation: "promote",
          skillId: request.params.skillId,
          expectedVersion,
          idempotencyKey,
          requiredOracles: REQUIRED_REPLAY_ORACLES,
          actor: { actorId: principal.subject, tenantId: principal.tenantId, roles: principal.roles },
          occurredAt: deps.clock.now(),
        });
        return toDto(await service.versionView(version));
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
        const service = new SkillLifecycleService({ repository, signer: deps.skillSigner });
        const version = await service.deprecate({
          operation: "deprecate",
          skillId: request.params.skillId,
          expectedVersion,
          idempotencyKey,
          reason: request.body.reason as string,
          actor: { actorId: principal.subject, tenantId: principal.tenantId, roles: principal.roles },
          occurredAt: deps.clock.now(),
        });
        return toDto(await service.versionView(version));
      } catch (error) {
        return rethrowSkillError(error, expectedVersion);
      }
    });
    return reply.send(commandEnvelope(dto, dto.version, newCorrelationId()));
  });
}

function toDto(view: SkillVersionView): SkillVersionDto {
  return {
    skillId: view.skillId,
    version: view.version,
    state: view.state,
    contentSha256: view.contentSha256,
    signatureStatus: view.signatureStatus,
    evaluationStatus: view.evaluationStatus,
  };
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
  if (error.code === "SkillIdempotencyConflict") {
    throw new ApiError(409, "IdempotencyConflict", "idempotency key is bound to another Skill lifecycle command", { expectedVersion, ...error.details });
  }
  if (error.code === "SkillVersionConflict" || error.code === "SkillAlreadyDeprecated" || error.code === "SkillStateReversal" || error.code === "SkillNotVerified") {
    throw versionConflict({ expectedVersion, ...error.details }, error.code);
  }
  throw validationFailed(error.code);
}
