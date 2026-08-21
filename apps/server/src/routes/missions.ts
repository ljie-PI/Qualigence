import type { FastifyInstance } from "fastify";
import type { CreateMissionBody, MissionDto } from "@qualigence/public-api";
import { MissionIntakeError, type MissionIntakeResult } from "@qualigence/mission";
import { authenticateOidc, missionIntakeService, requireIdempotencyKey, requireRole, withTenant, type ServerDeps } from "../server-context.js";
import { commandEnvelope, listEnvelope } from "../envelopes.js";
import { newCorrelationId, notFound, validationFailed, versionConflict } from "../errors.js";

function toDto(mission: MissionIntakeResult): MissionDto { return { ...mission, version: mission.revision }; }

export function registerMissionRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post<{ Body: Partial<CreateMissionBody> }>("/v1/missions", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "tester");
    const idempotencyKey = requireIdempotencyKey(request);
    const body = request.body;
    if (typeof body.projectId !== "string" || typeof body.targetId !== "string" || typeof body.targetVersion !== "number" || typeof body.targetSnapshotHash !== "string" || typeof body.planId !== "string" || typeof body.planVersion !== "number") throw validationFailed("Mission requires approved Target and Test Plan revisions");
    const command = { projectId: body.projectId, targetId: body.targetId, targetVersion: body.targetVersion, targetSnapshotHash: body.targetSnapshotHash, planId: body.planId, planVersion: body.planVersion, idempotencyKey };
    try {
      const mission = await withTenant(deps, principal.tenantId, (stores) => missionIntakeService(deps, stores, principal.tenantId).create(command));
      return reply.status(201).send(commandEnvelope(toDto(mission), mission.revision, newCorrelationId()));
    } catch (error) {
      if (error instanceof MissionIntakeError && error.code === "MissionInputNotFound") throw notFound("approved Mission inputs not found");
      if (error instanceof MissionIntakeError && error.code === "MissionIdempotencyConflict") throw versionConflict({}, "idempotency key is bound to another Mission command");
      if (error instanceof MissionIntakeError) throw validationFailed(error.code);
      throw error;
    }
  });
  app.get("/v1/missions", async (request, reply) => {
    const principal = await authenticateOidc(deps, request); requireRole(deps, principal, "viewer");
    const rows = await withTenant(deps, principal.tenantId, (stores) => missionIntakeService(deps, stores, principal.tenantId).list());
    return reply.send(listEnvelope(rows.map(toDto), deps.clock.now()));
  });
  app.get<{ Params: { missionId: string } }>("/v1/missions/:missionId", async (request, reply) => {
    const principal = await authenticateOidc(deps, request); requireRole(deps, principal, "viewer");
    const mission = await withTenant(deps, principal.tenantId, (stores) => missionIntakeService(deps, stores, principal.tenantId).get(request.params.missionId));
    if (mission === undefined) throw notFound("Mission not found");
    return reply.send(toDto(mission));
  });
}
