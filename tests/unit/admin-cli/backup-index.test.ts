import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backupTargetBinding,
  canonicalizeIndex,
  objectRelativePath,
  parseIndex,
  runBackup,
  runRestore,
  sha256Hex,
  verifyBackupDirectory,
  type BackupIndexV1,
  type BackupObjectRecord,
  type SelfHostedAdminConfig,
} from "@qualigence/admin-cli";

const DUMP_BYTES = new Uint8Array([1, 2, 3, 4]);
const DUMP_SHA256 = sha256Hex(DUMP_BYTES);

describe("Admin CLI backup index authority", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it("copies snapshot-visible object bytes and records non-secret target-bound hashes", async () => {
    const backupDir = await tempDir("backup-index-copy");
    const bytes = new TextEncoder().encode("snapshot-visible");
    const sha256 = sha256Hex(bytes);
    const requested: string[] = [];
    const cfg = config(backupDir);

    const result = await runBackup(cfg, {
      pgTool: {
        dump: async (_connection, options) => writeFile(options.outFile, DUMP_BYTES),
        restore: async () => undefined,
      },
      withSnapshot: async (_config, use) => use({
        snapshotId: "snapshot-1",
        schemaVersion: 8,
        artifactManifests: [{ key: "tenant-a/project-a/object", sha256, sizeBytes: bytes.length }],
      }),
      readObject: async (key) => {
        requested.push(key);
        return bytes;
      },
      acquireLease: async () => ({ release: async () => undefined }),
      now: () => "2026-08-20T00:00:00.000Z",
    });

    expect(requested).toEqual(["tenant-a/project-a/object"]);
    expect(result.index.database).toMatchObject({ snapshotId: "snapshot-1", schemaVersion: 8 });
    expect(result.index.target).toEqual(backupTargetBinding(cfg));
    expect(result.index.target.databaseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.index.target.objectStoreSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result.index.target)).not.toContain(cfg.postgres.admin.password);
    expect(JSON.stringify(result.index.target)).not.toContain(cfg.s3.secretAccessKey);
    expect(result.index.objects).toEqual([{
      key: "tenant-a/project-a/object",
      relativePath: `${sha256.slice(0, 2)}/${sha256}`,
      sizeBytes: bytes.length,
      sha256,
    }]);
    await expect(verifyBackupDirectory(result.directory)).resolves.toEqual(result.index);
  });

  it("rejects malformed or partial byte-complete backup indexes", async () => {
    const backupDir = await tempDir("backup-index-verify");
    const valid = await writeVerifiedBackup(backupDir, config(backupDir), []);

    expect(parseIndex(canonicalizeIndex(valid))).toEqual(valid);
    expect(() => parseIndex(JSON.stringify({ ...valid, invocationId: undefined }))).toThrow("invocation id");
    expect(() => parseIndex(JSON.stringify({ ...valid, target: undefined }))).toThrow("target binding");
    expect(() => parseIndex(canonicalizeIndex({ ...valid, objectCount: 1 }))).toThrow("object totals");

    await rm(join(backupDir, "backup-complete"), { force: true });
    await expect(verifyBackupDirectory(backupDir)).rejects.toThrow("completion marker");
  });

  it("rejects restore target mismatch before database restore or object writes", async () => {
    const backupDir = await tempDir("restore-mismatch");
    const source = config(backupDir);
    await writeVerifiedBackup(backupDir, source, []);
    const target = config(backupDir, { database: "other-db" });
    const restore = vi.fn(async () => undefined);

    await expect(runRestore(target, {
      pgTool: {
        dump: async () => undefined,
        restore,
      },
      allowNonEmptyTarget: true,
      ensureRuntimeRoles: async () => undefined,
    })).rejects.toMatchObject({ code: "RestoreTargetMismatch" });
    expect(restore).not.toHaveBeenCalled();
  });

  it("rejects unsupported backup schema versions before database restore", async () => {
    const backupDir = await tempDir("backup-index-unsupported-schema");
    await writeVerifiedBackup(backupDir, config(backupDir), [], { schemaVersion: 99_999 });
    const restore = vi.fn(async () => undefined);

    await expect(runRestore(config(backupDir), {
      pgTool: { dump: async () => undefined, restore },
      allowNonEmptyTarget: true,
      ensureRuntimeRoles: async () => undefined,
    })).rejects.toMatchObject({ code: "RestoreSchemaMismatch" });

    expect(restore).not.toHaveBeenCalled();
  });

  it("rejects S3 bytes that do not match the snapshot-visible manifest", async () => {
    const backupDir = await tempDir("backup-index-mismatch");
    await expect(runBackup(config(backupDir), {
      pgTool: {
        dump: async (_connection, options) => writeFile(options.outFile, DUMP_BYTES),
        restore: async () => undefined,
      },
      withSnapshot: async (_config, use) => use({
        snapshotId: "snapshot-2",
        schemaVersion: 8,
        artifactManifests: [{ key: "tenant-a/project-a/object", sha256: "a".repeat(64), sizeBytes: 5 }],
      }),
      readObject: async () => new TextEncoder().encode("wrong"),
      acquireLease: async () => ({ release: async () => undefined }),
    })).rejects.toMatchObject({ code: "BackupFailed" });
  });

  it("cancels backup before dispatch without acquiring a lease or publishing success", async () => {
    const backupDir = await tempDir("backup-index-cancel-backup");
    const controller = new AbortController();
    controller.abort(new Error("operator timeout"));
    const acquireLease = vi.fn(async () => ({ release: async () => undefined }));
    const dump = vi.fn(async () => undefined);

    await expect(runBackup(config(backupDir), {
      pgTool: { dump, restore: async () => undefined },
      acquireLease,
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ code: "BackupCancelled" });

    expect(acquireLease).not.toHaveBeenCalled();
    expect(dump).not.toHaveBeenCalled();
  });

  it("cancels restore before dispatch without validating backup bytes or restoring the database", async () => {
    const backupDir = await tempDir("backup-index-cancel-restore");
    const controller = new AbortController();
    controller.abort(new Error("operator timeout"));
    const restore = vi.fn(async () => undefined);

    await expect(runRestore(config(backupDir), {
      pgTool: { dump: async () => undefined, restore },
      abortSignal: controller.signal,
      allowNonEmptyTarget: true,
    })).rejects.toMatchObject({ code: "RestoreCancelled" });

    expect(restore).not.toHaveBeenCalled();
  });

  it("rejects restored schema mismatches after pg_restore and before object writes", async () => {
    const backupDir = await tempDir("backup-index-schema-mismatch");
    await writeVerifiedBackup(backupDir, config(backupDir), []);
    const restore = vi.fn(async () => undefined);
    const putObject = vi.fn(async (_key: string, _bytes: Uint8Array) => undefined);

    await expect(runRestore(config(backupDir), {
      pgTool: { dump: async () => undefined, restore },
      allowNonEmptyTarget: true,
      ensureRuntimeRoles: async () => undefined,
      readSchemaVersion: async () => 9,
      putObject,
    })).rejects.toMatchObject({ code: "RestoreSchemaMismatch" });

    expect(restore).toHaveBeenCalledTimes(1);
    expect(putObject).not.toHaveBeenCalled();
  });

  it("fails closed after restore object writes begin when restored bytes do not verify", async () => {
    const backupDir = await tempDir("backup-index-restore-write-failure");
    const emptySha256 = sha256Hex(new Uint8Array());
    const object: BackupObjectRecord = {
      key: "tenant-a/project-a/restored-object",
      relativePath: objectRelativePath(emptySha256),
      sizeBytes: 0,
      sha256: emptySha256,
    };
    await writeVerifiedBackup(backupDir, config(backupDir), [object]);
    const restore = vi.fn(async () => undefined);
    const putObject = vi.fn(async (_key: string, _bytes: Uint8Array) => undefined);

    await expect(runRestore(config(backupDir), {
      pgTool: { dump: async () => undefined, restore },
      allowNonEmptyTarget: true,
      ensureRuntimeRoles: async () => undefined,
      readSchemaVersion: async () => 8,
      restoreRuntimePrivileges: async () => undefined,
      putObject,
      getObject: async () => new Uint8Array([1]),
    })).rejects.toMatchObject({ code: "RestoreFailed" });

    expect(restore).toHaveBeenCalledTimes(1);
    expect(putObject).toHaveBeenCalledTimes(1);
    const putObjectCalls = putObject.mock.calls as Array<[string, Uint8Array]>;
    expect(putObjectCalls[0]?.[0]).toBe(object.key);
    expect([...Buffer.from(putObjectCalls[0]?.[1] ?? [])]).toEqual([]);
  });

  it("binds duplicate backup invocations to distinct durable indexes even when timestamps match", async () => {
    const backupDir = await tempDir("backup-index-duplicate-invocation");
    const cfg = config(backupDir);
    const backupDeps = (invocationId: string) => ({
      pgTool: {
        dump: async (_connection, options) => writeFile(options.outFile, DUMP_BYTES),
        restore: async () => undefined,
      },
      withSnapshot: async (_config, use) => use({
        snapshotId: `snapshot-${invocationId}`,
        schemaVersion: 8,
        artifactManifests: [],
      }),
      acquireLease: async () => ({ release: async () => undefined }),
      now: () => "2026-08-20T00:00:00.000Z",
      invocationId,
    } satisfies Parameters<typeof runBackup>[1]);

    const first = await runBackup(cfg, backupDeps("operator-retry-1"));
    const second = await runBackup(cfg, backupDeps("operator-retry-2"));

    expect(first.directory).not.toBe(second.directory);
    expect(first.index.invocationId).toBe("operator-retry-1");
    expect(second.index.invocationId).toBe("operator-retry-2");
    await expect(verifyBackupDirectory(first.directory)).resolves.toMatchObject({ invocationId: "operator-retry-1" });
    await expect(verifyBackupDirectory(second.directory)).resolves.toMatchObject({ invocationId: "operator-retry-2" });
  });

  async function tempDir(name: string): Promise<string> {
    const dir = await mkdtemp(join(process.cwd(), `.tmp-${name}-`));
    directories.push(dir);
    return dir;
  }
});

async function writeVerifiedBackup(
  directory: string,
  cfg: SelfHostedAdminConfig,
  objects: BackupIndexV1["objects"],
  options: { readonly schemaVersion?: number } = {},
): Promise<BackupIndexV1> {
  await mkdir(join(directory, "objects"), { recursive: true });
  await writeFile(join(directory, "database.dump"), DUMP_BYTES);
  for (const object of objects) {
    await mkdir(join(directory, "objects", object.sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(directory, "objects", objectRelativePath(object.sha256)), new Uint8Array(object.sizeBytes));
  }
  const index: BackupIndexV1 = {
    version: "backup-index/v1",
    invocationId: "test-restore-invocation",
    createdAt: "2026-08-20T00:00:00.000Z",
    productVersion: cfg.productVersion,
    database: {
      dumpFile: "database.dump",
      format: "custom",
      sizeBytes: DUMP_BYTES.length,
      sha256: DUMP_SHA256,
      schemaVersion: options.schemaVersion ?? 8,
      snapshotId: "snapshot-index",
    },
    target: backupTargetBinding(cfg),
    objects,
    tenants: [],
    objectCount: objects.length,
    totalObjectBytes: objects.reduce((total, object) => total + object.sizeBytes, 0),
  };
  await writeFile(join(directory, "backup-index.json"), canonicalizeIndex(index), "utf8");
  await writeFile(join(directory, "backup-complete"), "complete\n", "utf8");
  return index;
}

function config(
  backupDir: string,
  overrides: Partial<SelfHostedAdminConfig["postgres"]["admin"]> = {},
): SelfHostedAdminConfig {
  return {
    postgres: {
      admin: { host: "backup-db.local", port: 5432, database: "qualigence", user: "admin", password: "admin-secret", ...overrides },
      server: { name: "server", password: "server-secret" },
      worker: { name: "worker", password: "worker-secret" },
    },
    s3: {
      region: "us-east-1",
      endpoint: "http://minio.local:9000",
      bucket: "artifacts",
      accessKeyId: "access-key",
      secretAccessKey: "s3-secret",
      forcePathStyle: true,
    },
    kms: { rootKey: new Uint8Array(32) },
    server: { baseUrl: "http://server.local" },
    backupDir,
    productVersion: "test",
    secretFiles: [],
  };
}
