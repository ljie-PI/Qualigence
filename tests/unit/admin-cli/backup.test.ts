import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBackup, sha256Hex, type SelfHostedAdminConfig } from "@qualigence/admin-cli";

describe("Admin CLI snapshot backup", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it("copies only snapshot-visible manifests and verifies actual object bytes", async () => {
    const backupDir = await mkdtemp(join(process.cwd(), ".tmp-backup-unit-"));
    directories.push(backupDir);
    const bytes = new TextEncoder().encode("snapshot-visible");
    const sha256 = sha256Hex(bytes);
    const requested: string[] = [];

    const result = await runBackup(config(backupDir), {
      pgTool: {
        dump: async (_connection, options) => writeFile(options.outFile, "dump"),
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
    expect(result.index.objects).toEqual([{
      key: "tenant-a/project-a/object",
      relativePath: `${sha256.slice(0, 2)}/${sha256}`,
      sizeBytes: bytes.length,
      sha256,
    }]);
  });

  it("rejects S3 bytes that do not match the snapshot-visible manifest", async () => {
    const backupDir = await mkdtemp(join(process.cwd(), ".tmp-backup-unit-"));
    directories.push(backupDir);
    await expect(runBackup(config(backupDir), {
      pgTool: {
        dump: async (_connection, options) => writeFile(options.outFile, "dump"),
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
});

function config(backupDir: string): SelfHostedAdminConfig {
  return {
    postgres: {
      admin: { host: "unused", port: 5432, database: "unused", user: "unused", password: "unused" },
      server: { name: "server", password: "unused" },
      worker: { name: "worker", password: "unused" },
    },
    s3: {
      region: "us-east-1", bucket: "artifacts", accessKeyId: "unused",
      secretAccessKey: "unused", forcePathStyle: true,
    },
    kms: { rootKey: new Uint8Array(32) },
    server: { baseUrl: "http://unused" },
    backupDir,
    productVersion: "test",
    secretFiles: [],
  };
}
