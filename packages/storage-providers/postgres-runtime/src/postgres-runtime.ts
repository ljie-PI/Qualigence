import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import {
  RELATIONAL_SCHEMA_VERSIONS,
  SUPPORTED_SCHEMA_VERSION,
} from "@qualigence/relational-kysely";
import type { PostgresDatabase } from "./postgres-database.js";
import { createTenantSchemaTables } from "./postgres-schema.js";
import {
  applyRowLevelSecurity,
  createRuntimeRoles,
  type PostgresRuntimeRoles,
} from "./migrations/row-level-security.js";
import {
  PostgresTenantTransactionProvider,
  POSTGRES_MIGRATION_LOCK_KEY,
  type TenantTransactionProvider,
} from "./tenant-transaction.js";

const { Pool } = pg;
const REQUIRED_AUX_SCHEMA_COMPONENT = "server_aux";
const REQUIRED_AUX_SCHEMA_VERSION = 1;

export type PostgresSchemaErrorCode =
  | "SchemaMalformed"
  | "SchemaAhead"
  | "SchemaBehind";

export class PostgresSchemaError extends Error {
  constructor(
    readonly code: PostgresSchemaErrorCode,
    message: string,
    readonly appliedVersion?: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "PostgresSchemaError";
  }
}

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
  /** False only when the caller already owns the exclusive migration lock. */
  readonly acquireMigrationLock?: boolean;
}

export interface PostgresMigrationStep {
  readonly version: number;
  readonly name: string;
}

export interface MigratePostgresInput {
  readonly admin: PostgresConnectionConfig;
  readonly targetVersion?: number;
  readonly acquireLock?: boolean;
  readonly beforeStep?: (step: PostgresMigrationStep) => void | Promise<void>;
  readonly afterStepSchema?: (step: PostgresMigrationStep) => void | Promise<void>;
  readonly roles?: PostgresRuntimeRoles;
}

export interface PostgresMigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly appliedVersions: readonly number[];
}

export interface PostgresMigrationLock {
  release(): Promise<void>;
}

export async function acquirePostgresMigrationLock(
  config: PostgresConnectionConfig,
): Promise<PostgresMigrationLock> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [POSTGRES_MIGRATION_LOCK_KEY]);
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return {
    release: async () => {
      try {
        await client.query("select pg_advisory_unlock($1)", [POSTGRES_MIGRATION_LOCK_KEY]);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}

export async function acquirePostgresOperationLock(client: pg.PoolClient): Promise<void> {
  await client.query("select pg_advisory_xact_lock_shared($1)", [POSTGRES_MIGRATION_LOCK_KEY]);
}

export async function migratePostgres(
  input: MigratePostgresInput,
): Promise<PostgresMigrationResult> {
  const targetVersion = input.targetVersion ?? SUPPORTED_SCHEMA_VERSION;
  if (!Number.isInteger(targetVersion) || targetVersion < 1 || targetVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new PostgresSchemaError(
      "SchemaAhead",
      `unsupported migration target ${targetVersion}`,
      targetVersion,
    );
  }
  const lock = input.acquireLock === false
    ? undefined
    : await acquirePostgresMigrationLock(input.admin);
  const db = createKysely(input.admin);
  try {
    await ensureSchemaComponentsTable(db);
    const fromVersion = await inspectSchemaVersion(db);
    if (fromVersion > targetVersion) {
      throw new PostgresSchemaError(
        "SchemaAhead",
        `database schema version ${fromVersion} is newer than target ${targetVersion}`,
        fromVersion,
      );
    }
    const appliedVersions: number[] = [];
    if (fromVersion < targetVersion) {
      await markAuxSchemaIncomplete(db);
    }
    for (const step of RELATIONAL_SCHEMA_VERSIONS) {
      if (step.version <= fromVersion || step.version > targetVersion) continue;
      await input.beforeStep?.({ version: step.version, name: step.name });
      await db.transaction().execute(async (trx) => {
        await createTenantSchemaTables(trx, step.tables);
        if (input.roles !== undefined) {
          await applyRowLevelSecurity(trx, input.roles, step.tables);
        }
        await input.afterStepSchema?.({ version: step.version, name: step.name });
        await trx
          .insertInto("schema_migrations")
          .values({
            version: step.version,
            name: step.name,
            applied_at: new Date().toISOString(),
          })
          .execute();
      });
      appliedVersions.push(step.version);
    }
    if (input.roles !== undefined) {
      await applyRowLevelSecurity(db, input.roles);
    }
    return { fromVersion, toVersion: targetVersion, appliedVersions };
  } finally {
    await db.destroy();
    await lock?.release();
  }
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
    await createRuntimeRoles(db, {
      database: input.admin.database,
      server: input.roles.server,
      worker: input.roles.worker,
    });
    const roleNames: PostgresRuntimeRoles = {
      server: input.roles.server.name,
      worker: input.roles.worker.name,
    };
    await migratePostgres({
      admin: input.admin,
      roles: roleNames,
      ...(input.acquireMigrationLock === undefined
        ? {}
        : { acquireLock: input.acquireMigrationLock }),
    });
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
    return await inspectSchemaVersion(db);
  } finally {
    await db.destroy();
  }
}

export async function assertPostgresSchemaCurrent(
  config: PostgresConnectionConfig,
): Promise<void> {
  const db = createKysely(config);
  try {
    await db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock_shared(${POSTGRES_MIGRATION_LOCK_KEY})`.execute(trx);
      const version = await inspectSchemaVersion(trx);
      if (version < SUPPORTED_SCHEMA_VERSION) {
        throw new PostgresSchemaError(
          "SchemaBehind",
          `database schema version ${version} is behind ${SUPPORTED_SCHEMA_VERSION}`,
          version,
        );
      }
      if (version > SUPPORTED_SCHEMA_VERSION) {
        throw new PostgresSchemaError(
          "SchemaAhead",
          `database schema version ${version} is newer than ${SUPPORTED_SCHEMA_VERSION}`,
          version,
        );
      }
      const auxCurrent = await isAuxSchemaCurrent(trx);
      if (!auxCurrent) {
        throw new PostgresSchemaError(
          "SchemaBehind",
          "required Server auxiliary schema is incomplete",
          version,
        );
      }
    });
  } finally {
    await db.destroy();
  }
}

async function ensureSchemaComponentsTable(db: Kysely<PostgresDatabase>): Promise<void> {
  await sql`
    create table if not exists schema_components (
      component text primary key,
      version integer not null,
      completed_at text
    )
  `.execute(db);
}

async function markAuxSchemaIncomplete(db: Kysely<PostgresDatabase>): Promise<void> {
  await sql`
    insert into schema_components (component, version, completed_at)
    values (${REQUIRED_AUX_SCHEMA_COMPONENT}, 0, null)
    on conflict (component) do update set version = 0, completed_at = null
  `.execute(db);
}

async function isAuxSchemaCurrent(db: Kysely<PostgresDatabase>): Promise<boolean> {
  const table = await sql<{ exists: boolean }>`
    select to_regclass('public.schema_components') is not null as exists
  `.execute(db);
  if (table.rows[0]?.exists !== true) return false;
  const row = await sql<{ version: number; completed_at: string | null }>`
    select version, completed_at from schema_components
    where component = ${REQUIRED_AUX_SCHEMA_COMPONENT}
  `.execute(db);
  return row.rows[0]?.version === REQUIRED_AUX_SCHEMA_VERSION && row.rows[0].completed_at !== null;
}

async function inspectSchemaVersion(db: Kysely<PostgresDatabase>): Promise<number> {
  const exists = await sql<{ exists: boolean }>`
    select to_regclass('public.schema_migrations') is not null as exists
  `.execute(db);
  if (exists.rows[0]?.exists !== true) return 0;

  const rows = await db
    .selectFrom("schema_migrations")
    .select(["version", "name"])
    .orderBy("version")
    .execute();
  const lastVersion = Number(rows.at(-1)?.version ?? 0);
  if (lastVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new PostgresSchemaError(
      "SchemaAhead",
      `database schema version ${lastVersion} is newer than ${SUPPORTED_SCHEMA_VERSION}`,
      lastVersion,
    );
  }
  for (const [index, row] of rows.entries()) {
    const expected = RELATIONAL_SCHEMA_VERSIONS[index];
    if (
      expected === undefined ||
      row.version !== index + 1 ||
      (row.name !== expected.name && row.name !== `relational-v${row.version}`)
    ) {
      throw new PostgresSchemaError(
        "SchemaMalformed",
        "schema migration history is not a contiguous supported sequence",
        Number(row.version),
      );
    }
    for (const table of expected.tables) {
      const present = await sql<{ exists: boolean }>`
        select to_regclass(${`public.${table}`}) is not null as exists
      `.execute(db);
      if (present.rows[0]?.exists !== true) {
        throw new PostgresSchemaError(
          "SchemaMalformed",
          `schema version ${row.version} is missing table ${table}`,
          Number(row.version),
        );
      }
    }
  }
  return rows.length;
}

export { sql };
export type { Transaction };
