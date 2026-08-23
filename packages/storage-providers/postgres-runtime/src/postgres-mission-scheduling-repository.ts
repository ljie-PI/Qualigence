import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import {
  missionStartCommandHash,
  MissionSchedulingError,
  type MissionSchedulingRepository,
  type ScheduledMission,
  type StartMissionCommand,
} from "@qualigence/mission";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import type { PostgresDatabase } from "./postgres-database.js";
import { PostgresPrdMissionRepository } from "./postgres-prd-mission-store.js";

export class PostgresMissionSchedulingRepository implements MissionSchedulingRepository {
  private writes = 0;

  constructor(
    private readonly db: Kysely<PostgresDatabase>,
    private readonly tenantId: string,
    private readonly failAfterWrite?: number,
  ) {}

  async replay(command: StartMissionCommand): Promise<ScheduledMission | undefined> {
    const row = await this.db.selectFrom("mission_start_commands").selectAll().where("tenant_id", "=", this.tenantId).where("idempotency_key", "=", command.idempotencyKey).executeTakeFirst();
    if (row === undefined) return undefined;
    assertReplay(row.command_hash, row.result_json, command, row.expected_mission_version + 1);
    return JSON.parse(row.result_json) as ScheduledMission;
  }

  async loadMission(missionId: string) {
    return new PostgresPrdMissionRepository(this.db, this.tenantId).loadMissionForScheduling(missionId);
  }

  async schedule(input: Parameters<MissionSchedulingRepository["schedule"]>[0]): Promise<ScheduledMission> {
    this.writes = 0;
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${this.tenantId}:mission-start:${input.command.idempotencyKey}`}, 0))`.execute(this.db);
    const replay = await this.db.selectFrom("mission_start_commands").selectAll().where("tenant_id", "=", this.tenantId).where("idempotency_key", "=", input.command.idempotencyKey).executeTakeFirst();
    if (replay !== undefined) {
      assertReplay(replay.command_hash, replay.result_json, input.command, replay.expected_mission_version + 1);
      return JSON.parse(replay.result_json) as ScheduledMission;
    }
    const sameMission = await this.db.selectFrom("mission_start_commands").select("expected_mission_version").where("tenant_id", "=", this.tenantId).where("mission_id", "=", input.command.missionId).executeTakeFirst();
    if (sameMission !== undefined) throw new MissionSchedulingError("MissionVersionConflict", "Mission was already started", sameMission.expected_mission_version + 1);
    const current = await this.db.selectFrom("missions").selectAll().where("tenant_id", "=", this.tenantId).where("mission_id", "=", input.command.missionId).orderBy("revision", "desc").executeTakeFirst();
    const head = await this.db.selectFrom("mission_scheduling_heads").selectAll().where("tenant_id", "=", this.tenantId).where("mission_id", "=", input.command.missionId).executeTakeFirst();
    assertCurrent(current, head, input);
    const binding = input.mission.dispatch.binding;
    const plan = await this.db.selectFrom("test_plan_version_revisions").selectAll().where("tenant_id", "=", this.tenantId).where("plan_id", "=", input.mission.planId).where("version", "=", input.mission.planVersion).executeTakeFirst();
    const planHead = await this.db.selectFrom("test_plan_heads").select("current_version").where("tenant_id", "=", this.tenantId).where("plan_id", "=", input.mission.planId).executeTakeFirst();
    assertPlan(plan, planHead?.current_version, input);
    const target = await this.db.selectFrom("target_revisions").selectAll().where("tenant_id", "=", this.tenantId).where("target_id", "=", binding?.targetId ?? "").where("version", "=", binding?.targetVersion ?? -1).executeTakeFirst();
    assertTarget(target, input);
    if (plan === undefined || target === undefined) throw new MissionSchedulingError("MissionHashConflict", "Mission provenance is unavailable");

    const jobs = input.createJobs();
    const result: ScheduledMission = { missionId: input.mission.missionId, missionRevision: input.mission.missionRevision, missionVersion: input.command.expectedVersion + 1, status: "running", runs: jobs.map(({ logicalJobId, attemptId, job }) => ({ logicalJobId, attemptId, runnerJobId: job.jobId, runId: job.runId })) };
    await this.write(this.db.updateTable("missions").set({ status: "running" }).where("tenant_id", "=", this.tenantId).where("mission_id", "=", input.command.missionId).where("revision", "=", input.mission.missionRevision).where("status", "=", "approved").where("compiled_hash", "=", input.mission.compiledHash).executeTakeFirst(), input.command.missionId);
    await this.write(this.db.updateTable("mission_scheduling_heads").set({ version: result.missionVersion }).where("tenant_id", "=", this.tenantId).where("mission_id", "=", input.command.missionId).where("mission_revision", "=", input.mission.missionRevision).where("version", "=", input.command.expectedVersion).where("compiled_hash", "=", input.mission.compiledHash).executeTakeFirst(), input.command.missionId);
    await this.write(this.db.insertInto("mission_start_commands").values({ tenant_id: this.tenantId, idempotency_key: input.command.idempotencyKey, command_hash: missionStartCommandHash(input.command), mission_id: input.command.missionId, expected_mission_version: input.command.expectedVersion, mission_revision: input.mission.missionRevision, mission_compiled_hash: input.mission.compiledHash, mission_snapshot_json: JSON.stringify(input.mission), result_json: JSON.stringify(result), created_at: input.scheduledAt }).execute());
    for (const scheduled of jobs) {
      const targetKind = binding?.configuration.kind === "desktop" ? "app" : "web";
      await this.write(this.db.insertInto("execution_runs").values({ tenant_id: this.tenantId, run_id: scheduled.job.runId, job_id: scheduled.job.jobId, target_kind: targetKind, objective: scheduled.job.objective, status: "running", next_sequence_number: 0, created_at: input.scheduledAt, completed_at: null, error_code: null }).execute());
      await this.write(this.db.insertInto("mission_job_attempts").values({ tenant_id: this.tenantId, attempt_id: scheduled.attemptId, mission_id: input.mission.missionId, mission_revision: input.mission.missionRevision, logical_job_id: scheduled.logicalJobId, runner_job_id: scheduled.job.jobId, run_id: scheduled.job.runId, status: "pending_dispatch", created_at: input.scheduledAt }).execute());
      await this.write(this.db.insertInto("runner_execution_jobs").values({ tenant_id: this.tenantId, runner_job_id: scheduled.job.jobId, attempt_id: scheduled.attemptId, runner_id: scheduled.runnerId, accepted_job_json: JSON.stringify(scheduled.job), accepted_job_hash: canonicalPayloadHash(scheduled.job), created_at: input.scheduledAt }).execute());
      await this.write(this.db.insertInto("mission_execution_provenance").values({ tenant_id: this.tenantId, ...provenanceRow(input, scheduled, plan.plan_json, targetSnapshotJson(target)) }).execute());
      await this.write(this.db.insertInto("mission_dispatch_outbox").values({ tenant_id: this.tenantId, attempt_id: scheduled.attemptId, mission_id: input.mission.missionId, runner_id: scheduled.runnerId, runner_job_id: scheduled.job.jobId, run_id: scheduled.job.runId, idempotency_key: input.command.idempotencyKey, required_capabilities_json: JSON.stringify(scheduled.requiredCapabilities), accepted_job_json: JSON.stringify(scheduled.job), status: "pending", version: 1, created_at: input.scheduledAt }).execute());
    }
    await this.write(this.db.insertInto("mission_dispatch_wakeups").values({ tenant_id: this.tenantId, wakeup_id: input.mission.missionId, generation: 1, updated_at: input.scheduledAt }).execute());
    return result;
  }

  private async write<T>(operation: Promise<T>, conflictMissionId?: string): Promise<T> {
    const result = await operation;
    if (conflictMissionId !== undefined && Number((result as { numUpdatedRows?: bigint }).numUpdatedRows ?? 0) !== 1) {
      const current = await this.db.selectFrom("mission_scheduling_heads").select("version").where("tenant_id", "=", this.tenantId).where("mission_id", "=", conflictMissionId).executeTakeFirst();
      throw new MissionSchedulingError("MissionVersionConflict", "Mission changed during scheduling", current?.version);
    }
    this.writes += 1;
    if (this.writes === this.failAfterWrite) throw new Error(`InjectedFailureAfterWrite:${this.writes}`);
    return result;
  }
}

type SchedulingInput = Parameters<MissionSchedulingRepository["schedule"]>[0];
type SchedulingJob = ReturnType<SchedulingInput["createJobs"]>[number];

function assertReplay(hash: string, resultJson: string, command: StartMissionCommand, version: number): void {
  if (hash !== missionStartCommandHash(command)) throw new MissionSchedulingError("IdempotencyConflict", "idempotency key is bound to another Mission start", version);
  JSON.parse(resultJson);
}

function assertCurrent(current: { revision: number; compiled_hash: string; status: string } | undefined, head: { mission_revision: number; version: number; compiled_hash: string } | undefined, input: SchedulingInput): void {
  if (current === undefined) throw new MissionSchedulingError("MissionNotFound", "Mission was not found");
  if (head === undefined || current.revision !== input.mission.missionRevision || head.mission_revision !== input.mission.missionRevision) throw new MissionSchedulingError("MissionRevisionConflict", "Mission revision changed", head?.version);
  if (current.compiled_hash !== input.mission.compiledHash || head.compiled_hash !== input.mission.compiledHash) throw new MissionSchedulingError("MissionHashConflict", "Mission snapshot changed", head.version);
  if (current.status !== "approved") throw new MissionSchedulingError("MissionStatusConflict", "Mission is not approved", head.version);
  if (head.version !== input.command.expectedVersion) throw new MissionSchedulingError("MissionVersionConflict", "Mission version is stale", head.version);
  const binding = input.mission.dispatch.binding;
  if (binding === undefined || binding.planVersion !== input.mission.planVersion || binding.planSnapshotHash !== input.mission.planSnapshotHash || binding.targetVersion !== input.mission.targetVersion || binding.targetSnapshotHash !== input.mission.targetSnapshotHash) throw new MissionSchedulingError("MissionHashConflict", "Mission provenance binding changed", head.version);
}

function assertPlan(plan: { status: string; plan_json: string } | undefined, currentVersion: number | undefined, input: SchedulingInput): void {
  const expectedVersion = input.mission.planVersion;
  if (plan === undefined || currentVersion !== expectedVersion) throw new MissionSchedulingError("PlanVersionConflict", "Test Plan revision is stale", currentVersion);
  if (plan.status !== "approved") throw new MissionSchedulingError("PlanStatusConflict", "Test Plan is not approved");
  if (createHash("sha256").update(plan.plan_json).digest("hex") !== input.mission.planSnapshotHash) throw new MissionSchedulingError("PlanHashConflict", "Test Plan snapshot changed");
}

function assertTarget(target: { project_id: string; runner_id: string; snapshot_hash: string } | undefined, input: SchedulingInput): void {
  const binding = input.mission.dispatch.binding;
  if (target === undefined || binding === undefined || target.project_id !== input.mission.projectId || target.runner_id !== binding.runnerId || target.snapshot_hash !== input.mission.targetSnapshotHash) throw new MissionSchedulingError("MissionHashConflict", "Target revision provenance changed");
}

function provenanceRow(input: SchedulingInput, scheduled: SchedulingJob, planSnapshotJson: string, targetSnapshotJson: string) {
  const binding = input.mission.dispatch.binding;
  if (binding === undefined) throw new MissionSchedulingError("MissionHashConflict", "Mission provenance binding is missing");
  return { attempt_id: scheduled.attemptId, project_id: input.mission.projectId, mission_id: input.mission.missionId, mission_revision: input.mission.missionRevision, mission_compiled_hash: input.mission.compiledHash, mission_snapshot_json: JSON.stringify(input.mission), logical_job_id: scheduled.logicalJobId, test_case_snapshot_json: JSON.stringify(scheduled.testCaseSnapshot), test_case_snapshot_hash: scheduled.testCaseSnapshotHash, plan_id: input.mission.planId, plan_version: input.mission.planVersion, plan_snapshot_hash: input.mission.planSnapshotHash, plan_snapshot_json: planSnapshotJson, target_id: binding.targetId, target_version: input.mission.targetVersion, target_snapshot_hash: input.mission.targetSnapshotHash, target_snapshot_json: targetSnapshotJson, runner_id: binding.runnerId, policy_json: JSON.stringify(input.mission.executionPolicy), policy_hash: canonicalPayloadHash(input.mission.executionPolicy), created_at: input.scheduledAt };
}

function targetSnapshotJson(target: { target_id: string; version: number; project_id: string; display_name: string; runner_id: string; snapshot_hash: string; configuration_json: string }): string {
  return JSON.stringify({ targetId: target.target_id, version: target.version, projectId: target.project_id, displayName: target.display_name, runnerId: target.runner_id, snapshotHash: target.snapshot_hash, configuration: JSON.parse(target.configuration_json) as unknown });
}
