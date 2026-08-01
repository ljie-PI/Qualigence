import { randomUUID } from "node:crypto";
import type { PostgresConnectionConfig } from "@qualigence/postgres-runtime";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewTaskDto } from "@qualigence/public-api";
import { PublicApiClient } from "../../../apps/web-console/src/api/client.js";
import { ApiClientError } from "../../../apps/web-console/src/api/errors.js";
import { MemoryTokenStore } from "../../../apps/web-console/src/auth/memory-token-store.js";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

const skip = !dockerAvailable();
const describeMaybe = skip ? describe.skip : describe;

async function seedReviewTask(
  admin: PostgresConnectionConfig,
  input: { tenantId: string; taskId: string; caseId: string },
): Promise<void> {
  const client = new pg.Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into review_tasks
        (tenant_id, task_id, case_id, status, reason, priority, evidence_completeness,
         assignee_id, version, created_at, updated_at)
       values ($1,$2,$3,'open','needs review','high','limited',null,1,now(),now())`,
      [input.tenantId, input.taskId, input.caseId],
    );
  } finally {
    await client.end();
  }
}

/**
 * Simulates the design's concurrent-claim scenario: two reviewers claim the
 * same task. The first wins; the second's stale `expectedVersion` yields a real
 * 409 VersionConflict. The Console then re-reads the queue and replaces its
 * stale view with the true assignee/version — exactly what the UI must show.
 */
describeMaybe("Web Console review-task concurrent claim conflict", () => {
  let fx: ServerFixture;
  let admin: PostgresConnectionConfig;

  function clientFor(roles: readonly string[]): PublicApiClient {
    const store = new MemoryTokenStore();
    store.set({
      subject: "u",
      tenantId: "tenant-a",
      roles: roles as never,
      accessToken: fx.token("tenant-a", roles),
      expiresAtMs: Date.now() + 3600_000,
    });
    return new PublicApiClient({ baseUrl: fx.baseUrl, accessToken: () => store.accessToken() });
  }

  beforeAll(async () => {
    fx = await setupServerFixture();
    admin = {
      host: fx.container.host,
      port: fx.container.port,
      database: fx.container.database,
      user: fx.container.superuser,
      password: fx.container.password,
    };
  }, 180_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("first claim wins; second sees VersionConflict and the real assignee after re-read", async () => {
    await seedReviewTask(admin, {
      tenantId: "tenant-a",
      taskId: "conflict-task",
      caseId: "case-c",
    });

    const alice = clientFor(["reviewer"]);
    const bob = clientFor(["reviewer"]);

    // Both start from the same observed version (1).
    const observedVersion = 1;

    const aliceResult = await alice.claimReviewTask(
      "conflict-task",
      { expectedVersion: observedVersion, reviewerId: "alice" },
      { idempotencyKey: randomUUID() },
    );
    expect(aliceResult.resource.assigneeId).toBe("alice");
    expect(aliceResult.resource.version).toBe(2);

    // Bob's claim at the stale version must conflict.
    const bobError = await bob
      .claimReviewTask(
        "conflict-task",
        { expectedVersion: observedVersion, reviewerId: "bob" },
        { idempotencyKey: randomUUID() },
      )
      .catch((e: unknown) => e);
    expect(bobError).toBeInstanceOf(ApiClientError);
    expect((bobError as ApiClientError).code).toBe("VersionConflict");

    // The Console's conflict handler re-reads the queue to replace stale state.
    const queue = await bob.listReviewTasks();
    const current = queue.items.find((t) => t.taskId === "conflict-task") as ReviewTaskDto;
    expect(current.assigneeId).toBe("alice");
    expect(current.status).toBe("claimed");
    expect(current.version).toBe(2);
  });
});
