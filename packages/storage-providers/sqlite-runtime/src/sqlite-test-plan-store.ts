import { approveTestPlan, type ApproveStoredTestPlanInput, type SaveDraftTestPlanInput, type TestPlanRepository, type TestPlanRevision } from "@qualigence/mission";
import type { PrdDocument } from "@qualigence/context-intake";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

export class TestPlanStoreError extends Error {
  constructor(readonly code: "PlanVersionConflict" | "PlanAlreadyApproved" | "IdempotencyConflict", readonly currentVersion?: number) { super(code); this.name = "TestPlanStoreError"; }
}

export class SqliteTestPlanStore implements TestPlanRepository {
  constructor(private readonly runtime: SqliteRuntime) {}
  async savePrdDocument(document: PrdDocument): Promise<void> {
    await this.runtime.db.insertInto("prd_documents").values({ prd_id: document.prdId, revision: document.revision, project_id: document.projectId, title: document.title, content: document.content, content_sha256: document.contentSha256, ingested_at: document.ingestedAt }).onConflict((oc) => oc.columns(["prd_id", "revision"]).doNothing()).execute();
  }
  async saveDraft(input: SaveDraftTestPlanInput): Promise<TestPlanRevision> {
    return runInImmediateTransaction(this.runtime, async () => {
      const document = await this.getPrdDocument(input.plan.prdId, input.plan.prdRevision);
      if (document === undefined || document.projectId !== input.plan.projectId) throw new TestPlanStoreError("IdempotencyConflict", 0);
      const replay = await this.runtime.db.selectFrom("test_plan_version_revisions").selectAll().where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
      if (replay !== undefined) { const plan = parsePlan(replay.plan_json); if (JSON.stringify(plan) !== JSON.stringify(input.plan)) throw new TestPlanStoreError("IdempotencyConflict", plan.version); return plan; }
      const head = await this.runtime.db.selectFrom("test_plan_heads").selectAll().where("plan_id", "=", input.plan.planId).executeTakeFirst();
      if (head !== undefined) throw new TestPlanStoreError("PlanVersionConflict", head.current_version);
      await this.runtime.db.insertInto("test_plan_heads").values({ plan_id: input.plan.planId, project_id: input.plan.projectId, current_version: input.plan.version, created_at: input.createdAt, updated_at: input.createdAt }).execute();
      await this.runtime.db.insertInto("test_plan_version_revisions").values(planRow(input.plan, input.idempotencyKey, input.createdAt)).execute();
      return input.plan;
    });
  }
  async approve(input: ApproveStoredTestPlanInput): Promise<TestPlanRevision> {
    return runInImmediateTransaction(this.runtime, async () => {
      const replay = await this.runtime.db.selectFrom("test_plan_version_revisions").select("plan_json").where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
      if (replay !== undefined) { const plan = parsePlan(replay.plan_json); if (plan.planId !== input.planId || plan.version !== input.expectedVersion + 1 || plan.approval?.reviewerId !== input.reviewerId) throw new TestPlanStoreError("IdempotencyConflict", plan.version); return plan; }
      const current = await this.get(input.planId);
      if (current === undefined) throw new TestPlanStoreError("PlanVersionConflict", 0);
      if (current.status === "approved" && current.approval?.idempotencyKey !== input.idempotencyKey) throw new TestPlanStoreError("PlanVersionConflict", current.version);
      const result = approveTestPlan(current, input, input.clock);
      if (!result.ok) throw new TestPlanStoreError(result.error.code === "PlanAlreadyApproved" ? "PlanAlreadyApproved" : "PlanVersionConflict", current.version);
      const approved = result.value;
      await this.runtime.db.insertInto("test_plan_version_revisions").values(planRow(approved, input.idempotencyKey, approved.approval?.approvedAt ?? input.clock.now())).execute();
      const updated = await this.runtime.db.updateTable("test_plan_heads").set({ current_version: approved.version, updated_at: approved.approval?.approvedAt ?? input.clock.now() }).where("plan_id", "=", input.planId).where("current_version", "=", input.expectedVersion).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) throw new TestPlanStoreError("PlanVersionConflict", current.version);
      return approved;
    });
  }
  async get(planId: string, version?: number): Promise<TestPlanRevision | undefined> {
    let query = this.runtime.db.selectFrom("test_plan_version_revisions").select("plan_json").where("plan_id", "=", planId);
    query = version === undefined ? query.orderBy("version", "desc").limit(1) : query.where("version", "=", version);
    const row = await query.executeTakeFirst(); return row === undefined ? undefined : parsePlan(row.plan_json);
  }
  async getPrdDocument(prdId: string, revision: number): Promise<PrdDocument | undefined> {
    const row = await this.runtime.db.selectFrom("prd_documents").selectAll().where("prd_id", "=", prdId).where("revision", "=", revision).executeTakeFirst();
    return row === undefined ? undefined : Object.freeze({ prdId: row.prd_id, projectId: row.project_id, revision: row.revision, title: row.title, content: row.content, contentSha256: row.content_sha256, ingestedAt: row.ingested_at });
  }
}
function planRow(plan: TestPlanRevision, key: string, createdAt: string) { return { plan_id: plan.planId, version: plan.version, project_id: plan.projectId, prd_id: plan.prdId, prd_revision: plan.prdRevision, status: plan.status, reviewer_id: plan.approval?.reviewerId ?? null, approved_at: plan.approval?.approvedAt ?? null, idempotency_key: key, plan_json: JSON.stringify(plan), created_at: createdAt }; }
function parsePlan(json: string): TestPlanRevision { return Object.freeze(JSON.parse(json) as TestPlanRevision); }
