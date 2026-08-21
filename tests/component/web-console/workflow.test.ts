import { createHash, randomUUID } from "node:crypto";
import type { PostgresConnectionConfig } from "@qualigence/postgres-runtime";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicApiClient } from "../../../apps/web-console/src/api/client.js";
import { ApiClientError, isApiErrorCode } from "../../../apps/web-console/src/api/errors.js";
import { MemoryTokenStore } from "../../../apps/web-console/src/auth/memory-token-store.js";
import type { ConsoleSession } from "../../../apps/web-console/src/auth/memory-token-store.js";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

const skip = !dockerAvailable();
const describeMaybe = skip ? describe.skip : describe;

async function seedInvestigationAndTask(
  admin: PostgresConnectionConfig,
  input: { tenantId: string; caseId: string; taskId: string },
): Promise<void> {
  const client = new pg.Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into investigation_cases
        (tenant_id, case_id, finding_id, project_id, status, version, plan_revision,
         budget_json, usage_json, bug_episode_id, created_at, updated_at)
       values ($1,$2,'finding-x','project-1','needs_human',1,1,'{}','{}',null,now(),now())`,
      [input.tenantId, input.caseId],
    );
    await client.query(
      `insert into review_tasks
        (tenant_id, task_id, case_id, status, reason, priority, evidence_completeness,
         assignee_id, version, created_at, updated_at)
       values ($1,$2,$3,'open','needs review','urgent','limited',null,1,now(),now())`,
      [input.tenantId, input.taskId, input.caseId],
    );
  } finally {
    await client.end();
  }
}

/**
 * Critical-user-flow test driven entirely through the Console's typed client
 * against a real `apps/server`: an authenticated user views projects, ingests a
 * PRD, inspects an Investigation and claims + resolves the resulting Review
 * task. No mocked HTTP anywhere.
 */
describeMaybe("Web Console critical user flow (login → project → investigation → review)", () => {
  let fx: ServerFixture;
  let admin: PostgresConnectionConfig;
  const store = new MemoryTokenStore();
  let client: PublicApiClient;

  function login(tenantId: string, roles: readonly string[]): void {
    const session: ConsoleSession = {
      subject: "user-flow",
      tenantId,
      roles: roles as never,
      accessToken: fx.token(tenantId, roles),
      expiresAtMs: Date.now() + 3600_000,
    };
    store.set(session);
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
    client = new PublicApiClient({ baseUrl: fx.baseUrl, accessToken: () => store.accessToken() });
  }, 180_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("runs the full Project → Target → Test Plan → Mission → Investigation → Review journey", async () => {
    // 1. Login as an admin (satisfies tester + reviewer via role hierarchy).
    login("tenant-a", ["admin"]);
    expect(store.isAuthenticated()).toBe(true);

    // 2. Create and list a project.
    await client.createProject({ name: "Journey" }, { idempotencyKey: "flow-project" });
    const projects = await client.listProjects();
    expect(projects.items.map((p) => p.projectId)).toContain("flow-project");

    // 3. Ingest a PRD revision and see it listed.
    const prd = await client.ingestPrd(
      "flow-project",
      { title: "Login PRD", content: "Users can sign in." },
      { idempotencyKey: "flow-prd-1" },
    );
    expect(prd.resource.revision).toBe(1);
    const prds = await client.listPrdRevisions("flow-project");
    expect(prds.items.map((r) => r.prdId)).toContain("flow-prd-1");

    const target = await client.createTarget("flow-project", {
      targetId: "flow-target",
      displayName: "Flow target",
      runnerId: "runner-flow",
      expectedVersion: 0,
      configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" },
    }, { idempotencyKey: "flow-target-create" });
    const sourceRef = { prdId: prd.resource.prdId, revision: 1, startOffset: 0, endOffset: 18, quotedTextSha256: createHash("sha256").update("Users can sign in.").digest("hex") };
    const draft = await client.createTestPlan({
      projectId: "flow-project", prdId: prd.resource.prdId, prdRevision: 1,
      sourceContentSha256: prd.resource.contentSha256,
      expectedClaims: [{ semanticKey: "login", statement: "Users sign in", sourceRefs: [sourceRef], confidence: 1 }],
      testCases: [{ title: "Login", objective: "Verify login", preconditions: [], steps: [{ kind: "verify", claimSemanticKeys: ["login"] }], expectedClaimSemanticKeys: ["login"], sourceRefs: [sourceRef], priority: "high" }],
    }, { idempotencyKey: "flow-plan" });
    const approved = await client.approveTestPlan(draft.resource.planId, { expectedVersion: draft.resource.version }, { idempotencyKey: "flow-plan-approve" });
    const mission = await client.createMission({ projectId: "flow-project", targetId: target.resource.targetId, targetVersion: target.resource.version, targetSnapshotHash: target.resource.snapshotHash, planId: approved.resource.planId, planVersion: approved.resource.version }, { idempotencyKey: "flow-mission" });
    expect(mission.resource).toMatchObject({ runnerId: "runner-flow", targetVersion: 1, planVersion: 2, status: "approved" });
    const replay = await client.createMission({ projectId: "flow-project", targetId: target.resource.targetId, targetVersion: target.resource.version, targetSnapshotHash: target.resource.snapshotHash, planId: approved.resource.planId, planVersion: approved.resource.version }, { idempotencyKey: "flow-mission" });
    expect(replay.resource).toEqual(mission.resource);
    const conflictingTarget = await client.createTarget("flow-project", {
      targetId: "flow-target-2", displayName: "Other target", runnerId: "runner-other", expectedVersion: 0,
      configuration: { kind: "web", startUrl: "https://other.example.test/", allowedOrigins: ["https://other.example.test"], browser: "chromium" },
    }, { idempotencyKey: "flow-target-2-create" });
    const conflict = await client.createMission({ projectId: "flow-project", targetId: conflictingTarget.resource.targetId, targetVersion: conflictingTarget.resource.version, targetSnapshotHash: conflictingTarget.resource.snapshotHash, planId: approved.resource.planId, planVersion: approved.resource.version }, { idempotencyKey: "flow-mission" }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ApiClientError);
    expect(conflict).toMatchObject({ code: "VersionConflict", details: { actualVersion: 1 } });
    expect(await client.getMission(mission.resource.missionId)).toEqual(mission.resource);

    // 4. Inspect a seeded Investigation in the needs_human state.
    await seedInvestigationAndTask(admin, {
      tenantId: "tenant-a",
      caseId: "flow-case",
      taskId: "flow-task",
    });
    const investigation = await client.getInvestigation("flow-case");
    expect(investigation.status).toBe("needs_human");

    // 5. Claim then resolve the Review task with idempotency + expectedVersion.
    const claimed = await client.claimReviewTask(
      "flow-task",
      { expectedVersion: 1, reviewerId: "reviewer-flow" },
      { idempotencyKey: randomUUID() },
    );
    expect(claimed.resource.status).toBe("claimed");
    const resolved = await client.resolveReviewTask(
      "flow-task",
      {
        expectedVersion: claimed.resource.version,
        reviewerId: "reviewer-flow",
        disposition: "confirmed",
        evidenceRefs: [],
      },
      { idempotencyKey: randomUUID() },
    );
    expect(resolved.resource.status).toBe("resolved");

    // 6. Logout clears the in-memory token — subsequent calls are unauthorized.
    store.clear();
    const error = await client.listProjects().catch((e: unknown) => e);
    expect(isApiErrorCode(error, "Unauthorized")).toBe(true);
  });

  it("documents that Run/Skill routes remain owned by later tickets (NotFound)", async () => {
    // The DTOs exist and the client targets the frozen contract paths, but the
    // PR-21 Server does not yet register these routes. The Console degrades to a
    // typed NotFound rather than a broken page — no fabricated data.
    login("tenant-a", ["viewer"]);
    for (const call of [
      () => client.listRuns(),
      () => client.listSkills(),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(isApiErrorCode(error, "NotFound")).toBe(true);
    }
  });
});
