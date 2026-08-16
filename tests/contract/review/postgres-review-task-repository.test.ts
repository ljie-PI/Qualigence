import { PostgresReviewTaskRepository } from "@qualigence/server";
import { openReviewTask, type ReviewTask } from "@qualigence/review";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
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

async function waitForBlockedReviewUpdates(client: Client, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_stat_activity
      WHERE usename = 'qualigence_server'
        AND wait_event_type = 'Lock'
    `);
    if (Number(result.rows[0]?.count ?? 0) >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const activity = await client.query<{
    state: string;
    wait_event_type: string | null;
    wait_event: string | null;
    query: string;
  }>(`
    SELECT state, wait_event_type, wait_event, query
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
  `);
  throw new Error(
    `Timed out waiting for ${expected} blocked ReviewTask updates: ${JSON.stringify(activity.rows)}`,
  );
}

async function installReviewUpdateBarrier(client: Client, lockId: number): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION block_review_task_update()
    RETURNS trigger AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${lockId});
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await client.query(`
    CREATE TRIGGER block_review_task_update
    BEFORE UPDATE ON review_tasks
    FOR EACH ROW EXECUTE FUNCTION block_review_task_update()
  `);
  await client.query("SELECT pg_advisory_lock($1)", [lockId]);
}

describe("PostgreSQL review idempotency races", () => {
  it("replays a duplicate claim after both transactions passed the initial ledger lookup", async () => {
    const fixture = await setupServerFixture();
    const blocker = new Client({
      host: fixture.container.host,
      port: fixture.container.port,
      database: fixture.container.database,
      user: fixture.container.superuser,
      password: fixture.container.password,
    });
    const task = openReviewTask({
      taskId: "postgres-forced-replay",
      caseId: "postgres-forced-replay:case",
      reason: "needs_human",
      priority: "high",
      evidenceCompleteness: "limited",
    });
    const run = (operation: (repository: PostgresReviewTaskRepository) => Promise<ReviewTask | undefined>) =>
      fixture.provider.withTenant("tenant-a", ({ db }) =>
        operation(new PostgresReviewTaskRepository(db)),
      );
    await run(async (repository) => {
      await repository.create(task);
      return task;
    });
    await blocker.connect();
    const operations: Promise<ReviewTask | undefined>[] = [];
    const lockId = 731_001;
    try {
      await installReviewUpdateBarrier(blocker, lockId);
      const command = {
        taskId: task.taskId,
        expectedVersion: 1,
        reviewerId: "alice",
        idempotencyKey: "postgres-forced-replay-key",
      };
      operations.push(
        run((repository) => repository.claim(command)),
        run((repository) => repository.claim(command)),
      );
      await waitForBlockedReviewUpdates(blocker, 2);
      await blocker.query("SELECT pg_advisory_unlock($1)", [lockId]);

      const [first, replay] = await Promise.all(operations);
      expect(first).toMatchObject({ status: "claimed", version: 2, assigneeId: "alice" });
      expect(replay).toEqual(first);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      await Promise.allSettled(operations);
      await blocker.end();
      await fixture.stop();
    }
  });

  it("does not reject when two tasks race for the same idempotency key", async () => {
    const fixture = await setupServerFixture();
    const blocker = new Client({
      host: fixture.container.host,
      port: fixture.container.port,
      database: fixture.container.database,
      user: fixture.container.superuser,
      password: fixture.container.password,
    });
    const taskIds = ["postgres-forced-key-first", "postgres-forced-key-second"] as const;
    const run = (operation: (repository: PostgresReviewTaskRepository) => Promise<ReviewTask | undefined>) =>
      fixture.provider.withTenant("tenant-a", ({ db }) =>
        operation(new PostgresReviewTaskRepository(db)),
      );
    await run(async (repository) => {
      for (const taskId of taskIds) {
        await repository.create(openReviewTask({
          taskId,
          caseId: `${taskId}:case`,
          reason: "needs_human",
          priority: "high",
          evidenceCompleteness: "limited",
        }));
      }
      return undefined;
    });
    await blocker.connect();
    const operations: Promise<ReviewTask | undefined>[] = [];
    const lockId = 731_002;
    try {
      await installReviewUpdateBarrier(blocker, lockId);
      operations.push(
        run((repository) => repository.claim({
          taskId: taskIds[0],
          expectedVersion: 1,
          reviewerId: "alice",
          idempotencyKey: "postgres-forced-shared-key",
        })),
        run((repository) => repository.claim({
          taskId: taskIds[1],
          expectedVersion: 1,
          reviewerId: "bob",
          idempotencyKey: "postgres-forced-shared-key",
        })),
      );
      await waitForBlockedReviewUpdates(blocker, 2);
      await blocker.query("SELECT pg_advisory_unlock($1)", [lockId]);

      const outcomes = await Promise.allSettled(operations);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(0);
      const values = outcomes.map((outcome) =>
        outcome.status === "fulfilled" ? outcome.value : undefined,
      );
      expect(values.filter((value) => value !== undefined)).toHaveLength(1);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      await Promise.allSettled(operations);
      await blocker.end();
      await fixture.stop();
    }
  });

  it("replays a duplicate resolution after both transactions passed the initial ledger lookup", async () => {
    const fixture = await setupServerFixture();
    const blocker = new Client({
      host: fixture.container.host,
      port: fixture.container.port,
      database: fixture.container.database,
      user: fixture.container.superuser,
      password: fixture.container.password,
    });
    const task = openReviewTask({
      taskId: "postgres-forced-resolution-replay",
      caseId: "postgres-forced-resolution-replay:case",
      reason: "needs_human",
      priority: "high",
      evidenceCompleteness: "limited",
    });
    const run = (operation: (repository: PostgresReviewTaskRepository) => Promise<ReviewTask | undefined>) =>
      fixture.provider.withTenant("tenant-a", ({ db }) =>
        operation(new PostgresReviewTaskRepository(db)),
      );
    await run(async (repository) => {
      await repository.create(task);
      return repository.claim({
        taskId: task.taskId,
        expectedVersion: 1,
        reviewerId: "alice",
        idempotencyKey: "postgres-forced-resolution-claim-key",
      });
    });
    await blocker.connect();
    const operations: Promise<ReviewTask | undefined>[] = [];
    const lockId = 731_003;
    try {
      await installReviewUpdateBarrier(blocker, lockId);
      const command = {
        taskId: task.taskId,
        expectedVersion: 2,
        reviewerId: "alice",
        disposition: "accepted",
        evidenceRefs: ["evidence-a"],
        idempotencyKey: "postgres-forced-resolution-replay-key",
      };
      operations.push(
        run((repository) => repository.resolve(command)),
        run((repository) => repository.resolve(command)),
      );
      await waitForBlockedReviewUpdates(blocker, 2);
      await blocker.query("SELECT pg_advisory_unlock($1)", [lockId]);

      const [first, replay] = await Promise.all(operations);
      expect(first).toMatchObject({ status: "resolved", version: 3, assigneeId: "alice" });
      expect(replay).toEqual(first);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      await Promise.allSettled(operations);
      await blocker.end();
      await fixture.stop();
    }
  });

  it("does not reject when two resolutions race for the same idempotency key", async () => {
    const fixture = await setupServerFixture();
    const blocker = new Client({
      host: fixture.container.host,
      port: fixture.container.port,
      database: fixture.container.database,
      user: fixture.container.superuser,
      password: fixture.container.password,
    });
    const taskIds = ["postgres-forced-resolution-first", "postgres-forced-resolution-second"] as const;
    const run = (operation: (repository: PostgresReviewTaskRepository) => Promise<ReviewTask | undefined>) =>
      fixture.provider.withTenant("tenant-a", ({ db }) =>
        operation(new PostgresReviewTaskRepository(db)),
      );
    await run(async (repository) => {
      for (const taskId of taskIds) {
        await repository.create(openReviewTask({
          taskId,
          caseId: `${taskId}:case`,
          reason: "needs_human",
          priority: "high",
          evidenceCompleteness: "limited",
        }));
        await repository.claim({
          taskId,
          expectedVersion: 1,
          reviewerId: "alice",
          idempotencyKey: `${taskId}-claim-key`,
        });
      }
      return undefined;
    });
    await blocker.connect();
    const operations: Promise<ReviewTask | undefined>[] = [];
    const lockId = 731_004;
    try {
      await installReviewUpdateBarrier(blocker, lockId);
      operations.push(
        run((repository) => repository.resolve({
          taskId: taskIds[0],
          expectedVersion: 2,
          reviewerId: "alice",
          disposition: "accepted",
          evidenceRefs: ["evidence-a"],
          idempotencyKey: "postgres-forced-resolution-shared-key",
        })),
        run((repository) => repository.resolve({
          taskId: taskIds[1],
          expectedVersion: 2,
          reviewerId: "alice",
          disposition: "rejected",
          evidenceRefs: ["evidence-b"],
          idempotencyKey: "postgres-forced-resolution-shared-key",
        })),
      );
      await waitForBlockedReviewUpdates(blocker, 2);
      await blocker.query("SELECT pg_advisory_unlock($1)", [lockId]);

      const outcomes = await Promise.allSettled(operations);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(0);
      const values = outcomes.map((outcome) =>
        outcome.status === "fulfilled" ? outcome.value : undefined,
      );
      expect(values.filter((value) => value !== undefined)).toHaveLength(1);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      await Promise.allSettled(operations);
      await blocker.end();
      await fixture.stop();
    }
  });
});
