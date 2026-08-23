import { afterAll, beforeAll, describe, expect } from "vitest";
import { Client } from "pg";
import {
  MissionSchedulingService,
  type MissionSchedulingRepository,
  type ScheduledMission,
} from "@qualigence/mission";
import {
  createPostgresRuntime,
  PostgresMissionSchedulingRepository,
  provisionPostgres,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable, startPostgres, type StartedPostgres } from "../../helpers/docker-container.js";
import {
  missionSchedulingRepositoryContract,
  schedulingFixture,
  type MissionSchedulingHarness,
  type MissionSchedulingOverlapResult,
  type MissionSchedulingStartInput,
  type SchedulingMutation,
} from "../mission/mission-scheduling-repository.contract.js";

if (!dockerAvailable()) throw new Error("DockerUnavailable: PostgreSQL Mission scheduling contract requires Docker.");

describe("PostgreSQL Mission scheduling provider", () => {
  let container: StartedPostgres;
  let provider: TenantTransactionProvider;
  let serverConfig: Parameters<typeof createPostgresRuntime>[0];

  beforeAll(async () => {
    container = await startPostgres();
    const admin = { host: container.host, port: container.port, database: container.database, user: container.superuser, password: container.password };
    await provisionPostgres({ admin, roles: { server: { name: "mission_server", password: "server_pw" }, worker: { name: "mission_worker", password: "worker_pw" } } });
    serverConfig = { ...admin, user: "mission_server", password: "server_pw", max: 8 };
    provider = createPostgresRuntime(serverConfig);
  }, 180_000);

  afterAll(async () => {
    await provider?.close();
    await container?.stop();
  });

  missionSchedulingRepositoryContract("PostgreSQL", {
    async createHarness(): Promise<MissionSchedulingHarness> {
      const pendingMutations = new Map<string, SchedulingMutation>();
      const start = (input: MissionSchedulingStartInput, afterLoad?: () => Promise<void>) => provider.withTenant(input.tenantId ?? "tenant-a", async ({ db }) => {
        const tenantId = input.tenantId ?? "tenant-a";
        const persisted = new PostgresMissionSchedulingRepository(db, tenantId, input.failAfterWrite);
        const key = `${tenantId}:${input.name}`;
        const repository: MissionSchedulingRepository = {
          replay: (command) => persisted.replay(command),
          async loadMission(missionId) {
            const snapshot = await persisted.loadMission(missionId);
            const mutation = pendingMutations.get(key);
            if (mutation !== undefined) {
              pendingMutations.delete(key);
              await applyMutation(db, tenantId, input.name, mutation);
            }
            await afterLoad?.();
            return snapshot;
          },
          schedule: (scheduleInput) => persisted.schedule(scheduleInput),
        };
        return startWithRepository(repository, input);
      });
      return {
        seed: (name, tenantId = "tenant-a") => provider.withTenant(tenantId, ({ db }) => seed(db, tenantId, name)),
        start,
        async mutate(name, mutation, tenantId = "tenant-a") { pendingMutations.set(`${tenantId}:${name}`, mutation); },
        mutateBeforeStart: (name, mutation, tenantId = "tenant-a") => provider.withTenant(tenantId, ({ db }) => applyMutation(db, tenantId, name, mutation)),
        async overlap(inputs) {
          const blocker = new Client({ host: container.host, port: container.port, database: container.database, user: container.superuser, password: container.password });
          const lockId = 742_004;
          const loaded = inputs.map(() => deferred<void>());
          const release = deferred<void>();
          const counters = inputs.map(({ allocatorSuffix }) => countingIds(allocatorSuffix));
          const operations: Promise<PromiseSettledResult<ScheduledMission>>[] = [];
          await blocker.connect();
          try {
            await installMissionUpdateBarrier(blocker, lockId);
            operations.push(...inputs.map((input, index) => settle(start({ ...input, ids: counters[index]!.ids }, async () => {
              loaded[index]!.resolve();
              await release.promise;
            }))));
            await Promise.all(loaded.map(({ promise }) => promise));
            release.resolve();
            const waits = await waitForConcurrentMissionWriters(blocker, 2);
            expect(waits).toEqual(expect.arrayContaining(["advisory"]));
            await blocker.query("select pg_advisory_unlock($1)", [lockId]);
            const outcomes = await Promise.all(operations);
            return outcomes.map((outcome, index): MissionSchedulingOverlapResult => ({ outcome, allocations: counters[index]!.count() })) as [MissionSchedulingOverlapResult, MissionSchedulingOverlapResult];
          } finally {
            release.resolve();
            await blocker.query("select pg_advisory_unlock_all()").catch(() => undefined);
            await Promise.allSettled(operations);
            await blocker.query("drop trigger if exists block_mission_start_update on missions").catch(() => undefined);
            await blocker.query("drop function if exists block_mission_start_update()").catch(() => undefined);
            await blocker.end();
          }
        },
        state: (name, tenantId = "tenant-a") => provider.withTenant(tenantId, ({ db }) => readState(db, tenantId, name)),
        async restart() {
          await provider.close();
          provider = createPostgresRuntime(serverConfig);
        },
        async close() {},
      };
    },
  });
});

function startWithRepository(repository: MissionSchedulingRepository, input: MissionSchedulingStartInput) {
  return new MissionSchedulingService(repository, input.ids, { now: () => "2026-08-22T00:00:00.000Z" }).start({
    missionId: schedulingFixture(input.name).missionId,
    expectedVersion: input.expectedVersion ?? 1,
    idempotencyKey: input.idempotencyKey,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try { return { status: "fulfilled", value: await promise }; }
  catch (reason) { return { status: "rejected", reason }; }
}

function countingIds(suffix: string) {
  let count = 0;
  return {
    ids: {
      allocateAttemptId: () => `attempt-${suffix}-${++count}`,
      allocateRunnerJobId: () => `runner-job-${suffix}-${++count}`,
      allocateRunId: () => `run-${suffix}-${++count}`,
    },
    count: () => count,
  };
}

async function installMissionUpdateBarrier(client: Client, lockId: number): Promise<void> {
  await client.query("drop trigger if exists block_mission_start_update on missions");
  await client.query(`
    create or replace function block_mission_start_update()
    returns trigger as $$
    begin
      perform pg_advisory_xact_lock(${lockId});
      return new;
    end;
    $$ language plpgsql
  `);
  await client.query(`
    create trigger block_mission_start_update
    before update on missions
    for each row execute function block_mission_start_update()
  `);
  await client.query("select pg_advisory_lock($1)", [lockId]);
}

async function waitForConcurrentMissionWriters(client: Client, expected: number): Promise<readonly string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query<{ wait_event: string }>(`
      select wait_event
      from pg_stat_activity
      where usename = 'mission_server'
        and wait_event_type = 'Lock'
    `);
    if (result.rows.length >= expected) return result.rows.map(({ wait_event }) => wait_event);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} concurrent Mission writers`);
}

type Db = Parameters<Parameters<TenantTransactionProvider["withTenant"]>[1]>[0]["db"];

async function seed(db: Db, tenantId: string, name: string): Promise<void> {
  const fixture = schedulingFixture(name);
  const plan = JSON.parse(fixture.planJson) as { projectId: string; prdId: string; prdRevision: number };
  const compiled = JSON.parse(fixture.compiledJson) as { projectId: string; targetId: string };
  const dispatch = JSON.parse(fixture.dispatchJson) as { binding: { runnerId: string; configuration: { kind: string } } };
  await db.insertInto("project_targets").values({ tenant_id: tenantId, target_id: fixture.targetId, project_id: compiled.projectId, current_version: 1, created_at: "2026-08-22T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z" }).execute();
  await db.insertInto("target_revisions").values({ tenant_id: tenantId, target_id: fixture.targetId, version: 1, project_id: compiled.projectId, display_name: "Target", runner_id: dispatch.binding.runnerId, kind: dispatch.binding.configuration.kind, snapshot_hash: `target-hash-${name}`, configuration_json: JSON.stringify(dispatch.binding.configuration), idempotency_key: `target-${name}`, created_at: "2026-08-22T00:00:00.000Z" }).execute();
  await db.insertInto("test_plan_heads").values({ tenant_id: tenantId, plan_id: fixture.planId, project_id: plan.projectId, current_version: 2, created_at: "2026-08-22T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z" }).execute();
  await db.insertInto("test_plan_version_revisions").values({ tenant_id: tenantId, plan_id: fixture.planId, version: 2, project_id: plan.projectId, prd_id: plan.prdId, prd_revision: plan.prdRevision, status: "approved", reviewer_id: "reviewer-1", approved_at: "2026-08-22T00:00:00.000Z", idempotency_key: `approve-${name}`, plan_json: fixture.planJson, created_at: "2026-08-22T00:00:00.000Z" }).execute();
  await db.insertInto("missions").values({ tenant_id: tenantId, mission_id: fixture.missionId, revision: 1, project_id: compiled.projectId, plan_id: fixture.planId, prd_id: plan.prdId, prd_revision: plan.prdRevision, target_id: fixture.targetId, compiled_hash: fixture.compiledHash, status: "approved", dispatch_json: fixture.dispatchJson, stop_on_blocked: 1 }).execute();
  await db.insertInto("mission_scheduling_heads").values({ tenant_id: tenantId, mission_id: fixture.missionId, mission_revision: 1, version: 1, compiled_hash: fixture.compiledHash }).execute();
  await db.insertInto("mission_revisions").values({ tenant_id: tenantId, mission_id: fixture.missionId, revision: 1, compiled_json: fixture.compiledJson, created_at: "2026-08-22T00:00:00.000Z" }).execute();
  const snapshot = JSON.parse(fixture.jobSnapshotJson) as { id: string; objective: string };
  await db.insertInto("execution_jobs").values({ tenant_id: tenantId, job_id: fixture.logicalJobId, mission_id: fixture.missionId, mission_revision: 1, test_case_id: snapshot.id, objective: snapshot.objective, required_capabilities_json: fixture.requiredCapabilitiesJson, source_refs_json: fixture.sourceRefsJson, snapshot_hash: fixture.jobSnapshotHash, snapshot_json: fixture.jobSnapshotJson, idempotency_key: `logical-${name}`, status: "queued" }).execute();
}

async function applyMutation(db: Db, tenantId: string, name: string, mutation: SchedulingMutation): Promise<void> {
  const fixture = schedulingFixture(name);
  switch (mutation) {
    case "mission_revision": {
      const current = await db.selectFrom("missions").selectAll().where("tenant_id", "=", tenantId).where("mission_id", "=", fixture.missionId).executeTakeFirstOrThrow();
      await db.insertInto("missions").values({ ...current, revision: 2 }).execute();
      await db.updateTable("mission_scheduling_heads").set({ mission_revision: 2 }).where("tenant_id", "=", tenantId).where("mission_id", "=", fixture.missionId).execute();
      return;
    }
    case "mission_hash": await db.updateTable("missions").set({ compiled_hash: "stale" }).where("tenant_id", "=", tenantId).where("mission_id", "=", fixture.missionId).execute(); return;
    case "mission_status": await db.updateTable("missions").set({ status: "blocked" }).where("tenant_id", "=", tenantId).where("mission_id", "=", fixture.missionId).execute(); return;
    case "mission_version": await db.updateTable("mission_scheduling_heads").set({ version: 2 }).where("tenant_id", "=", tenantId).where("mission_id", "=", fixture.missionId).execute(); return;
    case "plan_version": await db.updateTable("test_plan_heads").set({ current_version: 3 }).where("tenant_id", "=", tenantId).where("plan_id", "=", fixture.planId).execute(); return;
    case "plan_hash": await db.updateTable("test_plan_version_revisions").set({ plan_json: "{}" }).where("tenant_id", "=", tenantId).where("plan_id", "=", fixture.planId).where("version", "=", 2).execute(); return;
    case "plan_status": await db.updateTable("test_plan_version_revisions").set({ status: "draft" }).where("tenant_id", "=", tenantId).where("plan_id", "=", fixture.planId).where("version", "=", 2).execute(); return;
  }
}

async function readState(db: Db, tenantId: string, name: string) {
  const fixture = schedulingFixture(name);
  const mission = await db.selectFrom("missions").select("status").where("tenant_id", "=", tenantId).where("mission_id", "=", fixture.missionId).executeTakeFirstOrThrow();
  const head = await db.selectFrom("mission_scheduling_heads").select("version").where("tenant_id", "=", tenantId).where("mission_id", "=", fixture.missionId).executeTakeFirstOrThrow();
  const commands = await db.selectFrom("mission_start_commands").select("idempotency_key").where("tenant_id", "=", tenantId).where("mission_id", "=", fixture.missionId).execute();
  const attempts = await db.selectFrom("mission_job_attempts").select(["attempt_id", "run_id"]).where("tenant_id", "=", tenantId).where("mission_id", "=", fixture.missionId).execute();
  const attemptIds = attempts.map((row) => row.attempt_id);
  const runs = await Promise.all(attempts.map((row) => db.selectFrom("execution_runs").select("run_id").where("tenant_id", "=", tenantId).where("run_id", "=", row.run_id).executeTakeFirst()));
  const runnerJobs = attemptIds.length === 0 ? [] : await db.selectFrom("runner_execution_jobs").selectAll().where("tenant_id", "=", tenantId).where("attempt_id", "in", attemptIds).execute();
  const provenance = attemptIds.length === 0 ? [] : await db.selectFrom("mission_execution_provenance").selectAll().where("tenant_id", "=", tenantId).where("attempt_id", "in", attemptIds).execute();
  const outbox = await db.selectFrom("mission_dispatch_outbox").selectAll().where("tenant_id", "=", tenantId).where("mission_id", "=", fixture.missionId).execute();
  const wakeups = await db.selectFrom("mission_dispatch_wakeups").select("wakeup_id").where("tenant_id", "=", tenantId).where("wakeup_id", "=", fixture.missionId).execute();
  const acceptedJob = outbox[0] === undefined ? undefined : JSON.parse(outbox[0].accepted_job_json) as unknown;
  const provenanceRecord = provenance[0] as Readonly<Record<string, unknown>> | undefined;
  return { missionStatus: mission.status, missionVersion: head.version, commands: commands.length, runs: runs.filter(Boolean).length, attempts: attempts.length, runnerJobs: runnerJobs.length, provenance: provenance.length, outbox: outbox.length, wakeups: wakeups.length, ...(acceptedJob === undefined ? {} : { acceptedJob }), ...(provenanceRecord === undefined ? {} : { provenanceRecord }) };
}
