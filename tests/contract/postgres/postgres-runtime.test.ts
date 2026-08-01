import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  createPostgresRuntime,
  readSchemaVersion,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import {
  relationalTableNames,
  tenantOwnedTableNames,
} from "@qualigence/relational-kysely";
import { dockerAvailable } from "../../helpers/docker-container.js";
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
    expect(await readSchemaVersion(fixture.adminConfig)).toBe(5);
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
});
