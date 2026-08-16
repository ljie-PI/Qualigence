import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqliteRuntime,
  SqliteInvestigationStore,
  SqliteReviewStore,
} from "@qualigence/sqlite-runtime";
import {
  InvestigationCase,
  type InvestigationBudget,
} from "@qualigence/investigation";
import {
  ClaimReviewTaskHandler,
  ResolveReviewTaskHandler,
  openReviewTask,
} from "@qualigence/review";

/**
 * This integration test covers the offline-investigation persistence handoff
 * that PR-16 owns: an investigation that exhausts its budget lands in
 * `needs_human`, a Review Task is created for it, and the queue is claimed and
 * resolved under concurrency. It also asserts the Evidence Capsule metadata
 * separation invariant at the schema level — a local-only evidence record lives
 * in its own table and never appears in the remote capsule-manifest upload
 * query. The Evidence Capsule encryption/decryption business logic itself is
 * implemented separately (LS-10 Evidence Capsule crypto) on top of these tables.
 */

const budget: InvestigationBudget = {
  maximumReproductionAttempts: 1,
  maximumPlanningRevisions: 5,
  maximumEnvironmentRetries: 3,
  maximumWallClockMs: 600_000,
  maximumModelTokens: 500_000,
  maximumEnvironmentResets: 5,
  maximumDestructiveActions: 2,
  confirmationConfidenceThreshold: 0.8,
};

const noUsage = {
  reproductionAttempts: 0,
  planningRevisions: 0,
  environmentRetries: 0,
  wallClockMs: 0,
  modelTokens: 0,
  environmentResets: 0,
  destructiveActions: 0,
};

describe("offline investigation persistence handoff", () => {
  let dir: string;
  let runtime: SqliteRuntime;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), ".tmp-offline-capsule-"));
    runtime = await SqliteRuntime.open({
      filename: join(dir, "qualigence.db"),
      busyTimeoutMs: 5_000,
    });
  });

  afterEach(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("persists a budget-exhausted investigation and its human review task", async () => {
    const investigationStore = new SqliteInvestigationStore(runtime);
    const reviewStore = new SqliteReviewStore(runtime);

    const investigation = InvestigationCase.open({
      caseId: "case-offline",
      findingId: "finding-9",
      projectId: "proj-1",
      budget,
    });
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "a" });
    investigation.startReproduction({ expectedVersion: 2, idempotencyKey: "b" });
    investigation.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "c",
      attempt: {
        attemptId: "attempt-1",
        environmentRef: "env-1",
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:05.000Z",
        outcome: "not_reproduced",
        evidenceRefs: ["evidence-1"],
        budgetConsumed: noUsage,
      },
    });
    expect(investigation.status()).toBe("needs_human");
    const handoff = investigation.handoff();
    expect(handoff).toBeDefined();

    await investigationStore.save(investigation, 0);

    const reviewTask = openReviewTask({
      taskId: "review-offline",
      caseId: investigation.caseId,
      reason: handoff?.limitationCodes[0] ?? "needs_human",
      priority: "high",
      evidenceCompleteness: "limited",
    });
    await reviewStore.create("local", reviewTask);

    const claimHandler = new ClaimReviewTaskHandler(reviewStore, "local");
    const claimed = await claimHandler.handle({
      taskId: "review-offline",
      expectedVersion: 1,
      reviewerId: "reviewer-1",
      idempotencyKey: "claim-1",
    });
    expect(claimed).toMatchObject({ status: "claimed", assigneeId: "reviewer-1" });

    const resolveHandler = new ResolveReviewTaskHandler(reviewStore, "local");
    const resolved = await resolveHandler.handle({
      taskId: "review-offline",
      expectedVersion: 2,
      reviewerId: "reviewer-1",
      disposition: "insufficient_evidence",
      evidenceRefs: ["evidence-1"],
      idempotencyKey: "resolve-1",
    });
    expect(resolved).toMatchObject({ status: "resolved", version: 3 });

    const reloaded = await investigationStore.load("case-offline");
    expect(reloaded?.status()).toBe("needs_human");
    expect(reloaded?.handoff()?.limitationCodes).toContain(
      "budget_exhausted:reproductionAttempts",
    );
  });

  it("keeps local-only evidence records out of the remote upload query", async () => {
    // A local-only record (e.g. KMS unavailable) is persisted in its own table.
    await runtime.db
      .insertInto("evidence_local_only_records")
      .values({
        local_record_id: "local-1",
        tenant_id: "tenant-1",
        case_id: "case-offline",
        run_id: "run-1",
        disposition: "local_only",
        reason: "kms_unavailable",
        local_content_refs_json: JSON.stringify(["artifact-1", "artifact-2"]),
        created_at: "2026-08-01T00:00:00.000Z",
        expires_at: "2026-09-01T00:00:00.000Z",
      })
      .execute();

    // The remote upload query only reads capsule manifests, never local-only rows.
    const remoteUploads = await runtime.db
      .selectFrom("evidence_capsule_manifests")
      .select("capsule_id")
      .where("case_id", "=", "case-offline")
      .execute();
    expect(remoteUploads).toEqual([]);

    const localRecords = await runtime.db
      .selectFrom("evidence_local_only_records")
      .select("local_record_id")
      .where("case_id", "=", "case-offline")
      .execute();
    expect(localRecords).toEqual([{ local_record_id: "local-1" }]);
  });
});
