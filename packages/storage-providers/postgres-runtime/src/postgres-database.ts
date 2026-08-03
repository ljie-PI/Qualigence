import type { Database } from "@qualigence/relational-kysely";

/**
 * The PostgreSQL runtime schema. Every tenant-owned logical table gains a
 * `tenant_id` column that participates in a composite primary key and in
 * tenant-inclusive composite foreign keys, and is protected by forced
 * Row-Level Security. The `schema_migrations` bookkeeping table is not
 * tenant-owned, and SQLite's virtual `sqlite_master` table does not exist.
 */
type TenantScopedTables = {
  [K in Exclude<
    keyof Database,
    "schema_migrations" | "sqlite_master"
  >]: Database[K] & { tenant_id: string };
};

export type PostgresDatabase = TenantScopedTables &
  Pick<Database, "schema_migrations">;
