import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTargetRevision } from "@qualigence/project-target";
import { createPostgresRuntime, PostgresProjectTargetRepository, PostgresTestPlanRepository, provisionPostgres, type TenantTransactionProvider } from "@qualigence/postgres-runtime";
import { createDraftTestPlan } from "@qualigence/mission";
import { dockerAvailable, startPostgres, type StartedPostgres } from "../../helpers/docker-container.js";
import { sequentialIds, validatedProposal } from "../../unit/core-modules/mission/fixtures.js";

if (!dockerAvailable()) throw new Error("DockerUnavailable: PostgreSQL product intake contract requires Docker.");

describe("PostgreSQL product intake repositories", () => {
  let container: StartedPostgres;
  let provider: TenantTransactionProvider;
  beforeAll(async () => {
    container = await startPostgres();
    const admin = { host: container.host, port: container.port, database: container.database, user: container.superuser, password: container.password };
    await provisionPostgres({ admin, roles: { server: { name: "product_server", password: "server_pw" }, worker: { name: "product_worker", password: "worker_pw" } } });
    provider = createPostgresRuntime({ ...admin, user: "product_server", password: "server_pw" });
  }, 180_000);
  afterAll(async () => { await provider?.close(); await container?.stop(); });

  it("isolates immutable Target and Test Plan revisions by tenant", async () => {
    const target = createTargetRevision({ targetId: "shared-id", projectId: "project-1", displayName: "Web", runnerId: "runner-1", expectedVersion: 0, configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } });
    await provider.withTenant("tenant-a", async ({ db }) => {
      const targets = new PostgresProjectTargetRepository(db, "tenant-a");
      await targets.saveRevision({ revision: target, expectedVersion: 0, idempotencyKey: "target-create", createdAt: "2026-08-21T00:00:00.000Z" });
      const draft = createDraftTestPlan({ projectId: "project-1", prdId: "prd-1", prdRevision: 1, proposal: validatedProposal() }, sequentialIds());
      if (!draft.ok) throw new Error(draft.error.code);
      const plans = new PostgresTestPlanRepository(db, "tenant-a");
      await plans.saveDraft({ plan: draft.value, idempotencyKey: "plan-create", createdAt: "2026-08-21T00:00:00.000Z" });
      await plans.approve({ planId: draft.value.planId, expectedVersion: 1, reviewerId: "tester", idempotencyKey: "plan-approve", clock: { now: () => "2026-08-21T00:01:00.000Z" } });
      expect(await plans.get(draft.value.planId, 1)).toMatchObject({ status: "draft" });
      expect(await plans.get(draft.value.planId, 2)).toMatchObject({ status: "approved" });
    });
    await provider.withTenant("tenant-b", async ({ db }) => {
      expect(await new PostgresProjectTargetRepository(db, "tenant-b").getRevision("shared-id")).toBeUndefined();
    });
  });
});
