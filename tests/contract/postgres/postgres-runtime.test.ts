import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  assertPostgresSchemaCurrent,
  acquirePostgresMigrationLock,
  acquirePostgresOperationLock,
  migratePostgres,
  createPostgresRuntime,
  readSchemaVersion,
  PostgresSchemaError,
  type TenantTransactionProvider,
  PostgresIntelligenceQueue,
} from "@qualigence/postgres-runtime";
import {
  relationalTableNames,
  tenantOwnedTableNames,
} from "@qualigence/relational-kysely";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { startPostgres, type StartedPostgres } from "../../helpers/docker-container.js";
import {
  executionRunRow,
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";

const { Client } = pg;

describe.skipIf(!dockerAvailable())("PostgreSQL runtime schema", () => {
  let fixture: PostgresFixture;
  let runtime: TenantTransactionProvider;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
    runtime = createPostgresRuntime(fixture.serverConfig);
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await fixture?.stop();
  });

  it("reports the shared logical schema version", async () => {
    expect(await readSchemaVersion(fixture.adminConfig)).toBe(15);
  });

  it("creates every catalogued table", async () => {
    const client = new Client(fixture.adminConfig);
    await client.connect();
    try {
      const result = await client.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public'",
      );
      const present = new Set(result.rows.map((row) => row.table_name));
      for (const table of relationalTableNames()) {
        expect(present.has(table), `table ${table}`).toBe(true);
      }
    } finally {
      await client.end();
    }
  });

  it("gives every tenant-owned table a tenant_id primary-key column", async () => {
    const client = new Client(fixture.adminConfig);
    await client.connect();
    try {
      for (const table of tenantOwnedTableNames()) {
        const columns = await client.query<{ column_name: string }>(
          `select column_name from information_schema.columns
             where table_schema = 'public' and table_name = $1 and column_name = 'tenant_id'`,
          [table],
        );
        expect(columns.rows.length, `${table}.tenant_id column`).toBe(1);

        const pk = await client.query<{ column_name: string }>(
          `select kcu.column_name
             from information_schema.table_constraints tc
             join information_schema.key_column_usage kcu
               on tc.constraint_name = kcu.constraint_name
              and tc.table_schema = kcu.table_schema
            where tc.constraint_type = 'PRIMARY KEY'
              and tc.table_schema = 'public'
              and tc.table_name = $1`,
          [table],
        );
        const pkColumns = pk.rows.map((row) => row.column_name);
        expect(pkColumns, `${table} primary key`).toContain("tenant_id");
      }
    } finally {
      await client.end();
    }
  });

  it("enables and forces row-level security on every tenant-owned table", async () => {
    const client = new Client(fixture.adminConfig);
    await client.connect();
    try {
      const result = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relname, relrowsecurity, relforcerowsecurity
           from pg_class
          where relnamespace = 'public'::regnamespace and relkind = 'r'`,
      );
      const byName = new Map(result.rows.map((row) => [row.relname, row]));
      for (const table of tenantOwnedTableNames()) {
        const row = byName.get(table);
        expect(row?.relrowsecurity, `${table} RLS enabled`).toBe(true);
        expect(row?.relforcerowsecurity, `${table} RLS forced`).toBe(true);
      }
    } finally {
      await client.end();
    }
  });

  it("makes every intra-tenant foreign key tenant-inclusive", async () => {
    const client = new Client(fixture.adminConfig);
    await client.connect();
    try {
      const result = await client.query<{
        constraint_name: string;
        table_name: string;
        columns: string[];
      }>(
        `select tc.constraint_name, tc.table_name,
                array_agg(kcu.column_name order by kcu.ordinal_position) as columns
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu
             on tc.constraint_name = kcu.constraint_name
            and tc.table_schema = kcu.table_schema
          where tc.constraint_type = 'FOREIGN KEY'
            and tc.table_schema = 'public'
          group by tc.constraint_name, tc.table_name`,
      );
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(row.columns, `${row.table_name}.${row.constraint_name}`).toContain(
          "tenant_id",
        );
      }
    } finally {
      await client.end();
    }
  });

  it("round-trips a tenant-scoped row through withTenant", async () => {
    await runtime.withTenant("tenant-a", async ({ db }) => {
      await db
        .insertInto("execution_runs")
        .values(executionRunRow({ tenantId: "tenant-a", runId: "run-1" }) as never)
        .execute();
    });

    const found = await runtime.withTenant("tenant-a", async ({ db }) => {
      return db
        .selectFrom("execution_runs")
        .selectAll()
        .where("run_id", "=", "run-1")
        .executeTakeFirst();
    });
    expect(found?.run_id).toBe("run-1");
    expect(found?.tenant_id).toBe("tenant-a");
  });

  it("denies DDL to both runtime roles", async () => {
    for (const config of [fixture.serverConfig, fixture.workerConfig]) {
      const client = new Client(config);
      await client.connect();
      try {
        await expect(client.query("create table runtime_ddl_forbidden (id integer)"))
          .rejects.toMatchObject({ code: "42501" });
        await expect(client.query("create temporary table runtime_temp_forbidden (id integer)"))
          .rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.end();
      }
    }
    const owner = new Client(fixture.adminConfig);
    await owner.connect();
    try {
      await expect(owner.query("create temporary table owner_temp_allowed (id integer)"))
        .resolves.toMatchObject({ command: "CREATE" });
    } finally {
      await owner.end();
    }
  });

  it("denies Worker mutation of Intelligence Job authority columns", async () => {
    const admin = new Client(fixture.adminConfig);
    await admin.connect();
    await admin.query(`insert into intelligence_jobs (
      tenant_id, job_id, job_type, schema_version, project_id, aggregate_type,
      aggregate_id, base_aggregate_version, model_profile_id, data_policy_id,
      priority, idempotency_key, causation_id, expected_result_schema, job_json, created_at
    ) values (
      'tenant-worker-grant', 'job-worker-grant', 'prd.planning', 'intelligence-job/v1',
      'project-1', 'skill', 'skill-1', 3, 'profile-1', 'policy-1', 'normal',
      'idem-worker-grant', 'cause-1', 'intelligence-result/v1', '{}', now()::text
    )`);
    await admin.end();

    const worker = new Client(fixture.workerConfig);
    await worker.connect();
    try {
      await expect(worker.query(
        "update intelligence_jobs set job_json = '{\"forged\":true}' where job_id = 'job-worker-grant'",
      )).rejects.toMatchObject({ code: "42501" });
      await expect(worker.query(
        "update intelligence_jobs set base_aggregate_version = 99 where job_id = 'job-worker-grant'",
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await worker.end();
    }
  });

  it("blocks Worker queue operations while the exclusive migration lock is held", async () => {
    const lock = await acquirePostgresMigrationLock(fixture.adminConfig);
    const queue = new PostgresIntelligenceQueue(
      fixture.workerConfig,
      acquirePostgresOperationLock,
    );
    let settled = false;
    const lease = queue.lease({
      workerId: "lock-test-worker",
      acceptedTypes: ["skill.induction"],
      now: new Date().toISOString(),
      leaseDurationMs: 60_000,
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    await lock.release();
    await expect(lease).resolves.toBeUndefined();
    await queue.close();
  });

  it("upgrades supported persisted versions sequentially without skipping steps", async () => {
    const applied: number[] = [];
    const partial = await startPostgres();
    const admin = {
      host: partial.host,
      port: partial.port,
      database: partial.database,
      user: partial.superuser,
      password: partial.password,
    };
    try {
      await migratePostgres({ admin, targetVersion: 3 });
      expect(await readSchemaVersion(admin)).toBe(3);
      await migratePostgres({
        admin,
        beforeStep: ({ version }) => {
          applied.push(version);
        },
      });
      expect(applied).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      await expect(assertPostgresSchemaCurrent(admin, admin.user)).rejects.toMatchObject({ code: "SchemaBehind" });
      await markAuxSchemaCurrent(admin);
      await expect(assertPostgresSchemaCurrent(admin, admin.user)).rejects.toMatchObject({ code: "SchemaMalformed" });
    } finally {
      await partial.stop();
    }
  }, 120_000);

  it("backfills payload-free Result wakeups when upgrading v12 inbox rows to v13", async () => {
    const partial = await startPostgres();
    const admin = {
      host: partial.host,
      port: partial.port,
      database: partial.database,
      user: partial.superuser,
      password: partial.password,
    };
    const client = new Client(admin);
    await client.connect();
    try {
      await migratePostgres({ admin, targetVersion: 12 });
      expect(await readSchemaVersion(admin)).toBe(12);

      await client.query(`
        insert into intelligence_jobs (
          tenant_id, job_id, job_type, schema_version, project_id, aggregate_type,
          aggregate_id, base_aggregate_version, model_profile_id, data_policy_id,
          priority, idempotency_key, causation_id, expected_result_schema, job_json, created_at
        ) values
          ('tenant-a', 'job-a-1', 'prd.planning', 'intelligence-job/v1', 'project-a', 'skill', 'skill-a', 0,
           'profile-a', 'policy-a', 'normal', 'job-idem-a-1', 'cause-a-1', 'intelligence-result/v1',
           '{"prompt":"secret-proposal-a1"}', '2026-08-20T00:00:00.000Z'),
          ('tenant-a', 'job-a-2', 'prd.planning', 'intelligence-job/v1', 'project-a', 'skill', 'skill-a', 0,
           'profile-a', 'policy-a', 'normal', 'job-idem-a-2', 'cause-a-2', 'intelligence-result/v1',
           '{"prompt":"secret-proposal-a2"}', '2026-08-20T00:00:00.000Z'),
          ('tenant-b', 'job-b-1', 'prd.planning', 'intelligence-job/v1', 'project-b', 'skill', 'skill-b', 0,
           'profile-b', 'policy-b', 'normal', 'job-idem-b-1', 'cause-b-1', 'intelligence-result/v1',
           '{"prompt":"secret-proposal-b1"}', '2026-08-20T00:00:00.000Z')
      `);
      await client.query(`
        insert into intelligence_leases (
          tenant_id, job_id, attempt, worker_id, lease_token_hash, lease_started_at,
          expires_at, last_renewed_at, renewal_count, released_at, completed_at
        ) values
          ('tenant-a', 'job-a-1', 1, 'worker-a', 'token-a-1', '2026-08-20T00:00:00.000Z',
           '2026-08-20T00:10:00.000Z', null, 0, null, '2026-08-20T00:01:00.000Z'),
          ('tenant-a', 'job-a-2', 1, 'worker-a', 'token-a-2', '2026-08-20T00:00:00.000Z',
           '2026-08-20T00:10:00.000Z', null, 0, null, '2026-08-20T00:03:00.000Z'),
          ('tenant-b', 'job-b-1', 1, 'worker-b', 'token-b-1', '2026-08-20T00:00:00.000Z',
           '2026-08-20T00:10:00.000Z', null, 0, null, '2026-08-20T00:02:00.000Z')
      `);
      await client.query(`
        insert into intelligence_result_inbox (
          tenant_id, idempotency_key, job_id, worker_id, lease_attempt, lease_token_hash,
          lease_expires_at, base_aggregate_version, result_hash, result_json, accepted_at
        ) values
          ('tenant-a', 'result-a-1', 'job-a-1', 'worker-a', 1, 'token-a-1',
           '2026-08-20T00:10:00.000Z', 0, 'hash-a-1', '{"proposal":"secret-proposal-a1"}', '2026-08-20T00:01:00.000Z'),
          ('tenant-a', 'result-a-2', 'job-a-2', 'worker-a', 1, 'token-a-2',
           '2026-08-20T00:10:00.000Z', 0, 'hash-a-2', '{"proposal":"secret-proposal-a2"}', '2026-08-20T00:03:00.000Z'),
          ('tenant-b', 'result-b-1', 'job-b-1', 'worker-b', 1, 'token-b-1',
           '2026-08-20T00:10:00.000Z', 0, 'hash-b-1', '{"proposal":"secret-proposal-b1"}', '2026-08-20T00:02:00.000Z')
      `);

      const migration = await migratePostgres({ admin, targetVersion: 13 });
      expect(migration.appliedVersions).toEqual([13]);
      const wakeups = await client.query<{
        tenant_id: string;
        generation: number;
        status: string;
        available_at: string;
        lease_owner: string | null;
        lease_generation: number | null;
        lease_expires_at: string | null;
        last_claimed_at: string | null;
        last_completed_at: string | null;
        failure_count: number;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }>(`
        select tenant_id, generation, status, available_at, lease_owner, lease_generation,
               lease_expires_at, last_claimed_at, last_completed_at, failure_count, last_error,
               created_at, updated_at
          from intelligence_result_wakeups
         order by tenant_id
      `);
      expect(wakeups.rows).toEqual([
        {
          tenant_id: "tenant-a",
          generation: 2,
          status: "pending",
          available_at: "2026-08-20T00:01:00.000Z",
          lease_owner: null,
          lease_generation: null,
          lease_expires_at: null,
          last_claimed_at: null,
          last_completed_at: null,
          failure_count: 0,
          last_error: null,
          created_at: "2026-08-20T00:01:00.000Z",
          updated_at: "2026-08-20T00:01:00.000Z",
        },
        {
          tenant_id: "tenant-b",
          generation: 1,
          status: "pending",
          available_at: "2026-08-20T00:02:00.000Z",
          lease_owner: null,
          lease_generation: null,
          lease_expires_at: null,
          last_claimed_at: null,
          last_completed_at: null,
          failure_count: 0,
          last_error: null,
          created_at: "2026-08-20T00:02:00.000Z",
          updated_at: "2026-08-20T00:02:00.000Z",
        },
      ]);
      const wakeupJson = JSON.stringify(wakeups.rows);
      expect(wakeupJson).not.toContain("secret-proposal");
      expect(wakeupJson).not.toContain("hash-a-1");
      expect(wakeupJson).not.toContain("result-a-1");

      const wakeupColumns = await client.query<{ column_name: string }>(`
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'intelligence_result_wakeups'
      `);
      expect(wakeupColumns.rows.map((row) => row.column_name)).not.toEqual(
        expect.arrayContaining(["idempotency_key", "job_id", "result_hash", "result_json"]),
      );

      await expect(migratePostgres({ admin, targetVersion: 13 })).resolves.toMatchObject({
        fromVersion: 13,
        toVersion: 13,
        appliedVersions: [],
      });
      const replayedWakeups = await client.query(
        "select tenant_id, generation, status, available_at from intelligence_result_wakeups order by tenant_id",
      );
      expect(replayedWakeups.rows).toEqual(wakeups.rows.map(({
        tenant_id,
        generation,
        status,
        available_at,
      }) => ({ tenant_id, generation, status, available_at })));
    } finally {
      await client.end().catch(() => undefined);
      await partial.stop();
    }
  }, 120_000);

  it("applies runtime access only to tables released through the migration target", async () => {
    const partial = await startPostgres();
    const admin = {
      host: partial.host,
      port: partial.port,
      database: partial.database,
      user: partial.superuser,
      password: partial.password,
    };
    const roles = { server: "partial_server", worker: "partial_worker" };
    const client = new Client(admin);
    await client.connect();
    try {
      await client.query("create role partial_server login");
      await client.query("create role partial_worker login");

      await migratePostgres({ admin, targetVersion: 1, roles });
      const policies = await client.query<{ tablename: string }>(`
        select tablename from pg_policies
         where schemaname = 'public' and policyname = 'tenant_isolation'
         order by tablename
      `);
      expect(policies.rows.map(({ tablename }) => tablename)).toEqual([
        "artifact_manifests",
        "execution_runs",
        "findings",
        "model_invocations",
        "trace_events",
      ]);
      const serverSelectGrants = await client.query<{ table_name: string }>(`
        select table_name from information_schema.role_table_grants
         where grantee = 'partial_server'
           and table_schema = 'public'
           and privilege_type = 'SELECT'
           and table_name not in ('schema_components', 'schema_migrations')
         order by table_name
      `);
      expect(serverSelectGrants.rows.map(({ table_name }) => table_name)).toEqual([
        "artifact_manifests",
        "execution_runs",
        "findings",
        "model_invocations",
        "trace_events",
      ]);
      const futureTable = await client.query<{ future_table: string | null }>(
        "select to_regclass('public.prd_documents')::text as future_table",
      );
      expect(futureTable.rows).toEqual([{ future_table: null }]);

      await migratePostgres({ admin, roles });
      const upgradedAccess = await client.query<{
        prd_rls: boolean;
        prd_select: boolean;
        tenant_policy: boolean;
      }>(`
        select prd.relrowsecurity as prd_rls,
               has_table_privilege('partial_server', 'prd_documents', 'select') as prd_select,
               exists (
                 select 1 from pg_policies
                  where schemaname = 'public'
                    and tablename = 'prd_documents'
                    and policyname = 'tenant_isolation'
               ) as tenant_policy
          from pg_class prd
         where prd.oid = 'public.prd_documents'::regclass
      `);
      expect(upgradedAccess.rows).toEqual([{
        prd_rls: true,
        prd_select: true,
        tenant_policy: true,
      }]);
    } finally {
      await client.end().catch(() => undefined);
      await partial.stop();
    }
  }, 120_000);

  it("rolls back a failed step and resumes from the last committed version", async () => {
    const partial = await startPostgres();
    const admin = {
      host: partial.host,
      port: partial.port,
      database: partial.database,
      user: partial.superuser,
      password: partial.password,
    };
    try {
      await migratePostgres({ admin, targetVersion: 2 });
      await expect(
        migratePostgres({
          admin,
          afterStepSchema: ({ version }) => {
            if (version === 4) throw new Error("injected migration failure");
          },
        }),
      ).rejects.toThrow("injected migration failure");
      expect(await readSchemaVersion(admin)).toBe(3);
      const failedStepTable = new Client(admin);
      await failedStepTable.connect();
      const failedStep = await failedStepTable.query<{ exists: boolean }>(
        "select to_regclass('public.benchmark_runs') is not null as exists",
      );
      await failedStepTable.end();
      expect(failedStep.rows[0]?.exists).toBe(false);
      await expect(assertPostgresSchemaCurrent(admin, admin.user)).rejects.toMatchObject({
        code: "SchemaBehind",
      } satisfies Partial<PostgresSchemaError>);
      await migratePostgres({ admin });
      await markAuxSchemaCurrent(admin);
      await expect(assertPostgresSchemaCurrent(admin, admin.user)).rejects.toMatchObject({ code: "SchemaMalformed" });

      const client = new Client(admin);
      await client.connect();
      await client.query("delete from schema_migrations where version = 4");
      await expect(assertPostgresSchemaCurrent(admin, admin.user)).rejects.toMatchObject({
        code: "SchemaMalformed",
      } satisfies Partial<PostgresSchemaError>);
      await client.query(
        "insert into schema_migrations (version, name, applied_at) values (4, 'exploration-benchmark', now()::text), (16, 'future', now()::text)",
      );
      await client.end();
      await expect(assertPostgresSchemaCurrent(admin, admin.user)).rejects.toMatchObject({
        code: "SchemaAhead",
      } satisfies Partial<PostgresSchemaError>);
    } finally {
      await partial.stop();
    }
  }, 120_000);
});

async function markAuxSchemaCurrent(config: pg.ClientConfig): Promise<void> {
  const client = new Client(config);
  await client.connect();
  try {
    await client.query(`
      insert into schema_components (component, version, completed_at)
      values ('server_aux', 1, now()::text)
      on conflict (component) do update
        set version = excluded.version, completed_at = excluded.completed_at
    `);
  } finally {
    await client.end();
  }
}
