import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { SqliteReviewStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import { openReviewTask } from "@qualigence/review";
import {
  reviewTaskRepositoryContract,
  type ReviewRepositoryContractHarness,
} from "./review-task-repository.contract.js";

async function createHarness(): Promise<ReviewRepositoryContractHarness> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-review-sqlite-contract-"));
  const filename = join(directory, "qualigence.db");
  const primary = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
  const concurrent = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });

  return {
    runPrimary: (operation) => operation(new SqliteReviewStore(primary)),
    runConcurrent: (operation) => operation(new SqliteReviewStore(concurrent)),
    async readClaimAudit(idempotencyKey) {
      const row = await primary.db
        .selectFrom("review_claims")
        .select(["task_id", "reviewer_id", "claimed_version"])
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            taskId: row.task_id,
            reviewerId: row.reviewer_id,
            claimedVersion: row.claimed_version,
          };
    },
    async readResolutionAudit(idempotencyKey) {
      const row = await primary.db
        .selectFrom("review_resolutions")
        .select(["task_id", "reviewer_id", "disposition", "evidence_refs_json", "resolved_version"])
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            taskId: row.task_id,
            reviewerId: row.reviewer_id,
            disposition: row.disposition,
            evidenceRefs: JSON.parse(row.evidence_refs_json) as readonly string[],
            resolvedVersion: row.resolved_version,
          };
    },
    async close() {
      await concurrent.close();
      await primary.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

reviewTaskRepositoryContract("SQLite", createHarness);

describe("SQLite review audit atomicity", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("rolls back a claim when its audit record cannot be written", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-review-sqlite-atomicity-"));
    const runtime = await SqliteRuntime.open({
      filename: join(directory, "qualigence.db"),
      busyTimeoutMs: 5_000,
    });
    cleanup = async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    };
    const repository = new SqliteReviewStore(runtime);
    const reviewTask = openReviewTask({
      taskId: "claim-audit-failure",
      caseId: "claim-audit-failure:case",
      reason: "needs_human",
      priority: "high",
      evidenceCompleteness: "limited",
    });
    await repository.create(reviewTask);
    await sql`
      CREATE TRIGGER reject_review_claim_audits
      BEFORE INSERT ON review_claims
      BEGIN
        SELECT RAISE(ABORT, 'simulated audit failure');
      END
    `.execute(runtime.db);

    await expect(
      repository.claim({
        taskId: reviewTask.taskId,
        expectedVersion: 1,
        reviewerId: "alice",
        idempotencyKey: "claim-audit-failure-key",
      }),
    ).rejects.toThrow("simulated audit failure");
    await expect(repository.find(reviewTask.taskId)).resolves.toEqual(reviewTask);
  });

  it("rolls back a resolution when its audit record cannot be written", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-review-sqlite-atomicity-"));
    const runtime = await SqliteRuntime.open({
      filename: join(directory, "qualigence.db"),
      busyTimeoutMs: 5_000,
    });
    cleanup = async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    };
    const repository = new SqliteReviewStore(runtime);
    const reviewTask = openReviewTask({
      taskId: "resolution-audit-failure",
      caseId: "resolution-audit-failure:case",
      reason: "needs_human",
      priority: "high",
      evidenceCompleteness: "limited",
    });
    await repository.create(reviewTask);
    const claimed = await repository.claim({
      taskId: reviewTask.taskId,
      expectedVersion: 1,
      reviewerId: "alice",
      idempotencyKey: "resolution-audit-failure-claim-key",
    });
    await sql`
      CREATE TRIGGER reject_review_resolution_audits
      BEFORE INSERT ON review_resolutions
      BEGIN
        SELECT RAISE(ABORT, 'simulated resolution audit failure');
      END
    `.execute(runtime.db);

    await expect(
      repository.resolve({
        taskId: reviewTask.taskId,
        expectedVersion: 2,
        reviewerId: "alice",
        disposition: "accepted",
        evidenceRefs: ["evidence-a"],
        idempotencyKey: "resolution-audit-failure-key",
      }),
    ).rejects.toThrow("simulated resolution audit failure");
    await expect(repository.find(reviewTask.taskId)).resolves.toEqual(claimed);
  });
});
