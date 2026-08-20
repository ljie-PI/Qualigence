import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  canonicalizeIndex,
  parseIndex,
  runMigrate,
  type SelfHostedAdminConfig,
} from "@qualigence/admin-cli";
import { readSchemaVersion } from "@qualigence/postgres-runtime";
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
  }) {
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
      runBackup: async (_config, input) => {
        calls.push(`backup:${input.invocationId}:${input.targetSchemaVersion}`);
        return backupResult(input);
      },
      migrate: async (input) => {
        calls.push("migrate");
        return { fromVersion: 0, toVersion: 7, appliedVersions: [1, 2, 3, 4, 5, 6, 7] };
      },
    });

    expect(calls).toEqual(["backup:invocation-1:7", "migrate"]);
    expect(result.action).toBe("provisioned");
  });

  it("leaves committed data intact and the schema resumable after an injected step failure", async () => {
    await runMigrate(config(), { invocationId: "seed", runBackup: async (_config, input) => backupResult(input) });
    const client = new Client(config().postgres.admin);
    await client.connect();
    await client.query("delete from schema_migrations where version > 3");
    await client.query(`drop table
      local_run_intakes,
      execution_completions, execution_leases, runner_resume_tokens, runner_sessions,
      evidence_audit_events, evidence_local_only_records, evidence_key_rotations,
      evidence_capsule_entries, evidence_capsule_manifests, evidence_encryption_profiles,
      intelligence_applied_results, intelligence_results, intelligence_jobs,
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
        runBackup: async (_config, input) => backupResult(input),
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

  it("rejects malformed durable backup byte records and totals", () => {
    const valid = {
      version: "backup-index/v1" as const,
      createdAt: "2026-08-20T00:00:00.000Z",
      productVersion: "ticket-02-test",
      database: { dumpFile: "database.dump", format: "custom" as const, sizeBytes: 4, sha256: "a".repeat(64), schemaVersion: 0, snapshotId: "snapshot-1" },
      objects: [], tenants: [], objectCount: 0, totalObjectBytes: 0,
      migration: { invocationId: "index-test", targetDatabaseSha256: "b".repeat(64), targetSchemaVersion: 7 },
    };
    expect(parseIndex(canonicalizeIndex(valid))).toEqual(valid);
    expect(() => parseIndex(canonicalizeIndex({ ...valid, objectCount: 1 }))).toThrow(
      "object totals",
    );
  });
});
