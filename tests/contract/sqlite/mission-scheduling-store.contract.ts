import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MissionSchedulingService,
  type MissionSchedulingRepository,
} from "@qualigence/mission";
import {
  SqliteMissionSchedulingRepository,
  SqliteRuntime,
} from "@qualigence/sqlite-runtime";
import {
  missionSchedulingRepositoryContract,
  schedulingFixture,
  type MissionSchedulingHarness,
  type SchedulingMutation,
} from "../mission/mission-scheduling-repository.contract.js";

missionSchedulingRepositoryContract("SQLite", {
  async createHarness(): Promise<MissionSchedulingHarness> {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-mission-scheduling-"));
    const runtimes = new Map<string, SqliteRuntime>();
    const pendingMutations = new Map<string, SchedulingMutation>();

    async function runtime(tenantId = "local"): Promise<SqliteRuntime> {
      const existing = runtimes.get(tenantId);
      if (existing !== undefined) return existing;
      const opened = await SqliteRuntime.open({ filename: join(directory, `${tenantId}.db`), busyTimeoutMs: 5_000 });
      runtimes.set(tenantId, opened);
      return opened;
    }

    return {
      async seed(name, tenantId) {
        await seed(await runtime(tenantId), name);
      },
      async start(input) {
        const primary = await runtime(input.tenantId);
        const concurrent = await SqliteRuntime.open({ filename: join(directory, `${input.tenantId ?? "local"}.db`), busyTimeoutMs: 5_000 });
        const database = primary;
        const persisted = new SqliteMissionSchedulingRepository(database, input.failAfterWrite);
        const key = `${input.tenantId ?? "local"}:${input.name}`;
        const repository: MissionSchedulingRepository = {
          replay: (command) => persisted.replay(command),
          async loadMission(missionId) {
            const snapshot = await persisted.loadMission(missionId);
            const mutation = pendingMutations.get(key);
            if (mutation !== undefined) {
              pendingMutations.delete(key);
              await applyMutation(database, input.name, mutation);
            }
            return snapshot;
          },
          schedule: (scheduleInput) => persisted.schedule(scheduleInput),
        };
        try {
          return await new MissionSchedulingService(repository, input.ids, { now: () => "2026-08-22T00:00:00.000Z" }).start({ missionId: schedulingFixture(input.name).missionId, expectedVersion: input.expectedVersion ?? 1, idempotencyKey: input.idempotencyKey });
        } catch (error) {
          // If the shared primary is already inside BEGIN IMMEDIATE, retry this
          // caller on its own connection so SQLite exercises true two-writer serialization.
          if (error instanceof Error && error.message.includes("within a transaction")) {
            const retryStore = new SqliteMissionSchedulingRepository(concurrent, input.failAfterWrite);
            return await new MissionSchedulingService(retryStore, input.ids, { now: () => "2026-08-22T00:00:00.000Z" }).start({ missionId: schedulingFixture(input.name).missionId, expectedVersion: input.expectedVersion ?? 1, idempotencyKey: input.idempotencyKey });
          }
          throw error;
        } finally {
          await concurrent.close();
        }
      },
      async mutate(name, mutation, tenantId) {
        pendingMutations.set(`${tenantId ?? "local"}:${name}`, mutation);
      },
      async state(name, tenantId) {
        return readState(await runtime(tenantId), name);
      },
      async restart() {
        const entries = [...runtimes.entries()];
        await Promise.all(entries.map(([, opened]) => opened.close()));
        runtimes.clear();
        for (const [tenantId] of entries) await runtime(tenantId);
      },
      async close() {
        await Promise.all([...runtimes.values()].map((opened) => opened.close()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  },
});

async function seed(runtime: SqliteRuntime, name: string): Promise<void> {
  const fixture = schedulingFixture(name);
  const plan = JSON.parse(fixture.planJson) as { projectId: string; prdId: string; prdRevision: number };
  const compiled = JSON.parse(fixture.compiledJson) as { projectId: string; targetId: string; executionPolicy: unknown };
  const dispatch = JSON.parse(fixture.dispatchJson) as { binding: { runnerId: string; configuration: { kind: string } } };
  await runtime.db.insertInto("project_targets").values({ target_id: fixture.targetId, project_id: compiled.projectId, current_version: 1, created_at: "2026-08-22T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z" }).execute();
  await runtime.db.insertInto("target_revisions").values({ target_id: fixture.targetId, version: 1, project_id: compiled.projectId, display_name: "Target", runner_id: dispatch.binding.runnerId, kind: dispatch.binding.configuration.kind, snapshot_hash: `target-hash-${name}`, configuration_json: JSON.stringify(dispatch.binding.configuration), idempotency_key: `target-${name}`, created_at: "2026-08-22T00:00:00.000Z" }).execute();
  await runtime.db.insertInto("test_plan_heads").values({ plan_id: fixture.planId, project_id: plan.projectId, current_version: 2, created_at: "2026-08-22T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z" }).execute();
  await runtime.db.insertInto("test_plan_version_revisions").values({ plan_id: fixture.planId, version: 2, project_id: plan.projectId, prd_id: plan.prdId, prd_revision: plan.prdRevision, status: "approved", reviewer_id: "reviewer-1", approved_at: "2026-08-22T00:00:00.000Z", idempotency_key: `approve-${name}`, plan_json: fixture.planJson, created_at: "2026-08-22T00:00:00.000Z" }).execute();
  await runtime.db.insertInto("missions").values({ mission_id: fixture.missionId, revision: 1, project_id: compiled.projectId, plan_id: fixture.planId, prd_id: plan.prdId, prd_revision: plan.prdRevision, target_id: fixture.targetId, compiled_hash: fixture.compiledHash, status: "approved", dispatch_json: fixture.dispatchJson, stop_on_blocked: 1 }).execute();
  await runtime.db.insertInto("mission_scheduling_heads").values({ mission_id: fixture.missionId, mission_revision: 1, version: 1, compiled_hash: fixture.compiledHash }).execute();
  await runtime.db.insertInto("mission_revisions").values({ mission_id: fixture.missionId, revision: 1, compiled_json: fixture.compiledJson, created_at: "2026-08-22T00:00:00.000Z" }).execute();
  const snapshot = JSON.parse(fixture.jobSnapshotJson) as { id: string; objective: string };
  await runtime.db.insertInto("execution_jobs").values({ job_id: fixture.logicalJobId, mission_id: fixture.missionId, mission_revision: 1, test_case_id: snapshot.id, objective: snapshot.objective, required_capabilities_json: fixture.requiredCapabilitiesJson, source_refs_json: fixture.sourceRefsJson, snapshot_hash: fixture.jobSnapshotHash, snapshot_json: fixture.jobSnapshotJson, idempotency_key: `logical-${name}`, status: "queued" }).execute();
}

async function applyMutation(runtime: SqliteRuntime, name: string, mutation: SchedulingMutation): Promise<void> {
  const fixture = schedulingFixture(name);
  switch (mutation) {
    case "mission_revision": {
      const current = await runtime.db.selectFrom("missions").selectAll().where("mission_id", "=", fixture.missionId).executeTakeFirstOrThrow();
      await runtime.db.insertInto("missions").values({ ...current, revision: 2 }).execute();
      await runtime.db.updateTable("mission_scheduling_heads").set({ mission_revision: 2 }).where("mission_id", "=", fixture.missionId).execute();
      return;
    }
    case "mission_hash": await runtime.db.updateTable("missions").set({ compiled_hash: "stale" }).where("mission_id", "=", fixture.missionId).execute(); return;
    case "mission_status": await runtime.db.updateTable("missions").set({ status: "blocked" }).where("mission_id", "=", fixture.missionId).execute(); return;
    case "mission_version": await runtime.db.updateTable("mission_scheduling_heads").set({ version: 2 }).where("mission_id", "=", fixture.missionId).execute(); return;
    case "plan_version": await runtime.db.updateTable("test_plan_heads").set({ current_version: 3 }).where("plan_id", "=", fixture.planId).execute(); return;
    case "plan_hash": await runtime.db.updateTable("test_plan_version_revisions").set({ plan_json: "{}" }).where("plan_id", "=", fixture.planId).where("version", "=", 2).execute(); return;
    case "plan_status": await runtime.db.updateTable("test_plan_version_revisions").set({ status: "draft" }).where("plan_id", "=", fixture.planId).where("version", "=", 2).execute(); return;
  }
}

async function readState(runtime: SqliteRuntime, name: string) {
  const fixture = schedulingFixture(name);
  const mission = await runtime.db.selectFrom("missions").select("status").where("mission_id", "=", fixture.missionId).executeTakeFirstOrThrow();
  const head = await runtime.db.selectFrom("mission_scheduling_heads").select("version").where("mission_id", "=", fixture.missionId).executeTakeFirstOrThrow();
  const commands = await runtime.db.selectFrom("mission_start_commands").select("idempotency_key").where("mission_id", "=", fixture.missionId).execute();
  const attempts = await runtime.db.selectFrom("mission_job_attempts").select(["attempt_id", "run_id"]).where("mission_id", "=", fixture.missionId).execute();
  const attemptIds = attempts.map((row) => row.attempt_id);
  const runs = await Promise.all(attempts.map((row) => runtime.db.selectFrom("execution_runs").select("run_id").where("run_id", "=", row.run_id).executeTakeFirst()));
  const runnerJobs = await rowsForAttempts(runtime, "runner_execution_jobs", attemptIds);
  const provenance = await rowsForAttempts(runtime, "mission_execution_provenance", attemptIds);
  const outbox = await runtime.db.selectFrom("mission_dispatch_outbox").selectAll().where("mission_id", "=", fixture.missionId).execute();
  const wakeups = await runtime.db.selectFrom("mission_dispatch_wakeups").select("wakeup_id").where("wakeup_id", "=", fixture.missionId).execute();
  const acceptedJob = outbox[0] === undefined ? undefined : JSON.parse(outbox[0].accepted_job_json) as unknown;
  const provenanceRecord = provenance[0] as Readonly<Record<string, unknown>> | undefined;
  return { missionStatus: mission.status, missionVersion: head.version, commands: commands.length, runs: runs.filter(Boolean).length, attempts: attempts.length, runnerJobs: runnerJobs.length, provenance: provenance.length, outbox: outbox.length, wakeups: wakeups.length, ...(acceptedJob === undefined ? {} : { acceptedJob }), ...(provenanceRecord === undefined ? {} : { provenanceRecord }) };
}

async function rowsForAttempts(runtime: SqliteRuntime, table: "runner_execution_jobs" | "mission_execution_provenance", attemptIds: readonly string[]) {
  if (attemptIds.length === 0) return [];
  return runtime.db.selectFrom(table).selectAll().where("attempt_id", "in", attemptIds).execute();
}
