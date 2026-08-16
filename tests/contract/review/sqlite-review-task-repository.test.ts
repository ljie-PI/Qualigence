import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { SqliteReviewStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
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
