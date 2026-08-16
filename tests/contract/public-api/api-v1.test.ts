import pg from "pg";
import type { PostgresConnectionConfig } from "@qualigence/postgres-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { generateRunnerCsr } from "../../helpers/runner-identity-pki.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

const { Client } = pg;
const skip = !dockerAvailable();
const describeMaybe = skip ? describe.skip : describe;

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

async function seedProject(
  admin: PostgresConnectionConfig,
  input: { tenantId: string; projectId: string; name: string },
): Promise<void> {
  const client = new Client(admin);
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

async function seedReviewTask(
  admin: PostgresConnectionConfig,
  input: { tenantId: string; taskId: string; caseId: string; version: number },
): Promise<void> {
  const client = new Client(admin);
  await client.connect();
  try {
    await client.query(
      `insert into review_tasks
        (tenant_id, task_id, case_id, status, reason, priority, evidence_completeness,
         assignee_id, version, created_at, updated_at)
       values ($1,$2,$3,'open','needs review','high','limited',null,$4,now(),now())`,
      [input.tenantId, input.taskId, input.caseId, input.version],
    );
  } finally {
    await client.end();
  }
}

async function readReviewTask(
  admin: PostgresConnectionConfig,
  taskId: string,
): Promise<{ status: string; assignee_id: string | null; version: number }> {
  const client = new Client(admin);
  await client.connect();
  try {
    const result = await client.query<{
      status: string;
      assignee_id: string | null;
      version: number;
    }>(
      "select status, assignee_id, version from review_tasks where task_id = $1",
      [taskId],
    );
    return result.rows[0] as { status: string; assignee_id: string | null; version: number };
  } finally {
    await client.end();
  }
}

describeMaybe("Public API v1 contract", () => {
  let fx: ServerFixture;
  let admin: PostgresConnectionConfig;

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

  function url(path: string): string {
    return `${fx.baseUrl}${path}`;
  }

  describe("OIDC authentication + RBAC", () => {
    it("rejects an unauthenticated request with 401", async () => {
      const res = await fetch(url("/v1/projects"));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("Unauthorized");
    });

    it("rejects an invalid token with 401", async () => {
      const res = await fetch(url("/v1/projects"), {
        headers: { authorization: "Bearer not-a-real-jwt" },
      });
      expect(res.status).toBe(401);
    });

    it("rejects an under-privileged caller with 403", async () => {
      const token = fx.token("tenant-a", ["viewer"]);
      const res = await fetch(url("/v1/projects"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "proj-forbidden",
        },
        body: JSON.stringify({ name: "Nope" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("Forbidden");
    });
  });

  describe("Project create + list", () => {
    it("requires an Idempotency-Key on mutations (400)", async () => {
      const token = fx.token("tenant-a", ["tester"]);
      const res = await fetch(url("/v1/projects"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "No Key" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("IdempotencyKeyRequired");
    });

    it("creates a project and returns a command envelope DTO", async () => {
      const token = fx.token("tenant-a", ["tester"]);
      const res = await fetch(url("/v1/projects"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "proj-alpha",
        },
        body: JSON.stringify({ name: "Alpha" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        resource: { projectId: string; name: string; version: number };
        version: number;
        correlationId: string;
      };
      expect(body.resource).toEqual({ projectId: "proj-alpha", name: "Alpha", version: 1 });
      expect(body.version).toBe(1);
      expect(typeof body.correlationId).toBe("string");
      // No domain-internal fields leak into the DTO.
      expect(Object.keys(body.resource).sort()).toEqual(["name", "projectId", "version"]);
    });

    it("is idempotent: replaying the same key returns the same resource", async () => {
      const token = fx.token("tenant-a", ["tester"]);
      const send = () =>
        fetch(url("/v1/projects"), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            [IDEMPOTENCY_KEY_HEADER]: "proj-idem",
          },
          body: JSON.stringify({ name: "Idem" }),
        });
      const first = (await (await send()).json()) as { resource: { projectId: string } };
      const second = (await (await send()).json()) as { resource: { projectId: string } };
      expect(second.resource.projectId).toBe(first.resource.projectId);
    });
  });

  describe("Tenant isolation (RLS through the API)", () => {
    it("never returns tenant B's projects to tenant A", async () => {
      await seedProject(admin, { tenantId: "tenant-b", projectId: "b-secret", name: "B Secret" });
      const token = fx.token("tenant-a", ["viewer"]);
      const res = await fetch(url("/v1/projects"), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { projectId: string }[] };
      const ids = body.items.map((p) => p.projectId);
      expect(ids).not.toContain("b-secret");
    });

    it("cannot read tenant B's investigation case by id (404)", async () => {
      const client = new Client(admin);
      await client.connect();
      try {
        await client.query(
          `insert into investigation_cases
            (tenant_id, case_id, finding_id, project_id, status, version, plan_revision,
             budget_json, usage_json, bug_episode_id, created_at, updated_at)
           values ('tenant-b','case-b','finding-b','project-1','investigating',1,1,'{}','{}',null,now(),now())`,
        );
      } finally {
        await client.end();
      }
      const token = fx.token("tenant-a", ["viewer"]);
      const res = await fetch(url("/v1/investigations/case-b"), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Optimistic concurrency on review tasks", () => {
    it("rejects a stale expectedVersion with 409", async () => {
      await seedReviewTask(admin, {
        tenantId: "tenant-a",
        taskId: "task-conflict",
        caseId: "case-1",
        version: 3,
      });
      const token = fx.token("tenant-a", ["reviewer"]);
      const res = await fetch(url("/v1/review-tasks/task-conflict/claim"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "claim-stale",
        },
        body: JSON.stringify({ expectedVersion: 1, reviewerId: "rev-1" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("VersionConflict");
    });

    it("claims a task at the correct version and bumps it", async () => {
      await seedReviewTask(admin, {
        tenantId: "tenant-a",
        taskId: "task-ok",
        caseId: "case-1",
        version: 1,
      });
      const token = fx.token("tenant-a", ["reviewer"]);
      const res = await fetch(url("/v1/review-tasks/task-ok/claim"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "claim-ok",
        },
        body: JSON.stringify({ expectedVersion: 1, reviewerId: "rev-1" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resource: { status: string; version: number } };
      expect(body.resource.status).toBe("claimed");
      expect(body.resource.version).toBe(2);
    });

    it("rejects resolving an open task and preserves its row", async () => {
      await seedReviewTask(admin, {
        tenantId: "tenant-a",
        taskId: "task-open-resolve",
        caseId: "case-1",
        version: 1,
      });
      const token = fx.token("tenant-a", ["reviewer"]);
      const res = await fetch(url("/v1/review-tasks/task-open-resolve/resolve"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "resolve-open",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          reviewerId: "rev-1",
          disposition: "confirmed_bug",
          evidenceRefs: [],
        }),
      });

      expect(res.status).toBe(409);
      expect((await res.json() as { code: string }).code).toBe("VersionConflict");
      await expect(readReviewTask(admin, "task-open-resolve")).resolves.toEqual({
        status: "open",
        assignee_id: null,
        version: 1,
      });
    });

    it("rejects a non-assignee resolve and preserves the claimed row", async () => {
      await seedReviewTask(admin, {
        tenantId: "tenant-a",
        taskId: "task-non-assignee",
        caseId: "case-1",
        version: 1,
      });
      const token = fx.token("tenant-a", ["reviewer"]);
      const claimed = await fetch(url("/v1/review-tasks/task-non-assignee/claim"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "claim-alice",
        },
        body: JSON.stringify({ expectedVersion: 1, reviewerId: "alice" }),
      });
      expect(claimed.status).toBe(200);

      const res = await fetch(url("/v1/review-tasks/task-non-assignee/resolve"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "resolve-bob",
        },
        body: JSON.stringify({
          expectedVersion: 2,
          reviewerId: "bob",
          disposition: "confirmed_bug",
          evidenceRefs: [],
        }),
      });

      expect(res.status).toBe(409);
      expect((await res.json() as { code: string }).code).toBe("VersionConflict");
      await expect(readReviewTask(admin, "task-non-assignee")).resolves.toEqual({
        status: "claimed",
        assignee_id: "alice",
        version: 2,
      });
    });

    it("replays an idempotency key without another version increment", async () => {
      await seedReviewTask(admin, {
        tenantId: "tenant-a",
        taskId: "task-idempotent",
        caseId: "case-1",
        version: 1,
      });
      const token = fx.token("tenant-a", ["reviewer"]);
      const send = () => fetch(url("/v1/review-tasks/task-idempotent/claim"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "claim-idempotent",
        },
        body: JSON.stringify({ expectedVersion: 1, reviewerId: "alice" }),
      });

      const first = await send();
      const firstBody = await first.json() as { resource: { version: number; status: string; assigneeId?: string } };
      const replay = await send();
      const replayBody = await replay.json() as { resource: { version: number; status: string; assigneeId?: string } };

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replayBody.resource).toEqual(firstBody.resource);
      await expect(readReviewTask(admin, "task-idempotent")).resolves.toEqual({
        status: "claimed",
        assignee_id: "alice",
        version: 2,
      });
    });
  });

  describe("Runner enrollment (mTLS, never OIDC)", () => {
    it("requires OIDC admin to register a Runner", async () => {
      const viewer = fx.token("tenant-a", ["viewer"]);
      const forbidden = await fetch(url("/v1/runner-enrollments"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${viewer}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "enroll-forbidden",
        },
        body: JSON.stringify({ runnerId: "runner-1", projectIds: ["p1"], ttlMs: 60000 }),
      });
      expect(forbidden.status).toBe(403);
    });

    it("completes the enrollment -> certificate -> self identity flow without OIDC on the runner routes", async () => {
      const adminToken = fx.token("tenant-a", ["admin"]);
      const createRes = await fetch(url("/v1/runner-enrollments"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "enroll-1",
        },
        body: JSON.stringify({ runnerId: "runner-1", projectIds: ["p1"], ttlMs: 600000 }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        resource: { enrollmentId: string; enrollmentToken: string };
      };
      const { enrollmentId, enrollmentToken } = created.resource;
      expect(typeof enrollmentToken).toBe("string");
      expect(enrollmentToken.length).toBeGreaterThan(0);

      const csr = generateRunnerCsr({ commonName: "runner-1" });
      // Certificate issue is Runner-facing: NO OIDC bearer token, tenant via header.
      const certRes = await fetch(url(`/v1/runner-enrollments/${enrollmentId}/certificate`), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-id": "tenant-a",
        },
        body: JSON.stringify({ enrollmentToken, csrPem: csr.csrPem }),
      });
      expect(certRes.status).toBe(201);
      const cert = (await certRes.json()) as { runnerId: string; certificatePem: string };
      expect(cert.runnerId).toBe("runner-1");
      expect(cert.certificatePem).toContain("BEGIN CERTIFICATE");

      // Self identity is mTLS-authenticated via the client certificate header, NOT OIDC.
      // A TLS-terminating proxy forwards the PEM URL-encoded.
      const selfRes = await fetch(url("/v1/runner-identity/self"), {
        headers: { "x-client-cert": encodeURIComponent(cert.certificatePem) },
      });
      expect(selfRes.status).toBe(200);
      const identity = (await selfRes.json()) as { runnerId: string; tenantId: string };
      expect(identity.runnerId).toBe("runner-1");
      expect(identity.tenantId).toBe("tenant-a");
    });

    it("rejects the self route when no client certificate is presented (401)", async () => {
      const res = await fetch(url("/v1/runner-identity/self"));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("RunnerIdentityUnauthenticated");
    });

    it("does not accept an OIDC bearer token in place of a client certificate", async () => {
      const adminToken = fx.token("tenant-a", ["admin"]);
      const res = await fetch(url("/v1/runner-identity/self"), {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(401);
    });
  });
});
