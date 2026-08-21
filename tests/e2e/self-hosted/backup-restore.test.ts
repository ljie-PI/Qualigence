import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
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
import { readSchemaVersion } from "@qualigence/postgres-runtime";
import {
  dockerAvailable,
  startMinio,
  type StartedMinio,
} from "../../helpers/docker-container.js";
import {
  executionRunRow,
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";
import { dockerExecPgToolRunner } from "../../helpers/docker-pg-tool-runner.js";
import pg from "pg";

const { Client } = pg;
const BUCKET = "qualigence-artifacts";
const OLD_SCHEMA_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 7;
const MIGRATION_INVOCATION_ID = "ticket-36-forward-upgrade";

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
  const seededRuns = [
    { tenantId: "tenant-a", runId: "run-a-1" },
    { tenantId: "tenant-a", runId: "run-a-2" },
    { tenantId: "tenant-b", runId: "run-b-1" },
  ];

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

  async function insertRun(row: Record<string, unknown>): Promise<void> {
    const client = new Client(pgFixture.adminConfig);
    await client.connect();
    try {
      const columns = Object.keys(row);
      const placeholders = columns.map((_, index) => `$${index + 1}`);
      await client.query(
        `INSERT INTO execution_runs (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
        columns.map((column) => row[column]),
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async function insertArtifactManifest(input: {
    readonly artifactId: string;
    readonly tenantId: string;
    readonly runId: string;
    readonly key: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly mediaType: string;
  }): Promise<void> {
    const client = new Client(pgFixture.adminConfig);
    await client.connect();
    try {
      await client.query(
        `INSERT INTO artifact_manifests (
          tenant_id, artifact_id, run_id, kind, media_type, relative_path,
          sha256, size_bytes, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.tenantId,
          input.artifactId,
          input.runId,
          "observation",
          input.mediaType,
          input.key,
          input.sha256,
          input.sizeBytes,
          "2026-08-01T00:00:00.000Z",
        ],
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async function runRows(): Promise<Array<{ tenant_id: string; run_id: string; objective: string }>> {
    const client = new Client(pgFixture.adminConfig);
    await client.connect();
    try {
      const result = await client.query<{ tenant_id: string; run_id: string; objective: string }>(
        "SELECT tenant_id, run_id, objective FROM execution_runs ORDER BY run_id",
      );
      return result.rows;
    } finally {
      await client.end().catch(() => undefined);
    }
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
    pgFixture = await setupPostgresFixture({ targetVersion: OLD_SCHEMA_VERSION });
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
    for (const run of seededRuns) {
      await insertRun(executionRunRow(run));
    }

    // Seed real object bytes and their snapshot-visible manifests across two tenants.
    const specs = [
      {
        artifactId: "artifact-a-1",
        tenantId: "tenant-a",
        runId: "run-a-1",
        key: "tenant-a/project-a/observation-1.json",
        mediaType: "application/json",
        text: '{"finding":"alpha","n":1}',
      },
      {
        artifactId: "artifact-a-2",
        tenantId: "tenant-a",
        runId: "run-a-2",
        key: "tenant-a/project-a/observation-2.json",
        mediaType: "application/json",
        text: '{"finding":"beta","n":2}',
      },
      {
        artifactId: "artifact-b-1",
        tenantId: "tenant-b",
        runId: "run-b-1",
        key: "tenant-b/project-b/observation-3.bin",
        mediaType: "application/octet-stream",
        text: "\u0000\u0001\u0002binary-ish\u00ff",
      },
    ];
    for (const spec of specs) {
      const bytes = new TextEncoder().encode(spec.text);
      const sha256 = sha256Hex(bytes);
      await putObjectBytes(s3Client, BUCKET, spec.key, bytes);
      await insertArtifactManifest({
        artifactId: spec.artifactId,
        tenantId: spec.tenantId,
        runId: spec.runId,
        key: spec.key,
        sha256,
        sizeBytes: bytes.length,
        mediaType: spec.mediaType,
      });
      seededObjects.push({ key: spec.key, bytes, sha256 });
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

    const originalRows = await runRows();
    expect(originalRows).toHaveLength(seededRuns.length);
    expect(await readSchemaVersion(pgFixture.adminConfig)).toBe(OLD_SCHEMA_VERSION);
    for (const seeded of seededObjects) {
      const source = await getObjectBytes(s3Client, BUCKET, seeded.key);
      expect(Buffer.from(source).equals(Buffer.from(seeded.bytes))).toBe(true);
    }

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
    expect(await runRows()).toEqual(originalRows);

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

    // The database rows are back, identical.
    const restoredRows = await runRows();
    expect(restoredRows).toEqual(originalRows);

    // Every object serves byte-identical content to what existed before backup.
    for (const seeded of seededObjects) {
      const restored = await getObjectBytes(s3Client, BUCKET, seeded.key);
      expect(sha256Hex(restored)).toBe(seeded.sha256);
      expect(Buffer.from(restored).equals(Buffer.from(seeded.bytes))).toBe(true);
    }
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
