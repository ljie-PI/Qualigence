import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  type AcceptedMissionDispatch,
  type BlockedMissionDispatch,
  MissionSchedulingService,
  type PrdMissionRepository,
} from "@qualigence/mission";
import {
  SqlitePrdMissionStore,
  SqliteRuntime,
} from "@qualigence/sqlite-runtime";
import {
  prdMissionRepositorySchedulingContract,
  schedulingFixture,
  type MissionSchedulingHarness,
  type MissionSchedulingStartInput,
  type SchedulingMutation,
} from "../mission/prd-mission-repository.contract.js";

prdMissionRepositorySchedulingContract("SQLite", {
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
        const database = await runtime(input.tenantId);
        const persisted = new SqlitePrdMissionStore(database, input.failAfterWrite);
        const key = `${input.tenantId ?? "local"}:${input.name}`;
        const repository = new Proxy(persisted, {
          get(target, property, receiver) {
            if (property !== "loadMissionForScheduling") return Reflect.get(target, property, receiver);
            return async (missionId: string) => {
              const snapshot = await target.loadMissionForScheduling(missionId);
              const mutation = pendingMutations.get(key);
              if (mutation !== undefined) {
                pendingMutations.delete(key);
                await applyMutation(database, input.name, mutation);
              }
              return snapshot;
            };
          },
        });
        return startWithRepository(repository, input);
      },
      async mutate(name, mutation, tenantId) {
        pendingMutations.set(`${tenantId ?? "local"}:${name}`, mutation);
      },
      async mutateBeforeStart(name, mutation, tenantId) {
        await applyMutation(await runtime(tenantId), name, mutation);
      },
      async overlap(inputs) {
        const workers = inputs.map((input) => new Worker(new URL("./mission-scheduling-worker.mjs", import.meta.url), {
          workerData: {
            filename: join(directory, `${input.tenantId ?? "local"}.db`),
            name: input.name,
            idempotencyKey: input.idempotencyKey,
            expectedVersion: input.expectedVersion ?? 1,
            allocatorSuffix: input.allocatorSuffix,
          },
        }));
        try {
          await Promise.all(workers.map(waitForLoaded));
          const results = workers.map(waitForResult);
          workers.forEach((worker) => worker.postMessage("release"));
          const [first, second] = await Promise.all(results);
          if (first === undefined || second === undefined) throw new Error("Both SQLite scheduling workers must return a result");
          return [first, second];
        } finally {
          await Promise.all(workers.map((worker) => worker.terminate()));
        }
      },
      async state(name, tenantId) {
        return readState(await runtime(tenantId), name);
      },
      async pendingDispatches(limit, tenantId) {
        return new SqlitePrdMissionStore(await runtime(tenantId)).pendingDispatches(limit);
      },
      async markDispatchAccepted(input) {
        return new SqlitePrdMissionStore(await runtime(input.tenantId), input.failAfterWrite).markDispatchAccepted(input.attemptId, input.receipt, input.expectedVersion);
      },
      async markDispatchBlocked(input) {
        return new SqlitePrdMissionStore(await runtime(input.tenantId), input.failAfterWrite).markDispatchBlocked(input.attemptId, input.expectedVersion);
      },
      async mutateLogicalJobCapabilities(name, capabilities, tenantId) {
        await (await runtime(tenantId)).db.updateTable("execution_jobs").set({ required_capabilities_json: JSON.stringify(capabilities) }).where("job_id", "=", schedulingFixture(name).logicalJobId).execute();
      },
      async overlapAccept(inputs) {
        const workers = inputs.map((input) => new Worker(new URL("./mission-scheduling-worker.mjs", import.meta.url), {
          workerData: {
            operation: "accept",
            filename: join(directory, `${input.tenantId ?? "local"}.db`),
            attemptId: input.attemptId,
            receipt: input.receipt,
            expectedVersion: input.expectedVersion,
          },
        }));
        try {
          await Promise.all(workers.map(waitForLoaded));
          const results = workers.map(waitForAcceptanceResult);
          workers.forEach((worker) => worker.postMessage("release"));
          const [first, second] = await Promise.all(results);
          if (first === undefined || second === undefined) throw new Error("Both SQLite acceptance workers must return a result");
          return [first.outcome, second.outcome];
        } finally {
          await Promise.all(workers.map((worker) => worker.terminate()));
        }
      },
      async overlapDispatchTerminals(inputs) {
        const workers = inputs.map((input) => new Worker(new URL("./mission-scheduling-worker.mjs", import.meta.url), {
          workerData: {
            operation: input.operation,
            filename: join(directory, `${input.tenantId ?? "local"}.db`),
            attemptId: input.attemptId,
            ...(input.operation === "accept" ? { receipt: input.receipt } : {}),
            expectedVersion: input.expectedVersion,
          },
        }));
        try {
          await Promise.all(workers.map(waitForLoaded));
          const results = workers.map(waitForTerminalResult);
          workers.forEach((worker) => worker.postMessage("release"));
          const [first, second] = await Promise.all(results);
          if (first === undefined || second === undefined) throw new Error("Both SQLite terminal workers must return a result");
          return [first.outcome, second.outcome];
        } finally {
          await Promise.all(workers.map((worker) => worker.terminate()));
        }
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

function startWithRepository(repository: PrdMissionRepository, input: MissionSchedulingStartInput) {
  return new MissionSchedulingService(repository, input.ids, { now: () => "2026-08-22T00:00:00.000Z" }).start({
    missionId: schedulingFixture(input.name).missionId,
    expectedVersion: input.expectedVersion ?? 1,
    idempotencyKey: input.idempotencyKey,
  });
}

function waitForLoaded(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.once("message", (message: { type?: string }) => message.type === "loaded" ? resolve() : reject(new Error(`Unexpected worker message: ${JSON.stringify(message)}`)));
    worker.once("error", reject);
  });
}

function waitForResult(worker: Worker): Promise<Awaited<ReturnType<MissionSchedulingHarness["overlap"]>>[number]> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

function waitForAcceptanceResult(worker: Worker): Promise<{ readonly outcome: PromiseSettledResult<AcceptedMissionDispatch> }> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

function waitForTerminalResult(worker: Worker): Promise<{ readonly outcome: PromiseSettledResult<AcceptedMissionDispatch | BlockedMissionDispatch> }> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

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
