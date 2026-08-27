import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  backupTargetBinding,
  canonicalizeIndex,
  parseIndex,
  runMigrate,
  type SelfHostedAdminConfig,
} from "@qualigence/admin-cli";
import {
  assertPostgresSchemaCurrent,
  readSchemaVersion,
  PostgresSchemaError,
} from "@qualigence/postgres-runtime";
import { main as serverMain } from "../../../apps/server/src/main.js";
import type { ServerConfig } from "../../../apps/server/src/config.js";
import { main as workerMain } from "../../../apps/intelligence-worker/src/main.js";
import { dockerAvailable, startPostgres, type StartedPostgres } from "../../helpers/docker-container.js";

const { Client } = pg;

describe.skipIf(!dockerAvailable())("Admin CLI offline PostgreSQL migration", () => {
  let postgres: StartedPostgres;
  let backupDir: string;

  beforeAll(async () => {
    postgres = await startPostgres();
    backupDir = await mkdtemp(join(process.cwd(), ".tmp-migrate-"));
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
    await rm(backupDir, { recursive: true, force: true });
  });

  function config(): SelfHostedAdminConfig {
    return {
      postgres: {
        admin: {
          host: postgres.host,
          port: postgres.port,
          database: postgres.database,
          user: postgres.superuser,
          password: postgres.password,
        },
        server: { name: "ticket02_server", password: "server_pw" },
        worker: { name: "ticket02_worker", password: "worker_pw" },
      },
      s3: {
        region: "us-east-1",
        endpoint: "http://127.0.0.1:1",
        bucket: "unused",
        accessKeyId: "unused",
        secretAccessKey: "unused",
        forcePathStyle: true,
      },
      kms: { rootKey: new Uint8Array(32) },
      server: { baseUrl: "http://127.0.0.1:1" },
      backupDir,
      productVersion: "ticket-02-test",
      secretFiles: [],
    };
  }

  async function backupResult(input: {
    readonly invocationId: string;
    readonly targetDatabaseSha256: string;
    readonly targetSchemaVersion: number;
  }, backupConfig: SelfHostedAdminConfig = config()) {
    const directory = join(backupDir, input.invocationId);
    const index = {
        version: "backup-index/v1" as const,
        createdAt: "2026-08-20T00:00:00.000Z",
        productVersion: "ticket-02-test",
        database: {
          dumpFile: "database.dump",
          format: "custom" as const,
          sizeBytes: 4,
          sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
          schemaVersion: 0,
          snapshotId: "snapshot-1",
        },
        target: backupTargetBinding(backupConfig),
        objects: [],
        tenants: [],
        objectCount: 0,
        totalObjectBytes: 0,
        migration: input,
      };
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "database.dump"), new Uint8Array([1, 2, 3, 4]));
    await writeFile(join(directory, "backup-index.json"), canonicalizeIndex(index), "utf8");
    await writeFile(join(directory, "backup-complete"), "complete\n", "utf8");
    return { directory, index };
  }

  it("takes a fresh target-bound verified backup under the offline lock before upgrading", async () => {
    const calls: string[] = [];
    const result = await runMigrate(config(), {
      invocationId: "invocation-1",
      runBackup: async (backupConfig, input) => {
        calls.push(`backup:${input.invocationId}:${input.targetSchemaVersion}`);
        return backupResult(input, backupConfig);
      },
      migrate: async (input) => {
        calls.push("migrate");
        return { fromVersion: 0, toVersion: 15, appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] };
      },
    });

    expect(calls).toEqual(["backup:invocation-1:15", "migrate"]);
    expect(result.action).toBe("provisioned");
    expect(result).toMatchObject({ schemaVersion: 15, appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] });
  });

  it("leaves committed data intact and the schema resumable after an injected step failure", async () => {
    await runMigrate(config(), { invocationId: "seed", runBackup: async (backupConfig, input) => backupResult(input, backupConfig) });
    const client = new Client(config().postgres.admin);
    await client.connect();
    await client.query("delete from schema_migrations where version > 3");
    await client.query(`drop table
      local_run_intakes,
      execution_completions, execution_leases, runner_resume_tokens, runner_sessions,
      evidence_audit_events, evidence_local_only_records, evidence_key_rotations,
      evidence_capsule_entries, evidence_capsule_manifests, evidence_encryption_profiles,
      intelligence_result_dispositions, intelligence_result_wakeups, intelligence_result_inbox,
      intelligence_leases, intelligence_applied_results, intelligence_results, intelligence_jobs,
      review_resolutions, review_claims, review_tasks, investigation_handoffs,
      investigation_bug_episodes, investigation_attempts, investigation_cases,
      benchmark_reports, exploration_checkpoints, benchmark_attempts, benchmark_runs
      cascade`);
    await client.query(
      "insert into execution_runs (tenant_id, run_id, job_id, target_kind, objective, status, next_sequence_number, created_at) values ('tenant-a','run-safe','job-safe','web','preserved','running',0,'2026-08-20T00:00:00.000Z')",
    );
    await client.end();

    await expect(
      runMigrate(config(), {
        invocationId: "failure",
        runBackup: async (backupConfig, input) => backupResult(input, backupConfig),
        afterStepSchema: ({ version }) => {
          if (version === 5) throw new Error("injected failure");
        },
      }),
    ).rejects.toThrow("injected failure");
    expect(await readSchemaVersion(config().postgres.admin)).toBe(4);

    const verify = new Client(config().postgres.admin);
    await verify.connect();
    const row = await verify.query("select objective from execution_runs where run_id = 'run-safe'");
    await verify.end();
    expect(row.rows[0]?.objective).toBe("preserved");
  }, 120_000);

  it("durably rejects a relationally-current schema until failed auxiliary provisioning is retried", async () => {
    const isolated = await startPostgres();
    const isolatedConfig: SelfHostedAdminConfig = {
      ...config(),
      postgres: {
        admin: {
          host: isolated.host,
          port: isolated.port,
          database: isolated.database,
          user: isolated.superuser,
          password: isolated.password,
        },
        server: { name: "aux_failure_server", password: "server_pw" },
        worker: { name: "aux_failure_worker", password: "worker_pw" },
      },
    };
    try {
      await expect(runMigrate(isolatedConfig, {
        invocationId: "aux-failure",
        runBackup: async (backupConfig, input) => backupResult(input, backupConfig),
        provisionAuxSchema: async () => {
          throw new Error("injected auxiliary schema failure");
        },
      })).rejects.toThrow("injected auxiliary schema failure");
      expect(await readSchemaVersion(isolatedConfig.postgres.admin)).toBe(15);
      await expect(assertPostgresSchemaCurrent(
        isolatedConfig.postgres.admin,
        isolatedConfig.postgres.server.name,
      )).rejects.toMatchObject({
        code: "SchemaBehind",
      } satisfies Partial<PostgresSchemaError>);

      const repaired = await runMigrate(isolatedConfig, {
        invocationId: "aux-retry",
        runBackup: async (backupConfig, input) => backupResult(input, backupConfig),
      });
      expect(repaired.action).toBe("migrated");
      await expect(assertPostgresSchemaCurrent(
        isolatedConfig.postgres.admin,
        isolatedConfig.postgres.server.name,
      )).resolves.toBeUndefined();
    } finally {
      await isolated.stop();
    }
  }, 120_000);

  it("rejects auxiliary column, RLS, policy, and grant corruption at startup", async () => {
    const isolated = await startPostgres();
    const isolatedConfig = configFor(isolated, "aux_guard");
    try {
      await runMigrate(isolatedConfig, {
        invocationId: "aux-guard-seed",
        runBackup: async (backupConfig, input) => backupResult(input, backupConfig),
      });
      const serverConfig = runtimeConfig(isolatedConfig, "server");
      const workerConfig = runtimeConfig(isolatedConfig, "worker");
      await expect(assertPostgresSchemaCurrent(serverConfig, "aux_guard_server")).resolves.toBeUndefined();
      await expect(assertPostgresSchemaCurrent(workerConfig, "aux_guard_server")).resolves.toBeUndefined();

      const admin = new Client(isolatedConfig.postgres.admin);
      await admin.connect();
      try {
        await admin.query("revoke select on runner_principals from aux_guard_server");
        await expect(assertPostgresSchemaCurrent(serverConfig, "aux_guard_server")).rejects.toMatchObject({
          code: "SchemaMalformed",
        });
        await admin.query("grant select on runner_principals to aux_guard_server");

        await admin.query("drop policy tenant_isolation on prd_revisions");
        await expect(assertPostgresSchemaCurrent(workerConfig, "aux_guard_server")).rejects.toMatchObject({
          code: "SchemaMalformed",
        });
        await admin.query(`create policy tenant_isolation on prd_revisions
          to aux_guard_server
          using (tenant_id = current_setting('app.tenant_id', true))
          with check (tenant_id = current_setting('app.tenant_id', true))`);

        await admin.query("alter table targets disable row level security");
        await expect(assertPostgresSchemaCurrent(serverConfig, "aux_guard_server")).rejects.toMatchObject({
          code: "SchemaMalformed",
        });
        await admin.query("alter table targets enable row level security");

        await admin.query("alter table runner_enrollments drop column token_hash");
        await expect(assertPostgresSchemaCurrent(workerConfig, "aux_guard_server")).rejects.toMatchObject({
          code: "SchemaMalformed",
        });
      } finally {
        await admin.end();
      }
    } finally {
      await isolated.stop();
    }
  }, 120_000);

  it("rejects Server and Worker startup when auxiliary policy and grants target the Worker role", async () => {
    const isolated = await startPostgres();
    const isolatedConfig = configFor(isolated, "aux_worker_authority");
    try {
      await runMigrate(isolatedConfig, {
        invocationId: "aux-worker-authority-seed",
        runBackup: async (backupConfig, input) => backupResult(input, backupConfig),
      });
      const admin = new Client(isolatedConfig.postgres.admin);
      await admin.connect();
      try {
        await admin.query("drop policy tenant_isolation on runner_principals");
        await admin.query(`create policy tenant_isolation on runner_principals
          to aux_worker_authority_worker
          using (tenant_id = current_setting('app.tenant_id', true))
          with check (tenant_id = current_setting('app.tenant_id', true))`);
        await admin.query("revoke all on runner_principals from aux_worker_authority_server");
        await admin.query(
          "grant select, insert, update, delete on runner_principals to aux_worker_authority_worker",
        );
      } finally {
        await admin.end();
      }

      const assertConfiguredServerRole = async (
        postgres: Parameters<typeof assertPostgresSchemaCurrent>[0],
        serverRole: string,
      ): Promise<void> => {
        expect(serverRole).toBe("aux_worker_authority_server");
        await assertPostgresSchemaCurrent(postgres, serverRole);
      };
      await expect(serverMain(
        {},
        assertConfiguredServerRole,
        () => serverStartupConfig(isolatedConfig),
      )).rejects.toMatchObject({ code: "SchemaMalformed" });
      await expect(workerMain(
        workerStartupEnv(isolatedConfig),
        assertConfiguredServerRole,
      )).rejects.toMatchObject({ code: "SchemaMalformed" });
    } finally {
      await isolated.stop();
    }
  }, 120_000);

  it("does not bless a malformed pre-existing auxiliary table through IF NOT EXISTS", async () => {
    const isolated = await startPostgres();
    const isolatedConfig = configFor(isolated, "aux_malformed");
    const admin = new Client(isolatedConfig.postgres.admin);
    let adminConnected = false;
    try {
      await admin.connect();
      adminConnected = true;
      await admin.query("create table projects (tenant_id text not null)");
      await admin.end();
      adminConnected = false;

      await expect(runMigrate(isolatedConfig, {
        invocationId: "aux-malformed",
        runBackup: async (backupConfig, input) => backupResult(input, backupConfig),
      })).rejects.toMatchObject({ code: "SchemaMalformed" });

      const verify = new Client(isolatedConfig.postgres.admin);
      await verify.connect();
      const marker = await verify.query<{ version: number; completed_at: string | null }>(
        "select version, completed_at from schema_components where component = 'server_aux'",
      );
      await verify.end();
      expect(marker.rows[0]).toEqual({ version: 0, completed_at: null });
    } finally {
      if (adminConnected) {
        await admin.end().catch(() => undefined);
      }
      await isolated.stop();
    }
  }, 120_000);

  it("rejects malformed durable backup byte records and totals", () => {
    const valid = {
      version: "backup-index/v1" as const,
      createdAt: "2026-08-20T00:00:00.000Z",
      productVersion: "ticket-02-test",
      database: { dumpFile: "database.dump", format: "custom" as const, sizeBytes: 4, sha256: "a".repeat(64), schemaVersion: 0, snapshotId: "snapshot-1" },
      target: { databaseSha256: "c".repeat(64), objectStoreSha256: "d".repeat(64) },
      objects: [], tenants: [], objectCount: 0, totalObjectBytes: 0,
      migration: { invocationId: "index-test", targetDatabaseSha256: "b".repeat(64), targetSchemaVersion: 7 },
    };
    expect(parseIndex(canonicalizeIndex(valid))).toEqual(valid);
    expect(() => parseIndex(canonicalizeIndex({ ...valid, objectCount: 1 }))).toThrow(
      "object totals",
    );
  });

  function configFor(instance: StartedPostgres, rolePrefix: string): SelfHostedAdminConfig {
    return {
      ...config(),
      postgres: {
        admin: {
          host: instance.host,
          port: instance.port,
          database: instance.database,
          user: instance.superuser,
          password: instance.password,
        },
        server: { name: `${rolePrefix}_server`, password: "server_pw" },
        worker: { name: `${rolePrefix}_worker`, password: "worker_pw" },
      },
    };
  }

  function runtimeConfig(
    input: SelfHostedAdminConfig,
    role: "server" | "worker",
  ) {
    return {
      ...input.postgres.admin,
      user: input.postgres[role].name,
      password: input.postgres[role].password,
    };
  }

  function serverStartupConfig(input: SelfHostedAdminConfig): ServerConfig {
    return {
      host: "127.0.0.1",
      port: 8080,
      postgres: runtimeConfig(input, "server"),
      intelligenceResultConsumer: {
        enabled: false,
        consumerId: "server-test",
        tenantBatchSize: 1,
        resultBatchSize: 1,
        leaseDurationMs: 30_000,
        idleBackoffMs: 1_000,
        errorBackoffMs: 1_000,
        maximumBackoffMs: 30_000,
      },
      oidc: {
        issuer: "https://issuer.example",
        audience: "qualigence",
        allowedAlgorithms: ["RS256" as const],
        jwks: { kind: "static", jwksJson: "[]" },
        claimMapper: {
          tenantClaim: "tenant",
          rolesClaim: "roles",
          allowedTenants: ["tenant-a"],
          roleMap: { admin: "admin" as const },
        },
      },
      runnerCa: { certificatePem: "unused", privateKeyPem: "unused" },
      artifactDataDir: ".tmp-test-artifacts",
    };
  }

  function workerStartupEnv(input: SelfHostedAdminConfig): NodeJS.ProcessEnv {
    const postgres = runtimeConfig(input, "worker");
    return {
      WORKER_PG_HOST: postgres.host,
      WORKER_PG_PORT: String(postgres.port),
      WORKER_PG_DATABASE: postgres.database,
      WORKER_PG_USER: postgres.user,
      WORKER_PG_PASSWORD: postgres.password,
      WORKER_PG_SERVER_ROLE: input.postgres.server.name,
      WORKER_S3_BUCKET: "unused",
      WORKER_S3_ACCESS_KEY_ID: "unused",
      WORKER_S3_SECRET_ACCESS_KEY: "unused",
      WORKER_MODEL_BASE_URL: "https://model.example",
      WORKER_MODEL_API_KEY: "unused",
      WORKER_MODEL_NAME: "unused",
    };
  }
});
