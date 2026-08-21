import {
  createRuntimeRoles,
  migratePostgres,
  provisionPostgres,
  type PostgresConnectionConfig,
} from "@qualigence/postgres-runtime";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { startPostgres, type StartedPostgres } from "./docker-container.js";

const { Pool } = pg;

export interface PostgresFixture {
  readonly container: StartedPostgres;
  readonly adminConfig: PostgresConnectionConfig;
  readonly serverConfig: PostgresConnectionConfig;
  readonly workerConfig: PostgresConnectionConfig;
  stop(): Promise<void>;
}

const SERVER_ROLE = "qualigence_server";
const SERVER_PASSWORD = "server_pw";
const WORKER_ROLE = "qualigence_worker";
const WORKER_PASSWORD = "worker_pw";

/**
 * Start a real PostgreSQL container, provision the tenant-scoped schema with
 * forced RLS, and create the least-privilege Server and Worker roles. Returns
 * connection configs for the owner/admin role plus the two runtime roles.
 */
export async function setupPostgresFixture(
  options: { readonly targetVersion?: number } = {},
): Promise<PostgresFixture> {
  const container = await startPostgres();
  const adminConfig: PostgresConnectionConfig = {
    host: container.host,
    port: container.port,
    database: container.database,
    user: container.superuser,
    password: container.password,
  };

  const roles = {
    server: { name: SERVER_ROLE, password: SERVER_PASSWORD },
    worker: { name: WORKER_ROLE, password: WORKER_PASSWORD },
  };
  if (options.targetVersion === undefined) {
    await provisionPostgres({ admin: adminConfig, roles });
  } else {
    const db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new Pool(adminConfig) }),
    });
    try {
      await createRuntimeRoles(db, {
        database: adminConfig.database,
        server: roles.server,
        worker: roles.worker,
      });
    } finally {
      await db.destroy();
    }
    await migratePostgres({
      admin: adminConfig,
      targetVersion: options.targetVersion,
      roles: { server: roles.server.name, worker: roles.worker.name },
    });
  }

  const serverConfig: PostgresConnectionConfig = {
    ...adminConfig,
    user: SERVER_ROLE,
    password: SERVER_PASSWORD,
  };
  const workerConfig: PostgresConnectionConfig = {
    ...adminConfig,
    user: WORKER_ROLE,
    password: WORKER_PASSWORD,
  };

  return {
    container,
    adminConfig,
    serverConfig,
    workerConfig,
    stop: () => container.stop(),
  };
}

export interface RunRowInput {
  readonly tenantId: string;
  readonly runId: string;
}

/** A minimal valid `execution_runs` row for isolation tests. */
export function executionRunRow(input: RunRowInput): Record<string, unknown> {
  return {
    tenant_id: input.tenantId,
    run_id: input.runId,
    job_id: `job-${input.runId}`,
    target_kind: "web",
    objective: "verify tenant isolation",
    status: "running",
    next_sequence_number: 0,
    created_at: "2026-08-01T00:00:00.000Z",
  };
}

/** A minimal valid `intelligence_jobs` row for worker-scope tests. */
export function intelligenceJobRow(input: RunRowInput): Record<string, unknown> {
  return {
    tenant_id: input.tenantId,
    job_id: `job-${input.runId}`,
    job_type: "reproduce",
    schema_version: "intelligence-job/v1",
    project_id: "project-1",
    aggregate_type: "investigation",
    aggregate_id: "case-1",
    base_aggregate_version: 0,
    model_profile_id: "profile-1",
    data_policy_id: "policy-1",
    priority: "normal",
    idempotency_key: `idem-${input.tenantId}-${input.runId}`,
    causation_id: "cause-1",
    expected_result_schema: "intelligence-result/v1",
    job_json: "{}",
    created_at: "2026-08-01T00:00:00.000Z",
  };
}
