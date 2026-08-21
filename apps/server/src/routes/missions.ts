import type { FastifyInstance } from "fastify";
import type { CreateMissionBody, MissionDto } from "@qualigence/public-api";
import { authenticateOidc, projectTargets, requireIdempotencyKey, requireRole, testPlans, withTenant, type ServerDeps } from "../server-context.js";
import { commandEnvelope } from "../envelopes.js";
import { listEnvelope } from "../envelopes.js";
import { newCorrelationId, notFound, validationFailed, versionConflict } from "../errors.js";

type MissionRow = { mission_id: string; revision: number; project_id: string; plan_id: string; target_id: string; compiled_hash: string; status: string; dispatch_json: string };
type MissionBinding = { targetVersion: number; targetSnapshotHash: string; runnerId: string; planVersion: number };
function toDto(row: MissionRow): MissionDto { const binding = JSON.parse(row.dispatch_json) as MissionBinding; return { missionId: row.mission_id, projectId: row.project_id, revision: row.revision, targetId: row.target_id, targetVersion: binding.targetVersion, targetSnapshotHash: binding.targetSnapshotHash, runnerId: binding.runnerId, planId: row.plan_id, planVersion: binding.planVersion, status: row.status as MissionDto["status"], version: row.revision }; }

export function registerMissionRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post<{ Body: Partial<CreateMissionBody> }>("/v1/missions", async (request, reply) => {
    const principal = await authenticateOidc(deps, request); requireRole(deps, principal, "tester"); const missionId = requireIdempotencyKey(request); const body = request.body;
    if (typeof body.projectId !== "string" || typeof body.targetId !== "string" || typeof body.targetVersion !== "number" || typeof body.targetSnapshotHash !== "string" || typeof body.planId !== "string" || typeof body.planVersion !== "number") throw validationFailed("Mission requires approved Target and Test Plan revisions");
    const dto = await withTenant(deps, principal.tenantId, async (stores): Promise<MissionDto> => {
      const target = await projectTargets(deps, stores, principal.tenantId).getRevision(body.targetId as string, body.targetVersion as number);
      const plan = await testPlans(deps, stores, principal.tenantId).get(body.planId as string, body.planVersion as number);
      if (target === undefined || plan === undefined || plan.status !== "approved") throw notFound("approved Mission inputs not found");
      if (target.projectId !== body.projectId || plan.projectId !== body.projectId || target.snapshotHash !== body.targetSnapshotHash) throw validationFailed("Mission input provenance does not match");
      const existing = await stores.db.selectFrom("missions").selectAll().where("mission_id", "=", missionId).executeTakeFirst();
      if (existing !== undefined) {
        const binding = JSON.parse(existing.dispatch_json) as MissionBinding;
        if (existing.project_id !== body.projectId || existing.target_id !== target.targetId || existing.plan_id !== plan.planId || binding.targetVersion !== target.version || binding.targetSnapshotHash !== target.snapshotHash || binding.planVersion !== plan.version) throw versionConflict({ actualVersion: existing.revision }, "idempotency key is bound to another Mission command");
        return toDto(existing);
      }
      await stores.db.insertInto("missions").values({ tenant_id: principal.tenantId, mission_id: missionId, revision: 1, project_id: body.projectId as string, plan_id: plan.planId, prd_id: plan.prdId, prd_revision: plan.prdRevision, target_id: target.targetId, compiled_hash: target.snapshotHash, status: "approved", dispatch_json: JSON.stringify({ targetVersion: target.version, targetSnapshotHash: target.snapshotHash, runnerId: target.runnerId, planVersion: plan.version }), stop_on_blocked: 1 }).execute();
      return { missionId, projectId: target.projectId, revision: 1, targetId: target.targetId, targetVersion: target.version, targetSnapshotHash: target.snapshotHash, runnerId: target.runnerId, planId: plan.planId, planVersion: plan.version, status: "approved", version: 1 };
    });
    return reply.status(201).send(commandEnvelope(dto, dto.version, newCorrelationId()));
  });

  app.get("/v1/missions", async (request, reply) => {
    const principal = await authenticateOidc(deps, request); requireRole(deps, principal, "viewer");
    const rows = await withTenant(deps, principal.tenantId, (stores) => stores.db.selectFrom("missions").selectAll().orderBy("mission_id").execute());
    return reply.send(listEnvelope(rows.map(toDto), deps.clock.now()));
  });

  app.get<{ Params: { missionId: string } }>("/v1/missions/:missionId", async (request, reply) => {
    const principal = await authenticateOidc(deps, request); requireRole(deps, principal, "viewer");
    const row = await withTenant(deps, principal.tenantId, (stores) => stores.db.selectFrom("missions").selectAll().where("mission_id", "=", request.params.missionId).orderBy("revision", "desc").executeTakeFirst());
    if (row === undefined) throw notFound("Mission not found"); return reply.send(toDto(row));
  });
}
