import type { Kysely } from "kysely";
import type {
  CompiledMission,
  DispatchableMission,
  ExecutionJobStatus,
  JobAttemptRecord,
  MissionDispatchDescriptor,
  MissionExecutionRecord,
  MissionStatus,
  PrdMissionRepository,
  SaveCompiledMissionInput,
  TestCase,
  TestPlanRevision,
} from "@qualigence/mission";
import type { PrdDocument, PrdSourceRef } from "@qualigence/context-intake";
import type { PostgresDatabase } from "./postgres-database.js";

export class PostgresPrdMissionRepository implements PrdMissionRepository {
  constructor(private readonly db: Kysely<PostgresDatabase>, private readonly tenantId: string) {}

  async savePrdDocument(document: PrdDocument): Promise<void> {
    await this.db.insertInto("prd_documents").values({ tenant_id: this.tenantId, prd_id: document.prdId, revision: document.revision, project_id: document.projectId, title: document.title, content: document.content, content_sha256: document.contentSha256, ingested_at: document.ingestedAt }).onConflict((oc) => oc.columns(["tenant_id", "prd_id", "revision"]).doNothing()).execute();
  }

  async saveTestPlanRevision(plan: TestPlanRevision): Promise<void> {
    await this.db.insertInto("test_plan_revisions").values({ tenant_id: this.tenantId, plan_id: plan.planId, project_id: plan.projectId, prd_id: plan.prdId, prd_revision: plan.prdRevision, version: plan.version, status: plan.status, reviewer_id: plan.approval?.reviewerId ?? null, approved_at: plan.approval?.approvedAt ?? null, idempotency_key: plan.approval?.idempotencyKey ?? null, plan_json: JSON.stringify(plan), created_at: plan.approval?.approvedAt ?? new Date(0).toISOString() }).onConflict((oc) => oc.columns(["tenant_id", "plan_id"]).doNothing()).execute();
  }

  async saveCompiledMission(input: SaveCompiledMissionInput): Promise<DispatchableMission> {
    const mission = input.mission;
    if (mission.projectId !== input.projectId) throw new Error("Compiled Mission project provenance does not match its persistence scope.");
    const inserted = await this.db.insertInto("missions").values({ tenant_id: this.tenantId, mission_id: mission.missionId, revision: mission.missionRevision, project_id: input.projectId, plan_id: input.planId, prd_id: input.prdId, prd_revision: input.prdRevision, target_id: mission.targetId, compiled_hash: mission.compiledHash, status: "approved", dispatch_json: JSON.stringify(input.dispatch), stop_on_blocked: input.stopOnBlockedTestCase ? 1 : 0 }).onConflict((oc) => oc.columns(["tenant_id", "mission_id", "revision"]).doNothing()).executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows) !== 1) {
      const winner = await this.loadMissionForDispatch(mission.missionId);
      if (winner === undefined) throw new Error(`Compiled Mission ${mission.missionId} winner was not readable.`);
      return winner;
    }
    await this.db.insertInto("mission_revisions").values({ tenant_id: this.tenantId, mission_id: mission.missionId, revision: mission.missionRevision, compiled_json: JSON.stringify(mission), created_at: new Date(0).toISOString() }).onConflict((oc) => oc.columns(["tenant_id", "mission_id", "revision"]).doNothing()).execute();
    for (const job of mission.jobs) {
      await this.db.insertInto("execution_jobs").values({ tenant_id: this.tenantId, job_id: job.jobId, mission_id: job.missionId, mission_revision: job.missionRevision, test_case_id: job.testCaseId, objective: job.testCaseSnapshot.objective, required_capabilities_json: JSON.stringify(job.requiredCapabilities), source_refs_json: JSON.stringify(job.testCaseSnapshot.sourceRefs), snapshot_hash: job.snapshotHash, snapshot_json: JSON.stringify(job.testCaseSnapshot), idempotency_key: job.idempotencyKey, status: job.status }).onConflict((oc) => oc.columns(["tenant_id", "job_id"]).doNothing()).execute();
    }
    const persisted = await this.loadMissionForDispatch(mission.missionId);
    if (persisted === undefined) throw new Error(`Compiled Mission ${mission.missionId} was not persisted.`);
    return persisted;
  }

  async loadMissionForDispatch(missionId: string): Promise<DispatchableMission | undefined> {
    const mission = await this.db.selectFrom("missions").selectAll().where("tenant_id", "=", this.tenantId).where("mission_id", "=", missionId).orderBy("revision", "desc").executeTakeFirst();
    if (mission === undefined) return undefined;
    const compiledRow = await this.db.selectFrom("mission_revisions").select("compiled_json").where("tenant_id", "=", this.tenantId).where("mission_id", "=", missionId).where("revision", "=", mission.revision).executeTakeFirstOrThrow();
    const compiled = JSON.parse(compiledRow.compiled_json) as CompiledMission;
    const jobs = await this.db.selectFrom("execution_jobs").selectAll().where("tenant_id", "=", this.tenantId).where("mission_id", "=", missionId).where("mission_revision", "=", mission.revision).orderBy("job_id").execute();
    return { missionId, missionRevision: mission.revision, projectId: mission.project_id, planId: mission.plan_id, prdId: mission.prd_id, prdRevision: mission.prd_revision, status: mission.status as MissionStatus, dispatch: JSON.parse(mission.dispatch_json) as MissionDispatchDescriptor, executionPolicy: compiled.executionPolicy, stopOnBlockedTestCase: mission.stop_on_blocked === 1, jobs: jobs.map((job) => ({ jobId: job.job_id, testCaseId: job.test_case_id, objective: job.objective, requiredCapabilities: JSON.parse(job.required_capabilities_json) as string[], status: job.status as ExecutionJobStatus, sourceRefs: JSON.parse(job.source_refs_json) as PrdSourceRef[], snapshot: JSON.parse(job.snapshot_json) as TestCase })) };
  }

  async listMissionIds(): Promise<readonly string[]> {
    const rows = await this.db.selectFrom("missions").select("mission_id").distinct().where("tenant_id", "=", this.tenantId).orderBy("mission_id").execute();
    return rows.map((row) => row.mission_id);
  }

  async recordJobAttempt(attempt: JobAttemptRecord): Promise<void> { await this.db.insertInto("execution_job_attempts").values({ tenant_id: this.tenantId, attempt_id: attempt.attemptId, job_id: attempt.jobId, mission_id: attempt.missionId, run_id: attempt.runId, status: attempt.status, error_code: attempt.errorCode ?? null, created_at: attempt.createdAt }).onConflict((oc) => oc.columns(["tenant_id", "attempt_id"]).doNothing()).execute(); }
  async setJobStatus(jobId: string, status: ExecutionJobStatus): Promise<void> { await this.db.updateTable("execution_jobs").set({ status }).where("tenant_id", "=", this.tenantId).where("job_id", "=", jobId).execute(); }
  async setMissionStatus(missionId: string, missionRevision: number, status: MissionStatus): Promise<void> { await this.db.updateTable("missions").set({ status }).where("tenant_id", "=", this.tenantId).where("mission_id", "=", missionId).where("revision", "=", missionRevision).execute(); }
  async loadMissionExecution(missionId: string): Promise<MissionExecutionRecord | undefined> {
    const mission = await this.loadMissionForDispatch(missionId);
    if (mission === undefined) return undefined;
    return { missionId, missionRevision: mission.missionRevision, projectId: mission.projectId, planId: mission.planId, prdId: mission.prdId, prdRevision: mission.prdRevision, status: mission.status, jobs: mission.jobs.map((job) => ({ jobId: job.jobId, testCaseId: job.testCaseId, status: job.status, sourceRefs: job.sourceRefs, attempts: [] })) };
  }
}
