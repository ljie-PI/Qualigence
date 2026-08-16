import { PostgresReviewTaskRepository } from "@qualigence/server";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupServerFixture } from "../../helpers/server-fixture.js";
import {
  reviewTaskRepositoryContract,
  type ReviewRepositoryContractHarness,
} from "./review-task-repository.contract.js";

async function createHarness(): Promise<ReviewRepositoryContractHarness> {
  if (!dockerAvailable()) {
    throw new Error("DockerUnavailable: Review repository PostgreSQL contract requires Docker.");
  }
  const fixture = await setupServerFixture();
  const withRepository = <T>(operation: (repository: PostgresReviewTaskRepository) => Promise<T>) =>
    fixture.provider.withTenant("tenant-a", ({ db }) =>
      operation(new PostgresReviewTaskRepository(db)),
    );

  return {
    runPrimary: withRepository,
    runConcurrent: withRepository,
    async readClaimAudit(idempotencyKey) {
      return fixture.provider.withTenant("tenant-a", async ({ db }) => {
        const row = await db
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
      });
    },
    async readResolutionAudit(idempotencyKey) {
      return fixture.provider.withTenant("tenant-a", async ({ db }) => {
        const row = await db
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
      });
    },
    close: () => fixture.stop(),
  };
}

reviewTaskRepositoryContract("PostgreSQL", createHarness);
