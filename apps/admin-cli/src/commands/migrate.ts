import { createHash, randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import {
  acquirePostgresMigrationLock,
  migratePostgres,
  assertPostgresAuxSchema,
  markPostgresAuxSchemaCurrent,
  provisionPostgres,
  readSchemaVersion,
  type MigratePostgresInput,
  type PostgresMigrationResult,
} from "@qualigence/postgres-runtime";
import { SUPPORTED_SCHEMA_VERSION } from "@qualigence/relational-kysely";
import { provisionAuxSchema, type AuxDatabase } from "@qualigence/server";
import type { SelfHostedAdminConfig } from "./../config.js";
import { AdminCliError } from "./../errors.js";
import { SpawnPgToolRunner } from "../pg-tools.js";
import { runBackup, type BackupResult } from "./backup.js";
import { verifyBackupDirectory } from "../backup/backup-index.js";

const { Pool } = pg;

export interface MigrateResult {
  readonly action: "provisioned" | "migrated" | "already-current";
  readonly schemaVersion: number;
  readonly backupDirectory?: string;
  readonly appliedVersions?: readonly number[];
}

export interface MigrationBackupInput {
  readonly invocationId: string;
  readonly targetDatabaseSha256: string;
  readonly targetSchemaVersion: number;
}

export interface MigrateDeps {
  readonly invocationId?: string;
  readonly runBackup?: (
    config: SelfHostedAdminConfig,
    input: MigrationBackupInput,
  ) => Promise<BackupResult>;
  readonly migrate?: (input: MigratePostgresInput) => Promise<PostgresMigrationResult>;
  readonly afterStepSchema?: MigratePostgresInput["afterStepSchema"];
  readonly provisionAuxSchema?: typeof provisionAuxSchema;
}

/**
 * Run or verify the PostgreSQL migrations for a real deployment. On a fresh
 * database it provisions the frozen tenant-scoped schema, forced RLS, the
 * least-privilege Server/Worker roles and the Server aux tables (via the
 * `postgres-runtime` provisioning entrypoint). On an already-provisioned
 * database it verifies the applied schema version and never runs a destructive
 * migration implicitly — a version ahead of what this build supports is refused.
 */
export async function runMigrate(
  config: SelfHostedAdminConfig,
  deps: MigrateDeps = {},
): Promise<MigrateResult> {
  const invocationId = deps.invocationId ?? randomUUID();
  const targetDatabaseSha256 = createHash("sha256")
    .update(`${config.postgres.admin.host.toLowerCase()}:${config.postgres.admin.port}/${config.postgres.admin.database}`)
    .digest("hex");
  const backupInput: MigrationBackupInput = {
    invocationId,
    targetDatabaseSha256,
    targetSchemaVersion: SUPPORTED_SCHEMA_VERSION,
  };
  const backup = deps.runBackup ?? (async (backupConfig, binding) =>
    runBackup(backupConfig, {
      pgTool: new SpawnPgToolRunner(),
      migration: binding,
    }));
  const migrate = deps.migrate ?? migratePostgres;
  const lock = await acquirePostgresMigrationLock(config.postgres.admin);
  let fromVersion = 0;
  let backupResult: BackupResult;
  let migration: PostgresMigrationResult;
  try {
    fromVersion = await readSchemaVersion(config.postgres.admin);
    if (fromVersion > SUPPORTED_SCHEMA_VERSION) {
      throw new AdminCliError(
        "MigrationBlocked",
        `database schema version ${fromVersion} is newer than this build supports (${SUPPORTED_SCHEMA_VERSION})`,
        { details: { applied: fromVersion, supported: SUPPORTED_SCHEMA_VERSION } },
      );
    }
    if (fromVersion === SUPPORTED_SCHEMA_VERSION) {
      const current = new Kysely<AuxDatabase>({
        dialect: new PostgresDialect({ pool: new Pool(config.postgres.admin) }),
      });
      try {
        const marker = await sql<{ current: boolean }>`
          select coalesce((
            select version = 1 and completed_at is not null
              from schema_components where component = 'server_aux'
          ), false) as current
        `.execute(current).catch(() => ({ rows: [{ current: false }] }));
        if (marker.rows[0]?.current === true) {
          await assertPostgresAuxSchema(current, config.postgres.server.name);
          return { action: "already-current", schemaVersion: fromVersion };
        }
      } finally {
        await current.destroy();
      }
    }
    backupResult = await backup(config, backupInput);
    const durableIndex = await verifyBackupDirectory(backupResult.directory).catch((error) => {
      throw new AdminCliError("BackupFailed", "migration backup failed durable byte verification", {
        cause: error,
      });
    });
    if (durableIndex.migration === undefined || (
      durableIndex.migration.invocationId !== invocationId ||
      durableIndex.migration.targetDatabaseSha256 !== targetDatabaseSha256 ||
      durableIndex.migration.targetSchemaVersion !== SUPPORTED_SCHEMA_VERSION
    )) {
      throw new AdminCliError("BackupFailed", "migration backup binding does not match this invocation and target");
    }
    if (fromVersion === 0 && deps.migrate === undefined) {
      await provisionPostgres({
        admin: config.postgres.admin,
        roles: { server: config.postgres.server, worker: config.postgres.worker },
        acquireMigrationLock: false,
      });
      migration = {
        fromVersion,
        toVersion: SUPPORTED_SCHEMA_VERSION,
        appliedVersions: [1, 2, 3, 4, 5, 6, 7],
      };
    } else {
      migration = await migrate({
        admin: config.postgres.admin,
        acquireLock: false,
        roles: { server: config.postgres.server.name, worker: config.postgres.worker.name },
        ...(deps.afterStepSchema === undefined
          ? {}
          : { afterStepSchema: deps.afterStepSchema }),
      });
    }
    if (deps.migrate === undefined) {
      const aux = new Kysely<AuxDatabase>({
        dialect: new PostgresDialect({ pool: new Pool(config.postgres.admin) }),
      });
      try {
        await aux.transaction().execute(async (trx) => {
          await sql`
            do $cleanup$
            declare table_name text;
            begin
              foreach table_name in array array[
                'projects', 'targets', 'prd_revisions',
                'runner_enrollments', 'runner_principals'
              ] loop
                if to_regclass('public.' || table_name) is not null then
                  execute format('drop policy if exists tenant_isolation on %I', table_name);
                end if;
              end loop;
            end
            $cleanup$
          `.execute(trx);
          await (deps.provisionAuxSchema ?? provisionAuxSchema)(trx, config.postgres.server.name);
          await markPostgresAuxSchemaCurrent(trx, config.postgres.server.name);
        });
      } finally {
        await aux.destroy();
      }
    }
  } finally {
    await lock.release();
  }

  return {
    action: fromVersion === 0 ? "provisioned" : "migrated",
    schemaVersion: migration.toVersion,
    backupDirectory: backupResult.directory,
    appliedVersions: migration.appliedVersions,
  };
}
