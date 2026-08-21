import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  emptyBucket,
  getObjectBytes,
  putObjectBytes,
  runBackup,
  runMigrate,
  runRestore,
  sha256Hex,
  type SelfHostedAdminConfig,
  verifyBackupDirectory,
} from "@qualigence/admin-cli";
import {
  createRuntimeRoles,
  migratePostgres,
  readSchemaVersion,
  type PostgresConnectionConfig,
} from "@qualigence/postgres-runtime";
import {
  dockerAvailable,
  startPostgres,
  startMinio,
  type StartedMinio,
} from "../../helpers/docker-container.js";
import type { PostgresFixture } from "../../helpers/postgres-fixture.js";
import { dockerExecPgToolRunner } from "../../helpers/docker-pg-tool-runner.js";
import pg from "pg";

const { Client, Pool } = pg;
const BUCKET = "qualigence-artifacts";
const OLD_SCHEMA_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 7;
const MIGRATION_INVOCATION_ID = "ticket-36-forward-upgrade";
const SERVER_ROLE = "qualigence_server";
const SERVER_PASSWORD = "server_pw";
const WORKER_ROLE = "qualigence_worker";
const WORKER_PASSWORD = "worker_pw";

interface ExecutionRunSnapshot {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly job_id: string;
  readonly target_kind: string;
  readonly objective: string;
  readonly status: string;
  readonly next_sequence_number: number;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly error_code: string | null;
}

interface ArtifactManifestSnapshot {
  readonly tenant_id: string;
  readonly artifact_id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly media_type: string;
  readonly relative_path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly created_at: string;
}

interface PersistenceSnapshot {
  readonly executionRuns: readonly ExecutionRunSnapshot[];
  readonly artifactManifests: readonly ArtifactManifestSnapshot[];
  readonly objects: readonly { readonly key: string; readonly bytes: readonly number[] }[];
}

const SEEDED_EXECUTION_RUNS: readonly ExecutionRunSnapshot[] = [
  {
    tenant_id: "tenant-a",
    run_id: "run-a-1",
    job_id: "job-run-a-1",
    target_kind: "web",
    objective: "verify tenant isolation",
    status: "running",
    next_sequence_number: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    completed_at: null,
    error_code: null,
  },
  {
    tenant_id: "tenant-a",
    run_id: "run-a-2",
    job_id: "job-run-a-2",
    target_kind: "web",
    objective: "verify tenant isolation",
    status: "running",
    next_sequence_number: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    completed_at: null,
    error_code: null,
  },
  {
    tenant_id: "tenant-b",
    run_id: "run-b-1",
    job_id: "job-run-b-1",
    target_kind: "web",
    objective: "verify tenant isolation",
    status: "running",
    next_sequence_number: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    completed_at: null,
    error_code: null,
  },
];

const EXPECTED_EXECUTION_RUNS: readonly ExecutionRunSnapshot[] = [
  {
    tenant_id: "tenant-a",
    run_id: "run-a-1",
    job_id: "job-run-a-1",
    target_kind: "web",
    objective: "verify tenant isolation",
    status: "running",
    next_sequence_number: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    completed_at: null,
    error_code: null,
  },
  {
    tenant_id: "tenant-a",
    run_id: "run-a-2",
    job_id: "job-run-a-2",
    target_kind: "web",
    objective: "verify tenant isolation",
    status: "running",
    next_sequence_number: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    completed_at: null,
    error_code: null,
  },
  {
    tenant_id: "tenant-b",
    run_id: "run-b-1",
    job_id: "job-run-b-1",
    target_kind: "web",
    objective: "verify tenant isolation",
    status: "running",
    next_sequence_number: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    completed_at: null,
    error_code: null,
  },
];

const EXPECTED_ARTIFACT_MANIFESTS: readonly ArtifactManifestSnapshot[] = [
  {
    tenant_id: "tenant-a",
    artifact_id: "artifact-a-1",
    run_id: "run-a-1",
    kind: "observation",
    media_type: "application/json",
    relative_path: "tenant-a/project-a/observation-1.json",
    sha256: "574b20a33611789b88e673519664d2be7daa2f0dae422552d92595d7cc0e936f",
    size_bytes: 25,
    created_at: "2026-08-01T00:00:00.000Z",
  },
  {
    tenant_id: "tenant-a",
    artifact_id: "artifact-a-2",
    run_id: "run-a-2",
    kind: "observation",
    media_type: "application/json",
    relative_path: "tenant-a/project-a/observation-2.json",
    sha256: "41390c3b9392e5157732edad7f5af0016e6c6747da4db9823d8663621d8b38ce",
    size_bytes: 24,
    created_at: "2026-08-01T00:00:00.000Z",
  },
  {
    tenant_id: "tenant-b",
    artifact_id: "artifact-b-1",
    run_id: "run-b-1",
    kind: "observation",
    media_type: "application/octet-stream",
    relative_path: "tenant-b/project-b/observation-3.bin",
    sha256: "694c11de6ccf1f4a4598805d2f56a9809554c52071492c2fc07ba17d827c2435",
    size_bytes: 14,
    created_at: "2026-08-01T00:00:00.000Z",
  },
];

const EXPECTED_OBJECTS = [
  {
    key: "tenant-a/project-a/observation-1.json",
    bytes: [
      123, 34, 102, 105, 110, 100, 105, 110, 103, 34, 58, 34, 97, 108, 112, 104, 97, 34,
      44, 34, 110, 34, 58, 49, 125,
    ],
  },
  {
    key: "tenant-a/project-a/observation-2.json",
    bytes: [
      123, 34, 102, 105, 110, 100, 105, 110, 103, 34, 58, 34, 98, 101, 116, 97, 34, 44,
      34, 110, 34, 58, 50, 125,
    ],
  },
  {
    key: "tenant-b/project-b/observation-3.bin",
    bytes: [0, 1, 2, 98, 105, 110, 97, 114, 121, 45, 105, 115, 104, 255],
  },
] as const;

interface SeededObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

describe.skipIf(!dockerAvailable())("Self-hosted backup/restore E2E (real PostgreSQL + MinIO)", () => {
  let pgFixture: PostgresFixture;
  let minio: StartedMinio;
  let s3Client: S3Client;
  let backupParent: string;
  let goodBackupDir: string;
  const seededObjects: SeededObject[] = [];

  function baseConfig(overrides: Partial<SelfHostedAdminConfig> = {}): SelfHostedAdminConfig {
    return {
      postgres: {
        admin: pgFixture.adminConfig,
        server: { name: pgFixture.serverConfig.user, password: pgFixture.serverConfig.password },
        worker: { name: pgFixture.workerConfig.user, password: pgFixture.workerConfig.password },
      },
      s3: {
        region: "us-east-1",
        endpoint: minio.endpoint,
        bucket: BUCKET,
        accessKeyId: minio.accessKey,
        secretAccessKey: minio.secretKey,
        forcePathStyle: true,
      },
      kms: { rootKey: new Uint8Array(32) },
      server: { baseUrl: "http://127.0.0.1:0" },
      backupDir: backupParent,
      productVersion: "0.1.0-test",
      secretFiles: [],
      ...overrides,
    };
  }

  async function insertRun(row: ExecutionRunSnapshot): Promise<void> {
    const client = new Client(pgFixture.adminConfig);
    await client.connect();
    try {
      await client.query(
        `INSERT INTO execution_runs (
          tenant_id, run_id, job_id, target_kind, objective, status,
          next_sequence_number, created_at, completed_at, error_code
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.tenant_id,
          row.run_id,
          row.job_id,
          row.target_kind,
          row.objective,
          row.status,
          row.next_sequence_number,
          row.created_at,
          row.completed_at,
          row.error_code,
        ],
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async function insertArtifactManifest(input: ArtifactManifestSnapshot): Promise<void> {
    const client = new Client(pgFixture.adminConfig);
    await client.connect();
    try {
      await client.query(
        `INSERT INTO artifact_manifests (
          tenant_id, artifact_id, run_id, kind, media_type, relative_path,
          sha256, size_bytes, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.tenant_id,
          input.artifact_id,
          input.run_id,
          input.kind,
          input.media_type,
          input.relative_path,
          input.sha256,
          input.size_bytes,
          input.created_at,
        ],
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async function persistenceSnapshot(): Promise<PersistenceSnapshot> {
    const client = new Client(pgFixture.adminConfig);
    await client.connect();
    try {
      const executionRuns = await client.query<ExecutionRunSnapshot>(
        "SELECT * FROM execution_runs ORDER BY tenant_id, run_id",
      );
      const artifactManifests = await client.query<ArtifactManifestSnapshot>(
        "SELECT * FROM artifact_manifests ORDER BY tenant_id, artifact_id",
      );
      const objects: Array<{ key: string; bytes: number[] }> = [];
      for (const expected of EXPECTED_OBJECTS) {
        const bytes = await getObjectBytes(s3Client, BUCKET, expected.key);
        objects.push({ key: expected.key, bytes: [...bytes] });
      }
      return {
        executionRuns: executionRuns.rows,
        artifactManifests: artifactManifests.rows,
        objects,
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async function setupOldSchemaFixture(): Promise<PostgresFixture> {
    const container = await startPostgres();
    const adminConfig: PostgresConnectionConfig = {
      host: container.host,
      port: container.port,
      database: container.database,
      user: container.superuser,
      password: container.password,
    };
    const db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new Pool(adminConfig) }),
    });
    try {
      await createRuntimeRoles(db, {
        database: adminConfig.database,
        server: { name: SERVER_ROLE, password: SERVER_PASSWORD },
        worker: { name: WORKER_ROLE, password: WORKER_PASSWORD },
      });
    } finally {
      await db.destroy();
    }
    await migratePostgres({
      admin: adminConfig,
      targetVersion: OLD_SCHEMA_VERSION,
      roles: { server: SERVER_ROLE, worker: WORKER_ROLE },
    });
    return {
      container,
      adminConfig,
      serverConfig: { ...adminConfig, user: SERVER_ROLE, password: SERVER_PASSWORD },
      workerConfig: { ...adminConfig, user: WORKER_ROLE, password: WORKER_PASSWORD },
      stop: () => container.stop(),
    };
  }

  async function wipeDatabase(): Promise<void> {
    const client = new Client(pgFixture.adminConfig);
    await client.connect();
    try {
      await client.query("DROP SCHEMA public CASCADE");
      await client.query("CREATE SCHEMA public");
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  beforeAll(async () => {
    pgFixture = await setupOldSchemaFixture();
    minio = await startMinio();
    s3Client = new S3Client({
      endpoint: minio.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
    });
    await s3Client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    backupParent = await mkdtemp(join(process.cwd(), ".e2e-backups-"));

    // Seed real tenant data in PostgreSQL.
    for (const run of SEEDED_EXECUTION_RUNS) {
      await insertRun(run);
    }

    // Seed real object bytes and their snapshot-visible manifests across two tenants.
    const seededArtifacts = [
      {
        manifest: {
          tenant_id: "tenant-a",
          artifact_id: "artifact-a-1",
          run_id: "run-a-1",
          kind: "observation",
          media_type: "application/json",
          relative_path: "tenant-a/project-a/observation-1.json",
          created_at: "2026-08-01T00:00:00.000Z",
        },
        bytes: new TextEncoder().encode('{"finding":"alpha","n":1}'),
      },
      {
        manifest: {
          tenant_id: "tenant-a",
          artifact_id: "artifact-a-2",
          run_id: "run-a-2",
          kind: "observation",
          media_type: "application/json",
          relative_path: "tenant-a/project-a/observation-2.json",
          created_at: "2026-08-01T00:00:00.000Z",
        },
        bytes: new TextEncoder().encode('{"finding":"beta","n":2}'),
      },
      {
        manifest: {
          tenant_id: "tenant-b",
          artifact_id: "artifact-b-1",
          run_id: "run-b-1",
          kind: "observation",
          media_type: "application/octet-stream",
          relative_path: "tenant-b/project-b/observation-3.bin",
          created_at: "2026-08-01T00:00:00.000Z",
        },
        bytes: Uint8Array.from([0, 1, 2, 98, 105, 110, 97, 114, 121, 45, 105, 115, 104, 255]),
      },
    ] as const;
    for (const seeded of seededArtifacts) {
      const sha256 = sha256Hex(seeded.bytes);
      await putObjectBytes(s3Client, BUCKET, seeded.manifest.relative_path, seeded.bytes);
      await insertArtifactManifest({
        ...seeded.manifest,
        sha256,
        size_bytes: seeded.bytes.length,
      });
      seededObjects.push({ key: seeded.manifest.relative_path, bytes: seeded.bytes, sha256 });
    }

  }, 240_000);

  afterAll(async () => {
    s3Client?.destroy();
    await minio?.stop();
    await pgFixture?.stop();
    if (backupParent !== undefined) {
      await rm(backupParent, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("upgrades every persisted version and restores its bound pre-migration backup byte-for-byte", async () => {
    const pgTool = dockerExecPgToolRunner(pgFixture.container.id);
    const config = baseConfig();

    const expectedSnapshot: PersistenceSnapshot = {
      executionRuns: EXPECTED_EXECUTION_RUNS,
      artifactManifests: EXPECTED_ARTIFACT_MANIFESTS,
      objects: EXPECTED_OBJECTS,
    };
    const beforeMigration = await persistenceSnapshot();
    expect(beforeMigration).toEqual(expectedSnapshot);
    expect(await readSchemaVersion(pgFixture.adminConfig)).toBe(OLD_SCHEMA_VERSION);

    const migration = await runMigrate(config, {
      invocationId: MIGRATION_INVOCATION_ID,
      runBackup: (backupConfig, binding) =>
        runBackup(backupConfig, { pgTool, s3Client, migration: binding }),
    });
    expect(migration.action).toBe("migrated");
    expect(migration.appliedVersions).toEqual([2, 3, 4, 5, 6, 7]);
    expect(migration.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(await migrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await readSchemaVersion(pgFixture.adminConfig)).toBe(CURRENT_SCHEMA_VERSION);
    const afterMigration = await persistenceSnapshot();
    expect(afterMigration).toEqual(expectedSnapshot);
    expect(afterMigration).toEqual(beforeMigration);

    expect(migration.backupDirectory).toBeDefined();
    goodBackupDir = migration.backupDirectory!;
    const backupIndex = await verifyBackupDirectory(goodBackupDir);
    const targetDatabaseSha256 = createHash("sha256")
      .update(
        `${config.postgres.admin.host.toLowerCase()}:${config.postgres.admin.port}/${config.postgres.admin.database}`,
      )
      .digest("hex");
    expect(backupIndex.database.schemaVersion).toBe(OLD_SCHEMA_VERSION);
    expect(backupIndex.migration).toEqual({
      invocationId: MIGRATION_INVOCATION_ID,
      targetDatabaseSha256,
      targetSchemaVersion: CURRENT_SCHEMA_VERSION,
    });
    expect(backupIndex.objectCount).toBe(seededObjects.length);
    expect(backupIndex.tenants).toEqual(["tenant-a", "tenant-b"]);
    for (const seeded of seededObjects) {
      const record = backupIndex.objects.find((object) => object.key === seeded.key);
      expect(record, `missing backup record for ${seeded.key}`).toBeDefined();
      expect(record?.sha256).toBe(seeded.sha256);
      expect(record?.sizeBytes).toBe(seeded.bytes.length);
    }

    // Wipe the environment: drop all DB objects and empty the bucket.
    await wipeDatabase();
    await emptyBucket(s3Client, BUCKET);
    expect(await runRowsSafe()).toHaveLength(0);

    // Restore the invocation-bound schema-1 backup, not the upgraded source.
    const restoreConfig = baseConfig({ backupDir: goodBackupDir });
    const result = await runRestore(restoreConfig, { pgTool, s3Client });
    expect(result.restoredObjects).toBe(seededObjects.length);
    expect(result.schemaVersion).toBe(OLD_SCHEMA_VERSION);
    expect(result.verification.missing).toEqual([]);
    expect(result.verification.corrupt).toEqual([]);
    expect(await readSchemaVersion(pgFixture.adminConfig)).toBe(OLD_SCHEMA_VERSION);

    const afterCleanRestore = await persistenceSnapshot();
    expect(afterCleanRestore).toEqual(expectedSnapshot);
    expect(afterCleanRestore).toEqual(beforeMigration);
  }, 240_000);

  it("refuses to restore a backup whose object bytes were corrupted, before mutating the target", async () => {
    const pgTool = dockerExecPgToolRunner(pgFixture.container.id);
    const backup = await runBackup(baseConfig(), { pgTool, s3Client });

    // Corrupt one copied object byte stream in the backup.
    const victim = backup.index.objects[0];
    expect(victim).toBeDefined();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(backup.directory, "objects", victim!.relativePath),
      Buffer.from("tampered"),
    );

    // Wipe the target so we can prove restore refuses BEFORE mutating it.
    await wipeDatabase();
    await emptyBucket(s3Client, BUCKET);

    await expect(
      runRestore(baseConfig({ backupDir: backup.directory }), { pgTool, s3Client }),
    ).rejects.toMatchObject({ code: "BackupIncomplete" });

    // The target was left untouched: DB still empty, bucket still empty.
    expect(await runRowsSafe()).toHaveLength(0);
    const objectsAfter = await getBucketKeys();
    expect(objectsAfter).toEqual([]);

    // Restore the good backup taken in test 1 is unaffected; re-seed for isolation.
    await reseed();
  }, 240_000);

  it("refuses a backup that has no completion marker", async () => {
    const pgTool = dockerExecPgToolRunner(pgFixture.container.id);
    const backup = await runBackup(baseConfig(), { pgTool, s3Client });
    await rm(join(backup.directory, "backup-complete"), { force: true });

    await expect(
      runRestore(baseConfig({ backupDir: backup.directory }), { pgTool, s3Client }),
    ).rejects.toMatchObject({ code: "BackupIncomplete" });

    await reseed();
  }, 240_000);

  async function runRowsSafe(): Promise<Array<{ tenant_id: string; run_id: string }>> {
    const client = new Client(pgFixture.adminConfig);
    await client.connect();
    try {
      const exists = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('public.execution_runs') IS NOT NULL AS exists",
      );
      if (exists.rows[0]?.exists !== true) {
        return [];
      }
      const result = await client.query<{ tenant_id: string; run_id: string }>(
        "SELECT tenant_id, run_id FROM execution_runs ORDER BY run_id",
      );
      return result.rows;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async function migrationVersions(): Promise<number[]> {
    const client = new Client(pgFixture.adminConfig);
    await client.connect();
    try {
      const result = await client.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      return result.rows.map((row) => row.version);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async function getBucketKeys(): Promise<string[]> {
    const { enumerateObjects } = await import("@qualigence/admin-cli");
    const objects = await enumerateObjects(s3Client, BUCKET);
    return objects.map((object) => object.key);
  }

  async function reseed(): Promise<void> {
    // Restore is read-only on the migration-bound backup, so it can be replayed
    // to rebuild the old schema, rows and objects between tests. Roles persist
    // across a schema drop, so no role provisioning is required.
    await wipeDatabase();
    await emptyBucket(s3Client, BUCKET);
    const pgTool = dockerExecPgToolRunner(pgFixture.container.id);
    await runRestore(baseConfig({ backupDir: goodBackupDir }), { pgTool, s3Client });
  }
});
