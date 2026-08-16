import pg from "pg";
import type { PostgresConnectionConfig } from "@qualigence/postgres-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicApiClient } from "../../../apps/web-console/src/api/client.js";
import { ApiClientError, isApiErrorCode } from "../../../apps/web-console/src/api/errors.js";
import { MemoryTokenStore } from "../../../apps/web-console/src/auth/memory-token-store.js";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

if (!dockerAvailable()) {
  throw new Error("DockerUnavailable: Web Console API contract requires Docker.");
}

async function seedProject(
  admin: PostgresConnectionConfig,
  input: { tenantId: string; projectId: string; name: string },
): Promise<void> {
  const client = new pg.Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into projects (tenant_id, project_id, name, version, created_at, updated_at)
       values ($1,$2,$3,1,now(),now())`,
      [input.tenantId, input.projectId, input.name],
    );
  } finally {
    await client.end();
  }
}

async function seedInvestigation(
  admin: PostgresConnectionConfig,
  input: { tenantId: string; caseId: string; findingId: string },
): Promise<void> {
  const client = new pg.Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into investigation_cases
        (tenant_id, case_id, finding_id, project_id, status, version, plan_revision,
         budget_json, usage_json, bug_episode_id, created_at, updated_at)
       values ($1,$2,$3,'project-1','needs_human',1,1,'{}','{}',null,now(),now())`,
      [input.tenantId, input.caseId, input.findingId],
    );
  } finally {
    await client.end();
  }
}

async function seedReviewTask(
  admin: PostgresConnectionConfig,
  input: {
    tenantId: string;
    taskId: string;
    caseId: string;
    version: number;
    assigneeId?: string;
  },
): Promise<void> {
  const client = new pg.Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into review_tasks
        (tenant_id, task_id, case_id, status, reason, priority, evidence_completeness,
         assignee_id, version, created_at, updated_at)
        values ($1,$2,$3,$4,'needs review','high','limited',$5,$6,now(),now())`,
      [
        input.tenantId,
        input.taskId,
        input.caseId,
        input.assigneeId === undefined ? "open" : "claimed",
        input.assigneeId ?? null,
        input.version,
      ],
    );
  } finally {
    await client.end();
  }
}

/**
 * Contract test: the Console's typed {@link PublicApiClient} is driven with real
 * HTTP against a real `apps/server` instance (Postgres + OIDC + RBAC via the
 * shared {@link setupServerFixture}). This proves the client's route paths,
 * methods, headers and response shapes match the Server the Console must call —
 * no mocked responses.
 */
describe("Web Console API client ↔ real Public API", () => {
  let fx: ServerFixture;
  let admin: PostgresConnectionConfig;

  function clientFor(tenantId: string, roles: readonly string[]): PublicApiClient {
    const store = new MemoryTokenStore();
    store.set({
      subject: "user-1",
      tenantId,
      roles: roles as never,
      accessToken: fx.token(tenantId, roles),
      expiresAtMs: Date.now() + 3600_000,
    });
    return new PublicApiClient({
      baseUrl: fx.baseUrl,
      accessToken: () => store.accessToken(),
    });
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

  it("lists projects created through the client (create + list round-trip)", async () => {
    const client = clientFor("tenant-a", ["tester"]);
    const created = await client.createProject(
      { name: "Client Alpha" },
      { idempotencyKey: "wc-proj-alpha" },
    );
    expect(created.resource).toEqual({ projectId: "wc-proj-alpha", name: "Client Alpha", version: 1 });

    const list = await client.listProjects();
    expect(list.items.map((p) => p.projectId)).toContain("wc-proj-alpha");
    // The list envelope carries freshness metadata the Console can surface.
    expect(typeof list.asOfTime).toBe("string");
  });

  it("fetches an investigation detail as the bare DTO the Server returns", async () => {
    await seedInvestigation(admin, {
      tenantId: "tenant-a",
      caseId: "wc-case-1",
      findingId: "finding-1",
    });
    const client = clientFor("tenant-a", ["viewer"]);
    const investigation = await client.getInvestigation("wc-case-1");
    expect(investigation.caseId).toBe("wc-case-1");
    expect(investigation.status).toBe("needs_human");
    expect(investigation.findingId).toBe("finding-1");
  });

  it("returns a typed NotFound error for an unknown investigation", async () => {
    const client = clientFor("tenant-a", ["viewer"]);
    await expect(client.getInvestigation("does-not-exist")).rejects.toSatisfy((error: unknown) =>
      isApiErrorCode(error, "NotFound"),
    );
  });

  it("claims then resolves a review task through the client", async () => {
    await seedReviewTask(admin, {
      tenantId: "tenant-a",
      taskId: "wc-task-ok",
      caseId: "wc-case-1",
      version: 1,
    });
    const client = clientFor("tenant-a", ["reviewer"]);

    const claimed = await client.claimReviewTask(
      "wc-task-ok",
      { expectedVersion: 1, reviewerId: "rev-1" },
      { idempotencyKey: "wc-claim-ok" },
    );
    expect(claimed.resource.status).toBe("claimed");
    expect(claimed.resource.assigneeId).toBe("rev-1");
    expect(claimed.resource.version).toBe(2);

    const resolved = await client.resolveReviewTask(
      "wc-task-ok",
      { expectedVersion: 2, reviewerId: "rev-1", disposition: "confirmed", evidenceRefs: [] },
      { idempotencyKey: "wc-resolve-ok" },
    );
    expect(resolved.resource.status).toBe("resolved");
    expect(resolved.resource.version).toBe(3);
  });

  it("surfaces a VersionConflict with the real current state on a stale claim", async () => {
    await seedReviewTask(admin, {
      tenantId: "tenant-a",
      taskId: "wc-task-conflict",
      caseId: "wc-case-1",
      version: 3,
      assigneeId: "existing-reviewer",
    });
    const client = clientFor("tenant-a", ["reviewer"]);
    const error = await client
      .claimReviewTask(
        "wc-task-conflict",
        { expectedVersion: 1, reviewerId: "rev-2" },
        { idempotencyKey: "wc-claim-stale" },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe("VersionConflict");
    // The public conflict contract preserves both submitted and actual versions;
    // domain-only field names must not leak through the API.
    expect((error as ApiClientError).details).toMatchObject({
      expectedVersion: 1,
      actualVersion: 3,
      assigneeId: "existing-reviewer",
    });
  });

  it("enforces RBAC: a viewer cannot create a project (Forbidden)", async () => {
    const client = clientFor("tenant-a", ["viewer"]);
    const error = await client
      .createProject({ name: "Nope" }, { idempotencyKey: "wc-forbidden" })
      .catch((e: unknown) => e);
    expect(isApiErrorCode(error, "Forbidden")).toBe(true);
  });

  it("never leaks another tenant's projects through the client", async () => {
    await seedProject(admin, { tenantId: "tenant-b", projectId: "wc-b-secret", name: "Secret" });
    const client = clientFor("tenant-a", ["viewer"]);
    const list = await client.listProjects();
    expect(list.items.map((p) => p.projectId)).not.toContain("wc-b-secret");
  });
});
