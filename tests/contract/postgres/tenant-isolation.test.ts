import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  createPostgresRuntime,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import {
  executionRunRow,
  intelligenceJobRow,
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";

const { Client } = pg;

describe.skipIf(!dockerAvailable())("PostgreSQL tenant isolation", () => {
  let fixture: PostgresFixture;
  let runtime: TenantTransactionProvider;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
    runtime = createPostgresRuntime(fixture.serverConfig);
    // Seed a row owned by tenant-a.
    await runtime.withTenant("tenant-a", async ({ db }) => {
      await db
        .insertInto("execution_runs")
        .values(executionRunRow({ tenantId: "tenant-a", runId: "run-a" }) as never)
        .execute();
      await db
        .insertInto("intelligence_jobs")
        .values(intelligenceJobRow({ tenantId: "tenant-a", runId: "run-a" }) as never)
        .execute();
    });
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await fixture?.stop();
  });

  it("hides another tenant's rows even with the correct primary key", async () => {
    const found = await runtime.withTenant("tenant-b", async ({ db }) => {
      return db
        .selectFrom("execution_runs")
        .selectAll()
        .where("run_id", "=", "run-a")
        .executeTakeFirst();
    });
    expect(found).toBeUndefined();
  });

  it("returns zero rows when no tenant context is set", async () => {
    const client = new Client(fixture.serverConfig);
    await client.connect();
    try {
      const result = await client.query("select count(*)::int as count from execution_runs");
      expect(result.rows[0].count).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("rejects a write whose tenant_id does not match the context", async () => {
    await expect(
      runtime.withTenant("tenant-b", async ({ db }) => {
        await db
          .insertInto("execution_runs")
          .values(executionRunRow({ tenantId: "tenant-a", runId: "run-x" }) as never)
          .execute();
      }),
    ).rejects.toThrow();
  });

  it("rejects an insert when no tenant context is set", async () => {
    const client = new Client(fixture.serverConfig);
    await client.connect();
    try {
      await expect(
        client.query(
          `insert into execution_runs
             (tenant_id, run_id, job_id, target_kind, objective, status, next_sequence_number, created_at)
           values ('tenant-a', 'run-y', 'job-y', 'web', 'x', 'running', 0, '2026-08-01T00:00:00.000Z')`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.end();
    }
  });

  it("runs the Server role as a non-owner without BYPASSRLS or superuser", async () => {
    const client = new Client(fixture.adminConfig);
    await client.connect();
    try {
      const role = await client.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        "select rolsuper, rolbypassrls from pg_roles where rolname = $1",
        [fixture.serverConfig.user],
      );
      expect(role.rows[0]?.rolsuper).toBe(false);
      expect(role.rows[0]?.rolbypassrls).toBe(false);

      const owner = await client.query<{ owner: string }>(
        `select tableowner as owner from pg_tables
           where schemaname = 'public' and tablename = 'execution_runs'`,
      );
      expect(owner.rows[0]?.owner).not.toBe(fixture.serverConfig.user);
    } finally {
      await client.end();
    }
  });

  it("denies the Worker role access to aggregate, review and evidence tables", async () => {
    const client = new Client(fixture.workerConfig);
    await client.connect();
    try {
      for (const table of [
        "execution_runs",
        "review_tasks",
        "evidence_capsule_manifests",
        "investigation_cases",
      ]) {
        await expect(
          client.query(`select * from ${table}`),
        ).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await client.end();
    }
  });

  it("lets the Worker role lease Intelligence Jobs across tenants", async () => {
    const client = new Client(fixture.workerConfig);
    await client.connect();
    try {
      const result = await client.query(
        "select job_id, tenant_id from intelligence_jobs",
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      expect(result.rows.some((row) => row.tenant_id === "tenant-a")).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("forbids the Worker role from writing raw Server-consumed Intelligence Results", async () => {
    const client = new Client(fixture.workerConfig);
    await client.connect();
    try {
      // Worker has no grant on intelligence_applied_results or on the legacy raw
      // results table; accepted proposals must go through the fenced append
      // function that records intelligence_result_inbox metadata.
      await expect(
        client.query("select * from intelligence_applied_results"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        client.query(
          `insert into intelligence_results
             (tenant_id, idempotency_key, job_id, terminal_status, confidence, result_json, created_at)
           values ('tenant-a', 'forged-result', 'job-a', 'succeeded', 1, '{}', now()::text)`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        client.query(
          `insert into intelligence_result_inbox
             (tenant_id, idempotency_key, job_id, worker_id, lease_attempt, lease_token_hash,
              lease_expires_at, base_aggregate_version, result_hash, result_json, accepted_at)
           values ('tenant-a', 'forged-inbox', 'job-a', 'worker-a', 1, 'hash', now()::text, 0, 'hash', '{}', now()::text)`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.end();
    }
  });
});
