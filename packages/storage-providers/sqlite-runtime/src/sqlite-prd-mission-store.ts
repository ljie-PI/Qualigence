import { createHash } from "node:crypto";
import type { PrdDocument, PrdSourceRef } from "@qualigence/context-intake";
import { canonicalPayloadHash, parseExecutionJob } from "@qualigence/runner-protocol";
import type {
  AcceptedMissionDispatch,
  AcceptedMissionExecutionJob,
  DispatchableJob,
  DispatchableMission,
  ExecutionJobStatus,
  JobAttemptRecord,
  MissionDispatchAcceptanceReceipt,
  MissionDispatchDescriptor,
  MissionExecutionRecord,
  MissionJobExecution,
  MissionSchedulingSnapshot,
  MissionStatus,
  PendingMissionDispatch,
  PrdMissionRepository,
  SaveCompiledMissionInput,
  ScheduleMissionInput,
  ScheduledMission,
  StartMissionCommand,
  TestCase,
  TestPlanRevision,
} from "@qualigence/mission";
import { missionStartCommandHash, MissionSchedulingError } from "@qualigence/mission";
import type { SqliteRuntime } from "./database.js";
import type { CompiledMission } from "@qualigence/mission";
import { runInImmediateTransaction } from "./transaction.js";

/**
 * SQLite-backed implementation of the LS-07 {@link PrdMissionRepository}. It
 * persists immutable PRD/plan/mission snapshots into the migration-002 tables and
 * records execution attempts. It never runs a model or a browser; grounding and
 * approval are already enforced by the domain layer before anything is stored.
 */
export class SqlitePrdMissionStore implements PrdMissionRepository {
  private writes = 0;

  constructor(
    private readonly runtime: SqliteRuntime,
    private readonly failAfterWrite?: number,
  ) {}

  async savePrdDocument(document: PrdDocument): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .insertInto("prd_documents")
        .values({
          prd_id: document.prdId,
          revision: document.revision,
          project_id: document.projectId,
          title: document.title,
          content: document.content,
          content_sha256: document.contentSha256,
          ingested_at: document.ingestedAt,
        })
        .onConflict((oc) => oc.columns(["prd_id", "revision"]).doNothing())
        .execute();
    });
  }

  async saveTestPlanRevision(plan: TestPlanRevision): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      const db = this.runtime.db;
      await db
        .insertInto("test_plan_revisions")
        .values({
          plan_id: plan.planId,
          project_id: plan.projectId,
          prd_id: plan.prdId,
          prd_revision: plan.prdRevision,
          version: plan.version,
          status: plan.status,
          reviewer_id: plan.approval?.reviewerId ?? null,
          approved_at: plan.approval?.approvedAt ?? null,
          idempotency_key: plan.approval?.idempotencyKey ?? null,
          plan_json: JSON.stringify(plan),
          created_at: plan.approval?.approvedAt ?? new Date(0).toISOString(),
        })
        .onConflict((oc) => oc.column("plan_id").doNothing())
        .execute();

      for (const claim of plan.expectedClaims) {
        await db
          .insertInto("expected_claims")
          .values({
            claim_id: claim.claimId,
            plan_id: plan.planId,
            semantic_key: claim.semanticKey,
            statement: claim.statement,
            confidence: claim.confidence,
            source_refs_json: JSON.stringify(claim.sourceRefs),
          })
          .onConflict((oc) => oc.column("claim_id").doNothing())
          .execute();
      }

      for (const testCase of plan.testCases) {
        await db
          .insertInto("test_cases")
          .values({
            test_case_id: testCase.id,
            plan_id: plan.planId,
            title: testCase.title,
            objective: testCase.objective,
            priority: testCase.priority,
            source_refs_json: JSON.stringify(testCase.sourceRefs),
            snapshot_json: JSON.stringify(testCase),
          })
          .onConflict((oc) => oc.column("test_case_id").doNothing())
          .execute();
      }
    });
  }

  async saveCompiledMission(input: SaveCompiledMissionInput): Promise<DispatchableMission> {
    const { mission } = input;
    assertMissionProvenance(input);
    await runInImmediateTransaction(this.runtime, async () => {
      const db = this.runtime.db;
      const inserted = await db
        .insertInto("missions")
        .values({
          mission_id: mission.missionId,
          revision: mission.missionRevision,
          project_id: input.projectId,
          plan_id: input.planId,
          prd_id: input.prdId,
          prd_revision: input.prdRevision,
          target_id: mission.targetId,
          compiled_hash: mission.compiledHash,
          status: "approved",
          dispatch_json: JSON.stringify(input.dispatch),
          stop_on_blocked: input.stopOnBlockedTestCase ? 1 : 0,
        })
        .onConflict((oc) => oc.columns(["mission_id", "revision"]).doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows) !== 1) return;

      await db
        .insertInto("mission_revisions")
        .values({
          mission_id: mission.missionId,
          revision: mission.missionRevision,
          compiled_json: JSON.stringify(mission),
          created_at: new Date(0).toISOString(),
        })
        .onConflict((oc) => oc.columns(["mission_id", "revision"]).doNothing())
        .execute();

      await db.insertInto("mission_scheduling_heads").values({ mission_id: mission.missionId, mission_revision: mission.missionRevision, version: 1, compiled_hash: mission.compiledHash }).onConflict((oc) => oc.column("mission_id").doNothing()).execute();

      for (const job of mission.jobs) {
        await db
          .insertInto("execution_jobs")
          .values({
            job_id: job.jobId,
            mission_id: job.missionId,
            mission_revision: job.missionRevision,
            test_case_id: job.testCaseId,
            objective: job.testCaseSnapshot.objective,
            required_capabilities_json: JSON.stringify(job.requiredCapabilities),
            source_refs_json: JSON.stringify(job.testCaseSnapshot.sourceRefs),
            snapshot_hash: job.snapshotHash,
            snapshot_json: JSON.stringify(job.testCaseSnapshot),
            idempotency_key: job.idempotencyKey,
            status: job.status,
          })
          .onConflict((oc) => oc.column("job_id").doNothing())
          .execute();
      }
    });
    const persisted = await this.loadMissionForDispatch(mission.missionId);
    if (persisted === undefined) throw new Error(`Compiled Mission ${mission.missionId} was not persisted.`);
    return persisted;
  }

  async loadMissionForDispatch(
    missionId: string,
  ): Promise<DispatchableMission | undefined> {
    const db = this.runtime.db;
    const mission = await db
      .selectFrom("missions")
      .selectAll()
      .where("mission_id", "=", missionId)
      .orderBy("revision", "desc")
      .executeTakeFirst();
    if (!mission) {
      return undefined;
    }

    const jobRows = await db
      .selectFrom("execution_jobs")
      .selectAll()
      .where("mission_id", "=", missionId)
      .where("mission_revision", "=", mission.revision)
      .orderBy("job_id", "asc")
      .execute();

    const compiled = await db
      .selectFrom("mission_revisions")
      .select("compiled_json")
      .where("mission_id", "=", mission.mission_id)
      .where("revision", "=", mission.revision)
      .executeTakeFirst();
    if (compiled === undefined) {
      throw new Error(`Missing immutable compiled Mission ${mission.mission_id}@${mission.revision}.`);
    }
    const compiledMission = JSON.parse(compiled.compiled_json) as CompiledMission;
    const jobs: DispatchableJob[] = jobRows.map((row) => ({
      jobId: row.job_id,
      testCaseId: row.test_case_id,
      objective: row.objective,
      requiredCapabilities: JSON.parse(row.required_capabilities_json) as string[],
      status: row.status as ExecutionJobStatus,
      sourceRefs: JSON.parse(row.source_refs_json) as PrdSourceRef[],
      snapshot: JSON.parse(row.snapshot_json) as TestCase,
    }));

    const schedulingHead = await db.selectFrom("mission_scheduling_heads").select("version").where("mission_id", "=", missionId).executeTakeFirst();
    return {
      missionId: mission.mission_id,
      missionRevision: mission.revision,
      missionVersion: schedulingHead?.version ?? 1,
      projectId: mission.project_id,
      planId: mission.plan_id,
      prdId: mission.prd_id,
      prdRevision: mission.prd_revision,
      status: mission.status as MissionStatus,
      dispatch: JSON.parse(mission.dispatch_json) as MissionDispatchDescriptor,
      executionPolicy: compiledMission.executionPolicy,
      stopOnBlockedTestCase: mission.stop_on_blocked === 1,
      jobs,
    };
  }

  async loadMissionForScheduling(missionId: string): Promise<MissionSchedulingSnapshot | undefined> {
    const mission = await this.runtime.db.selectFrom("missions").selectAll().where("mission_id", "=", missionId).orderBy("revision", "desc").executeTakeFirst();
    if (mission === undefined) return undefined;
    const compiledRow = await this.runtime.db.selectFrom("mission_revisions").select("compiled_json").where("mission_id", "=", missionId).where("revision", "=", mission.revision).executeTakeFirstOrThrow();
    const compiled = JSON.parse(compiledRow.compiled_json) as CompiledMission;
    const jobs = await this.runtime.db.selectFrom("execution_jobs").selectAll().where("mission_id", "=", missionId).where("mission_revision", "=", mission.revision).orderBy("job_id").execute();
    const schedulingHead = await this.runtime.db.selectFrom("mission_scheduling_heads").select("version").where("mission_id", "=", missionId).executeTakeFirst();
    return {
      missionId,
      missionRevision: mission.revision,
      missionVersion: schedulingHead?.version ?? 1,
      compiledHash: mission.compiled_hash,
      projectId: mission.project_id,
      planId: mission.plan_id,
      planVersion: compiled.planVersion,
      planSnapshotHash: compiled.planSnapshotHash,
      prdId: mission.prd_id,
      prdRevision: mission.prd_revision,
      targetVersion: compiled.targetVersion,
      targetSnapshotHash: compiled.targetSnapshotHash,
      status: mission.status as MissionStatus,
      dispatch: JSON.parse(mission.dispatch_json) as MissionDispatchDescriptor,
      executionPolicy: compiled.executionPolicy,
      stopOnBlockedTestCase: mission.stop_on_blocked === 1,
      jobs: jobs.map((job) => {
        const compiledJob = compiled.jobs.find((candidate) => candidate.jobId === job.job_id);
        if (compiledJob === undefined) throw new Error(`Missing compiled Job ${job.job_id}.`);
        return { jobId: job.job_id, testCaseId: job.test_case_id, objective: job.objective, requiredCapabilities: JSON.parse(job.required_capabilities_json) as string[], status: job.status as ExecutionJobStatus, sourceRefs: JSON.parse(job.source_refs_json) as PrdSourceRef[], snapshotHash: job.snapshot_hash, snapshot: JSON.parse(job.snapshot_json) as TestCase, budget: compiledJob.budget };
      }),
    };
  }

  async replayMissionSchedule(command: StartMissionCommand): Promise<ScheduledMission | undefined> {
    const row = await this.runtime.db.selectFrom("mission_start_commands").selectAll().where("idempotency_key", "=", command.idempotencyKey).executeTakeFirst();
    if (row === undefined) return undefined;
    assertReplay(row.command_hash, row.result_json, command, row.expected_mission_version + 1);
    return JSON.parse(row.result_json) as ScheduledMission;
  }

  async scheduleMission(input: ScheduleMissionInput): Promise<ScheduledMission> {
    this.writes = 0;
    return runInImmediateTransaction(this.runtime, async () => {
      const db = this.runtime.db;
      const replay = await db.selectFrom("mission_start_commands").selectAll().where("idempotency_key", "=", input.command.idempotencyKey).executeTakeFirst();
      if (replay !== undefined) {
        assertReplay(replay.command_hash, replay.result_json, input.command, replay.expected_mission_version + 1);
        return JSON.parse(replay.result_json) as ScheduledMission;
      }
      const sameMission = await db.selectFrom("mission_start_commands").select("expected_mission_version").where("mission_id", "=", input.command.missionId).executeTakeFirst();
      if (sameMission !== undefined) throw new MissionSchedulingError("MissionVersionConflict", "Mission was already started", sameMission.expected_mission_version + 1);
      const current = await loadCurrentMission(db, input.command.missionId);
      const head = await db.selectFrom("mission_scheduling_heads").selectAll().where("mission_id", "=", input.command.missionId).executeTakeFirst();
      assertCurrent(current, head, input);
      const plan = await db.selectFrom("test_plan_version_revisions").selectAll().where("plan_id", "=", input.mission.planId).where("version", "=", input.mission.planVersion).executeTakeFirst();
      const planHead = await db.selectFrom("test_plan_heads").select("current_version").where("plan_id", "=", input.mission.planId).executeTakeFirst();
      assertPlan(plan, planHead?.current_version, input);
      const target = await db.selectFrom("target_revisions").selectAll().where("target_id", "=", input.mission.dispatch.binding?.targetId ?? "").where("version", "=", input.mission.dispatch.binding?.targetVersion ?? -1).executeTakeFirst();
      assertTarget(target, input);
      if (plan === undefined || target === undefined) throw new MissionSchedulingError("MissionHashConflict", "Mission provenance is unavailable");

      const jobs = input.createJobs();
      const result: ScheduledMission = { missionId: input.mission.missionId, missionRevision: input.mission.missionRevision, missionVersion: input.command.expectedVersion + 1, status: "running", runs: jobs.map(({ logicalJobId, attemptId, job }) => ({ logicalJobId, attemptId, runnerJobId: job.jobId, runId: job.runId })) };
      await this.write(db.updateTable("missions").set({ status: "running" }).where("mission_id", "=", input.command.missionId).where("revision", "=", input.mission.missionRevision).where("status", "=", "approved").where("compiled_hash", "=", input.mission.compiledHash).executeTakeFirst(), input.command.missionId);
      await this.write(db.updateTable("mission_scheduling_heads").set({ version: result.missionVersion }).where("mission_id", "=", input.command.missionId).where("mission_revision", "=", input.mission.missionRevision).where("version", "=", input.command.expectedVersion).where("compiled_hash", "=", input.mission.compiledHash).executeTakeFirst(), input.command.missionId);
      await this.write(db.insertInto("mission_start_commands").values({ idempotency_key: input.command.idempotencyKey, command_hash: missionStartCommandHash(input.command), mission_id: input.command.missionId, expected_mission_version: input.command.expectedVersion, mission_revision: input.mission.missionRevision, mission_compiled_hash: input.mission.compiledHash, mission_snapshot_json: JSON.stringify(input.mission), result_json: JSON.stringify(result), created_at: input.scheduledAt }).execute());
      for (const scheduled of jobs) {
        const targetKind = input.mission.dispatch.binding?.configuration.kind === "desktop" ? "app" : "web";
        await this.write(db.insertInto("execution_runs").values({ run_id: scheduled.job.runId, job_id: scheduled.job.jobId, target_kind: targetKind, objective: scheduled.job.objective, status: "running", next_sequence_number: 0, created_at: input.scheduledAt, completed_at: null, error_code: null }).execute());
        await this.write(db.insertInto("mission_job_attempts").values({ attempt_id: scheduled.attemptId, mission_id: input.mission.missionId, mission_revision: input.mission.missionRevision, logical_job_id: scheduled.logicalJobId, runner_job_id: scheduled.job.jobId, run_id: scheduled.job.runId, status: "pending_dispatch", created_at: input.scheduledAt }).execute());
        await this.write(db.insertInto("runner_execution_jobs").values({ runner_job_id: scheduled.job.jobId, attempt_id: scheduled.attemptId, runner_id: scheduled.runnerId, accepted_job_json: JSON.stringify(scheduled.job), accepted_job_hash: canonicalPayloadHash(scheduled.job), created_at: input.scheduledAt }).execute());
        await this.write(db.insertInto("mission_execution_provenance").values(provenanceRow(input, scheduled, plan.plan_json, targetSnapshotJson(target))).execute());
        await this.write(db.insertInto("mission_dispatch_outbox").values({ attempt_id: scheduled.attemptId, mission_id: input.mission.missionId, runner_id: scheduled.runnerId, runner_job_id: scheduled.job.jobId, run_id: scheduled.job.runId, idempotency_key: input.command.idempotencyKey, required_capabilities_json: JSON.stringify(scheduled.requiredCapabilities), accepted_job_json: JSON.stringify(scheduled.job), status: "pending", version: 1, accepted_at: null, acceptance_receipt_json: null, created_at: input.scheduledAt }).execute());
      }
      await this.write(db.insertInto("mission_dispatch_wakeups").values({ wakeup_id: input.mission.missionId, generation: 1, updated_at: input.scheduledAt }).execute());
      return result;
    });
  }

  async pendingDispatches(limit: number): Promise<readonly PendingMissionDispatch[]> {
    boundedDispatchLimit(limit);
    const rows = await this.runtime.db.selectFrom("mission_dispatch_outbox").selectAll()
      .where("status", "=", "pending").orderBy("status").orderBy("created_at").orderBy("attempt_id").limit(limit).execute();
    return rows.map(pendingDispatch);
  }

  async markDispatchAccepted(attemptId: string, receiptInput: MissionDispatchAcceptanceReceipt, expectedVersion: number): Promise<AcceptedMissionDispatch> {
    const receipt = acceptanceReceipt(receiptInput);
    return runInImmediateTransaction(this.runtime, async () => {
      const current = await this.runtime.db.selectFrom("mission_dispatch_outbox").selectAll().where("attempt_id", "=", attemptId).executeTakeFirst();
      if (current === undefined) throw new MissionSchedulingError("MissionDispatchNotFound", "Mission dispatch was not found");
      assertReceiptIdentity(current, receipt);
      const replay = acceptedDispatchReplay(current, receipt, expectedVersion);
      if (replay !== undefined) return replay;
      if (current.status !== "pending" || current.version !== expectedVersion) throw new MissionSchedulingError("MissionDispatchVersionConflict", "Mission dispatch version is stale", current.version);

      const receiptJson = JSON.stringify(receipt);
      const updated = await this.runtime.db.updateTable("mission_dispatch_outbox").set({ status: "accepted", version: expectedVersion + 1, accepted_at: receipt.acceptedAt, acceptance_receipt_json: receiptJson })
        .where("attempt_id", "=", attemptId).where("status", "=", "pending").where("version", "=", expectedVersion).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        const winner = await this.runtime.db.selectFrom("mission_dispatch_outbox").selectAll().where("attempt_id", "=", attemptId).executeTakeFirstOrThrow();
        const winnerReplay = acceptedDispatchReplay(winner, receipt, expectedVersion);
        if (winnerReplay !== undefined) return winnerReplay;
        throw new MissionSchedulingError("MissionDispatchVersionConflict", "Mission dispatch version is stale", winner.version);
      }
      const attempt = await this.runtime.db.updateTable("mission_job_attempts").set({ status: "accepted" }).where("attempt_id", "=", attemptId).where("status", "=", "pending_dispatch").executeTakeFirst();
      if (Number(attempt.numUpdatedRows) !== 1) throw new MissionSchedulingError("MissionDispatchReceiptConflict", "Mission attempt cannot be accepted", expectedVersion + 1);
      return acceptedDispatch({ ...current, status: "accepted", version: expectedVersion + 1, accepted_at: receipt.acceptedAt, acceptance_receipt_json: receiptJson }, receipt);
    });
  }

  private async write<T>(operation: Promise<T>, conflictMissionId?: string): Promise<T> {
    const result = await operation;
    if (conflictMissionId !== undefined && affected(result) !== 1) {
      const current = await this.runtime.db.selectFrom("mission_scheduling_heads").select("version").where("mission_id", "=", conflictMissionId).executeTakeFirst();
      throw new MissionSchedulingError("MissionVersionConflict", "Mission changed during scheduling", current?.version);
    }
    this.writes += 1;
    if (this.writes === this.failAfterWrite) throw new Error(`InjectedFailureAfterWrite:${this.writes}`);
    return result;
  }

  async listMissionIds(): Promise<readonly string[]> {
    const rows = await this.runtime.db.selectFrom("missions").select("mission_id").distinct().orderBy("mission_id").execute();
    return rows.map((row) => row.mission_id);
  }

  async recordJobAttempt(attempt: JobAttemptRecord): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .insertInto("execution_job_attempts")
        .values({
          attempt_id: attempt.attemptId,
          job_id: attempt.jobId,
          mission_id: attempt.missionId,
          run_id: attempt.runId,
          status: attempt.status,
          error_code: attempt.errorCode ?? null,
          created_at: attempt.createdAt,
        })
        .onConflict((oc) => oc.column("attempt_id").doNothing())
        .execute();
    });
  }

  async setJobStatus(
    jobId: string,
    status: ExecutionJobStatus,
  ): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .updateTable("execution_jobs")
        .set({ status })
        .where("job_id", "=", jobId)
        .execute();
    });
  }

  async setMissionStatus(
    missionId: string,
    missionRevision: number,
    status: MissionStatus,
  ): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .updateTable("missions")
        .set({ status })
        .where("mission_id", "=", missionId)
        .where("revision", "=", missionRevision)
        .execute();
    });
  }

  async loadMissionExecution(
    missionId: string,
  ): Promise<MissionExecutionRecord | undefined> {
    const db = this.runtime.db;
    const mission = await db
      .selectFrom("missions")
      .selectAll()
      .where("mission_id", "=", missionId)
      .orderBy("revision", "desc")
      .executeTakeFirst();
    if (!mission) {
      return undefined;
    }

    const jobRows = await db
      .selectFrom("execution_jobs")
      .selectAll()
      .where("mission_id", "=", missionId)
      .where("mission_revision", "=", mission.revision)
      .orderBy("job_id", "asc")
      .execute();

    const attemptRows = await db
      .selectFrom("execution_job_attempts")
      .selectAll()
      .where("mission_id", "=", missionId)
      .orderBy("created_at", "asc")
      .execute();

    const jobs: MissionJobExecution[] = jobRows.map((row) => {
      const attempts: JobAttemptRecord[] = attemptRows
        .filter((attempt) => attempt.job_id === row.job_id)
        .map((attempt) => ({
          attemptId: attempt.attempt_id,
          jobId: attempt.job_id,
          missionId: attempt.mission_id,
          runId: attempt.run_id,
          status: attempt.status as JobAttemptRecord["status"],
          ...(attempt.error_code === null
            ? {}
            : { errorCode: attempt.error_code }),
          createdAt: attempt.created_at,
        }));
      return {
        jobId: row.job_id,
        testCaseId: row.test_case_id,
        status: row.status as ExecutionJobStatus,
        sourceRefs: JSON.parse(row.source_refs_json) as PrdSourceRef[],
        attempts,
      };
    });

    return {
      missionId: mission.mission_id,
      missionRevision: mission.revision,
      projectId: mission.project_id,
      planId: mission.plan_id,
      prdId: mission.prd_id,
      prdRevision: mission.prd_revision,
      status: mission.status as MissionStatus,
      jobs,
    };
  }
}

type SchedulingJob = ReturnType<ScheduleMissionInput["createJobs"]>[number];

function affected(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const rows = (value as { numUpdatedRows?: bigint | number }).numUpdatedRows;
  return Number(rows ?? 0);
}

function assertReplay(hash: string, resultJson: string, command: StartMissionCommand, version: number): void {
  if (hash !== missionStartCommandHash(command)) throw new MissionSchedulingError("IdempotencyConflict", "idempotency key is bound to another Mission start", version);
  JSON.parse(resultJson);
}

async function loadCurrentMission(db: SqliteRuntime["db"], missionId: string) {
  return db.selectFrom("missions").selectAll().where("mission_id", "=", missionId).orderBy("revision", "desc").executeTakeFirst();
}

function assertCurrent(current: Awaited<ReturnType<typeof loadCurrentMission>>, head: { mission_revision: number; version: number; compiled_hash: string } | undefined, input: ScheduleMissionInput): void {
  if (current === undefined) throw new MissionSchedulingError("MissionNotFound", "Mission was not found");
  if (head === undefined || current.revision !== input.mission.missionRevision || head.mission_revision !== input.mission.missionRevision) throw new MissionSchedulingError("MissionRevisionConflict", "Mission revision changed", head?.version);
  if (current.compiled_hash !== input.mission.compiledHash || head.compiled_hash !== input.mission.compiledHash) throw new MissionSchedulingError("MissionHashConflict", "Mission snapshot changed", head.version);
  if (current.status !== "approved") throw new MissionSchedulingError("MissionStatusConflict", "Mission is not approved", head.version);
  if (head.version !== input.command.expectedVersion) throw new MissionSchedulingError("MissionVersionConflict", "Mission version is stale", head.version);
  const binding = input.mission.dispatch.binding;
  if (binding === undefined || binding.planVersion !== input.mission.planVersion || binding.planSnapshotHash !== input.mission.planSnapshotHash || binding.targetVersion !== input.mission.targetVersion || binding.targetSnapshotHash !== input.mission.targetSnapshotHash) throw new MissionSchedulingError("MissionHashConflict", "Mission provenance binding changed", head.version);
}

function assertPlan(plan: { status: string; plan_json: string } | undefined, currentVersion: number | undefined, input: ScheduleMissionInput): void {
  const expectedVersion = input.mission.planVersion;
  if (plan === undefined || currentVersion !== expectedVersion) throw new MissionSchedulingError("PlanVersionConflict", "Test Plan revision is stale", currentVersion);
  if (plan.status !== "approved") throw new MissionSchedulingError("PlanStatusConflict", "Test Plan is not approved");
  if (createHash("sha256").update(plan.plan_json).digest("hex") !== input.mission.planSnapshotHash) throw new MissionSchedulingError("PlanHashConflict", "Test Plan snapshot changed");
}

function assertTarget(target: { project_id: string; runner_id: string; snapshot_hash: string } | undefined, input: ScheduleMissionInput): void {
  const binding = input.mission.dispatch.binding;
  if (target === undefined || binding === undefined || target.project_id !== input.mission.projectId || target.runner_id !== binding.runnerId || target.snapshot_hash !== input.mission.targetSnapshotHash) throw new MissionSchedulingError("MissionHashConflict", "Target revision provenance changed");
}

function provenanceRow(input: ScheduleMissionInput, scheduled: SchedulingJob, planSnapshotJson: string, targetSnapshotJson: string) {
  const binding = input.mission.dispatch.binding;
  if (binding === undefined) throw new MissionSchedulingError("MissionHashConflict", "Mission provenance binding is missing");
  return { attempt_id: scheduled.attemptId, project_id: input.mission.projectId, mission_id: input.mission.missionId, mission_revision: input.mission.missionRevision, mission_compiled_hash: input.mission.compiledHash, mission_snapshot_json: JSON.stringify(input.mission), logical_job_id: scheduled.logicalJobId, test_case_snapshot_json: JSON.stringify(scheduled.testCaseSnapshot), test_case_snapshot_hash: scheduled.testCaseSnapshotHash, plan_id: input.mission.planId, plan_version: input.mission.planVersion, plan_snapshot_hash: input.mission.planSnapshotHash, plan_snapshot_json: planSnapshotJson, target_id: binding.targetId, target_version: input.mission.targetVersion, target_snapshot_hash: input.mission.targetSnapshotHash, target_snapshot_json: targetSnapshotJson, runner_id: binding.runnerId, policy_json: JSON.stringify(input.mission.executionPolicy), policy_hash: canonicalPayloadHash(input.mission.executionPolicy), created_at: input.scheduledAt };
}

function targetSnapshotJson(target: { target_id: string; version: number; project_id: string; display_name: string; runner_id: string; snapshot_hash: string; configuration_json: string }): string {
  return JSON.stringify({ targetId: target.target_id, version: target.version, projectId: target.project_id, displayName: target.display_name, runnerId: target.runner_id, snapshotHash: target.snapshot_hash, configuration: JSON.parse(target.configuration_json) as unknown });
}

interface MissionDispatchRow {
  readonly attempt_id: string;
  readonly mission_id: string;
  readonly runner_id: string;
  readonly runner_job_id: string;
  readonly run_id: string;
  readonly required_capabilities_json: string;
  readonly accepted_job_json: string;
  readonly status: string;
  readonly version: number;
  readonly accepted_at: string | null;
  readonly acceptance_receipt_json: string | null;
  readonly created_at: string;
}

function pendingDispatch(row: MissionDispatchRow): PendingMissionDispatch {
  return { ...dispatchBase(row), status: "pending", version: row.version, createdAt: row.created_at };
}

function acceptedDispatch(row: MissionDispatchRow, receipt: MissionDispatchAcceptanceReceipt): AcceptedMissionDispatch {
  if (row.accepted_at === null) throw new MissionSchedulingError("MissionDispatchReceiptConflict", "Accepted Mission dispatch has no acceptance time", row.version);
  return { ...dispatchBase(row), status: "accepted", version: row.version, acceptedAt: row.accepted_at, receipt, createdAt: row.created_at };
}

function dispatchBase(row: MissionDispatchRow) {
  const requiredCapabilities = JSON.parse(row.required_capabilities_json) as unknown;
  if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((value) => typeof value !== "string" || value.length === 0)) throw new Error("Invalid persisted Mission dispatch capabilities.");
  const job = parseExecutionJob(JSON.parse(row.accepted_job_json));
  if (job.plan === undefined) throw new Error("Persisted Mission dispatch Job has no Plan snapshot.");
  if (job.plan.steps.some((step) => step.kind === "select" || step.kind === "scroll")) throw new Error("Persisted Mission dispatch Job contains an unsupported Plan step.");
  return { attemptId: row.attempt_id, missionId: row.mission_id, runnerId: row.runner_id, runnerJobId: row.runner_job_id, runId: row.run_id, requiredCapabilities, job: job as AcceptedMissionExecutionJob };
}

function acceptanceReceipt(value: MissionDispatchAcceptanceReceipt): MissionDispatchAcceptanceReceipt {
  if (Object.keys(value).sort().join(",") !== "acceptedAt,jobId,runId,status" || (value.status !== "accepted" && value.status !== "already_active") || value.jobId.trim().length === 0 || value.runId.trim().length === 0 || !canonicalInstant(value.acceptedAt)) throw new Error("Invalid Mission dispatch acceptance receipt.");
  return { status: value.status, jobId: value.jobId, runId: value.runId, acceptedAt: value.acceptedAt };
}

function assertReceiptIdentity(row: MissionDispatchRow, receipt: MissionDispatchAcceptanceReceipt): void {
  if (row.runner_job_id !== receipt.jobId || row.run_id !== receipt.runId) throw new MissionSchedulingError("MissionDispatchReceiptConflict", "Mission dispatch receipt identity does not match", row.version);
}

function acceptedDispatchReplay(row: MissionDispatchRow, receipt: MissionDispatchAcceptanceReceipt, expectedVersion: number): AcceptedMissionDispatch | undefined {
  if (row.status !== "accepted") return undefined;
  if (row.version !== expectedVersion + 1 || row.acceptance_receipt_json !== JSON.stringify(receipt)) throw new MissionSchedulingError("MissionDispatchReceiptConflict", "Mission dispatch was accepted with another receipt", row.version);
  return acceptedDispatch(row, receipt);
}

function boundedDispatchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 256) throw new Error("Invalid Mission dispatch batch limit.");
}

function canonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertMissionProvenance(input: SaveCompiledMissionInput): void {
  const binding = input.dispatch.binding;
  if (
    input.mission.projectId !== input.projectId ||
    input.mission.planId !== input.planId ||
    binding === undefined ||
    input.mission.targetId !== binding.targetId ||
    input.mission.planVersion !== binding.planVersion ||
    input.mission.planSnapshotHash !== binding.planSnapshotHash ||
    input.mission.targetVersion !== binding.targetVersion ||
    input.mission.targetSnapshotHash !== binding.targetSnapshotHash
  ) {
    throw new Error("Compiled Mission provenance does not match its persistence scope.");
  }
}
