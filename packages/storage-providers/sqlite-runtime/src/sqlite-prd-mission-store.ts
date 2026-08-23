import { createHash } from "node:crypto";
import type { PrdDocument, PrdSourceRef } from "@qualigence/context-intake";
import type {
  DispatchableJob,
  DispatchableMission,
  ExecutionJobStatus,
  JobAttemptRecord,
  MissionDispatchDescriptor,
  MissionExecutionRecord,
  MissionJobExecution,
  MissionSchedulingSnapshot,
  MissionStatus,
  PrdMissionRepository,
  SaveCompiledMissionInput,
  TestCase,
  TestPlanRevision,
} from "@qualigence/mission";
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
  constructor(private readonly runtime: SqliteRuntime) {}

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
    if (mission.projectId !== input.projectId) {
      throw new Error("Compiled Mission project provenance does not match its persistence scope.");
    }
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
    const planSnapshot = await planSnapshotJson(this.runtime.db, mission.plan_id, (JSON.parse(mission.dispatch_json) as MissionDispatchDescriptor).binding?.planVersion);
    return {
      missionId,
      missionRevision: mission.revision,
      missionVersion: schedulingHead?.version ?? 1,
      compiledHash: mission.compiled_hash,
      projectId: mission.project_id,
      planId: mission.plan_id,
      planSnapshotHash: planSnapshot === undefined ? "" : createHash("sha256").update(planSnapshot).digest("hex"),
      planSnapshotJson: planSnapshot ?? "",
      prdId: mission.prd_id,
      prdRevision: mission.prd_revision,
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

async function planSnapshotJson(db: SqliteRuntime["db"], planId: string, version: number | undefined): Promise<string | undefined> {
  if (version === undefined) return undefined;
  const row = await db.selectFrom("test_plan_version_revisions").select("plan_json").where("plan_id", "=", planId).where("version", "=", version).executeTakeFirst();
  return row?.plan_json;
}
