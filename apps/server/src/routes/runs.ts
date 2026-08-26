import type { FastifyInstance } from "fastify";
import type { RunDto, TraceEventDto } from "@qualigence/public-api";
import { authenticateOidc, requireRole, withTenant, type ServerDeps, type TenantStores } from "../server-context.js";
import { listEnvelope } from "../envelopes.js";
import { notFound } from "../errors.js";

export function registerRunRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/v1/runs", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const items = await withTenant(deps, principal.tenantId, (stores) => listRunDtos(stores.db, principal.tenantId));
    return reply.send(listEnvelope(items, deps.clock.now()));
  });

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const run = await withTenant(deps, principal.tenantId, (stores) => getRunDto(stores.db, principal.tenantId, request.params.runId));
    if (run === undefined) throw notFound("Run not found");
    return reply.send(run);
  });

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/trace", async (request, reply) => {
    const principal = await authenticateOidc(deps, request);
    requireRole(deps, principal, "viewer");
    const events = await withTenant(deps, principal.tenantId, async (stores) => {
      const run = await stores.db
        .selectFrom("execution_runs")
        .select("run_id")
        .where("tenant_id", "=", principal.tenantId)
        .where("run_id", "=", request.params.runId)
        .executeTakeFirst();
      if (run === undefined) return undefined;
      return listTraceEventDtos(stores.db, principal.tenantId, request.params.runId);
    });
    if (events === undefined) throw notFound("Run not found");
    return reply.send(listEnvelope(events, deps.clock.now()));
  });
}

type TenantDb = TenantStores["db"];

interface RunRow {
  readonly run_id: string;
  readonly mission_id: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly completed_at: string | null;
}

async function listRunDtos(db: TenantDb, tenantId: string): Promise<readonly RunDto[]> {
  const rows = await db
    .selectFrom("execution_runs")
    .leftJoin("mission_job_attempts", (join) =>
      join
        .onRef("mission_job_attempts.tenant_id", "=", "execution_runs.tenant_id")
        .onRef("mission_job_attempts.run_id", "=", "execution_runs.run_id"),
    )
    .select([
      "execution_runs.run_id as run_id",
      "mission_job_attempts.mission_id as mission_id",
      "execution_runs.status as status",
      "execution_runs.created_at as created_at",
      "execution_runs.completed_at as completed_at",
    ])
    .where("execution_runs.tenant_id", "=", tenantId)
    .orderBy("execution_runs.created_at")
    .orderBy("execution_runs.run_id")
    .execute();
  return Promise.all(rows.map((row) => toRunDto(db, tenantId, row)));
}

async function getRunDto(db: TenantDb, tenantId: string, runId: string): Promise<RunDto | undefined> {
  const row = await db
    .selectFrom("execution_runs")
    .leftJoin("mission_job_attempts", (join) =>
      join
        .onRef("mission_job_attempts.tenant_id", "=", "execution_runs.tenant_id")
        .onRef("mission_job_attempts.run_id", "=", "execution_runs.run_id"),
    )
    .select([
      "execution_runs.run_id as run_id",
      "mission_job_attempts.mission_id as mission_id",
      "execution_runs.status as status",
      "execution_runs.created_at as created_at",
      "execution_runs.completed_at as completed_at",
    ])
    .where("execution_runs.tenant_id", "=", tenantId)
    .where("execution_runs.run_id", "=", runId)
    .executeTakeFirst();
  return row === undefined ? undefined : toRunDto(db, tenantId, row);
}

async function toRunDto(db: TenantDb, tenantId: string, row: RunRow): Promise<RunDto> {
  const [findings, artifacts] = await Promise.all([
    db
      .selectFrom("findings")
      .select("finding_id")
      .where("tenant_id", "=", tenantId)
      .where("run_id", "=", row.run_id)
      .orderBy("created_at")
      .orderBy("finding_id")
      .execute(),
    db
      .selectFrom("artifact_manifests")
      .select("artifact_id")
      .where("tenant_id", "=", tenantId)
      .where("run_id", "=", row.run_id)
      .orderBy("created_at")
      .orderBy("artifact_id")
      .execute(),
  ]);
  return {
    runId: row.run_id,
    ...(row.mission_id === null ? {} : { missionId: row.mission_id }),
    status: row.status as RunDto["status"],
    findingIds: findings.map((finding) => finding.finding_id),
    evidenceRefs: artifacts.map((artifact) => artifact.artifact_id),
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

async function listTraceEventDtos(db: TenantDb, tenantId: string, runId: string): Promise<readonly TraceEventDto[]> {
  const rows = await db
    .selectFrom("trace_events")
    .select(["run_id", "sequence_number", "stage", "occurred_at", "payload_hash"])
    .where("tenant_id", "=", tenantId)
    .where("run_id", "=", runId)
    .orderBy("sequence_number")
    .execute();
  return rows.map((row) => ({
    runId: row.run_id,
    sequenceNumber: row.sequence_number,
    stage: row.stage,
    occurredAt: row.occurred_at,
    payloadHash: row.payload_hash,
  }));
}
