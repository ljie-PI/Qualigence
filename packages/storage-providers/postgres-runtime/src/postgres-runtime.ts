import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import { SUPPORTED_SCHEMA_VERSION } from "@qualigence/relational-kysely";
import type { PostgresDatabase } from "./postgres-database.js";
import { createTenantSchema } from "./postgres-schema.js";
import {
  applyRowLevelSecurity,
  createRuntimeRoles,
  type PostgresRuntimeRoles,
} from "./migrations/row-level-security.js";
import {
  PostgresTenantTransactionProvider,
  type TenantTransactionProvider,
} from "./tenant-transaction.js";

const { Pool } = pg;

export interface PostgresConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly max?: number;
}

function createKysely(
  config: PostgresConnectionConfig,
): Kysely<PostgresDatabase> {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.max ?? 4,
  });
  return new Kysely<PostgresDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * Create a tenant-scoped runtime. The returned provider only ever exposes a
 * transaction whose `app.tenant_id` GUC has already been set, so no caller can
 * obtain an unscoped application transaction.
 */
export function createPostgresRuntime(
  config: PostgresConnectionConfig,
): TenantTransactionProvider {
  return new PostgresTenantTransactionProvider(createKysely(config));
}

export interface ProvisionPostgresInput {
  /** Owner/migration connection (offline role); never used at runtime. */
  readonly admin: PostgresConnectionConfig;
  readonly roles: {
    readonly server: { readonly name: string; readonly password: string };
    readonly worker: { readonly name: string; readonly password: string };
  };
}

/**
 * Create the tenant-scoped schema and forced RLS policies, and provision the
 * least-privilege Server and Worker roles. Run once, offline, by the owner
 * role; the runtime application roles never hold these privileges.
 */
export async function provisionPostgres(
  input: ProvisionPostgresInput,
): Promise<void> {
  const db = createKysely(input.admin);
  try {
    await createTenantSchema(db);
    for (let version = 1; version <= SUPPORTED_SCHEMA_VERSION; version += 1) {
      await db
        .insertInto("schema_migrations")
        .values({
          version,
          name: `relational-v${version}`,
          applied_at: new Date().toISOString(),
        })
        .execute();
    }
    await createRuntimeRoles(db, {
      database: input.admin.database,
      server: input.roles.server,
      worker: input.roles.worker,
    });
    const roleNames: PostgresRuntimeRoles = {
      server: input.roles.server.name,
      worker: input.roles.worker.name,
    };
    await applyRowLevelSecurity(db, roleNames);
  } finally {
    await db.destroy();
  }
}

/** Read the applied logical schema version. */
export async function readSchemaVersion(
  config: PostgresConnectionConfig,
): Promise<number> {
  const db = createKysely(config);
  try {
    const row = await db
      .selectFrom("schema_migrations")
      .select((builder) => builder.fn.max("version").as("version"))
      .executeTakeFirst();
    return Number(row?.version ?? 0);
  } finally {
    await db.destroy();
  }
}

export { sql };
export type { Transaction };
