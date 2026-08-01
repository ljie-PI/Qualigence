import pg from "pg";
import { readSchemaVersion } from "@qualigence/postgres-runtime";
import { SUPPORTED_SCHEMA_VERSION } from "@qualigence/relational-kysely";
import { bootstrapServerDatabase } from "@qualigence/server";
import type { SelfHostedAdminConfig } from "./../config.js";
import { AdminCliError } from "./../errors.js";

const { Client } = pg;

export interface MigrateResult {
  readonly action: "provisioned" | "already-current";
  readonly schemaVersion: number;
}

/** True when the frozen relational schema has not been created yet. */
async function isUnprovisioned(config: SelfHostedAdminConfig): Promise<boolean> {
  const client = new Client(config.postgres.admin);
  try {
    await client.connect();
    const row = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
    );
    return row.rows[0]?.exists !== true;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Run or verify the PostgreSQL migrations for a real deployment. On a fresh
 * database it provisions the frozen tenant-scoped schema, forced RLS, the
 * least-privilege Server/Worker roles and the Server aux tables (via the
 * `postgres-runtime` provisioning entrypoint). On an already-provisioned
 * database it verifies the applied schema version and never runs a destructive
 * migration implicitly — a version ahead of what this build supports is refused.
 */
export async function runMigrate(config: SelfHostedAdminConfig): Promise<MigrateResult> {
  if (await isUnprovisioned(config)) {
    await bootstrapServerDatabase({
      admin: config.postgres.admin,
      roles: {
        server: config.postgres.server,
        worker: config.postgres.worker,
      },
    });
    const version = await readSchemaVersion(config.postgres.admin);
    return { action: "provisioned", schemaVersion: version };
  }

  const version = await readSchemaVersion(config.postgres.admin);
  if (version > SUPPORTED_SCHEMA_VERSION) {
    throw new AdminCliError(
      "MigrationBlocked",
      `database schema version ${version} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
      { details: { applied: version, supported: SUPPORTED_SCHEMA_VERSION } },
    );
  }
  if (version < SUPPORTED_SCHEMA_VERSION) {
    // The frozen relational schema is created atomically by provisioning; there
    // is no partial forward migration path in this milestone.
    throw new AdminCliError(
      "MigrationBlocked",
      `database schema version ${version} is behind ${SUPPORTED_SCHEMA_VERSION} and cannot be upgraded in place`,
      { details: { applied: version, supported: SUPPORTED_SCHEMA_VERSION } },
    );
  }
  return { action: "already-current", schemaVersion: version };
}
