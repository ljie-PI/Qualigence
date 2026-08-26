import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  S3ArtifactStore,
  S3ArtifactStoreError,
} from "@qualigence/artifact-s3";
import type { ArtifactWriteRequest } from "@qualigence/evidence";
import {
  dockerAvailable,
  startMinio,
  type StartedMinio,
} from "../../helpers/docker-container.js";

const fixedClock = { now: () => "2026-08-01T00:00:00.000Z" };

function writeRequest(
  overrides: Partial<ArtifactWriteRequest> = {},
): ArtifactWriteRequest {
  return {
    artifactId: "artifact-1",
    runId: "run-1",
    name: "observation.json",
    kind: "observation",
    mediaType: "application/json",
    bytes: new TextEncoder().encode('{"hello":"world"}'),
    ...overrides,
  };
}

describe.skipIf(!dockerAvailable())("S3ArtifactStore against MinIO", () => {
  let minio: StartedMinio;
  let client: S3Client;
  const bucket = "qualigence-artifacts";

  beforeAll(async () => {
    minio = await startMinio();
    client = new S3Client({
      endpoint: minio.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: minio.accessKey,
        secretAccessKey: minio.secretKey,
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }, 120_000);

  afterAll(async () => {
    client?.destroy();
    await minio?.stop();
  });

  function newStore(overrides: { tenantId?: string; projectId?: string } = {}) {
    return new S3ArtifactStore({
      client,
      bucket,
      tenantId: overrides.tenantId ?? "tenant-a",
      projectId: overrides.projectId ?? "project-a",
      clock: fixedClock,
    });
  }

  it("round-trips real bytes through the object store", async () => {
    const store = newStore();
    const request = writeRequest({
      bytes: new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]),
    });

    const manifest = await store.write(request);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.size).toBe(request.bytes.length);
    expect(manifest.relativePath).toBe(
      `tenant-a/project-a/run-1/${manifest.sha256.slice(0, 2)}/${manifest.sha256}`,
    );

    const read = await store.read(manifest);
    expect(Array.from(read)).toEqual(Array.from(request.bytes));
    expect(await store.verify(manifest)).toBe(true);
  });

  it("is idempotent for identical content inside a run-scoped manifest path", async () => {
    const store = newStore();
    const first = await store.write(writeRequest({ artifactId: "a" }));
    const second = await store.write(writeRequest({ artifactId: "b" }));
    const otherRun = await store.write(writeRequest({ artifactId: "c", runId: "run-2" }));
    expect(second.relativePath).toBe(first.relativePath);
    expect(second.sha256).toBe(first.sha256);
    expect(otherRun.sha256).toBe(first.sha256);
    expect(otherRun.relativePath).not.toBe(first.relativePath);
    expect(otherRun.relativePath.startsWith("tenant-a/project-a/run-2/")).toBe(true);
  });

  it("separates identical bytes across tenants", async () => {
    const a = await newStore({ tenantId: "tenant-a" }).write(writeRequest());
    const b = await newStore({ tenantId: "tenant-b" }).write(writeRequest());
    expect(a.sha256).toBe(b.sha256);
    expect(a.relativePath).not.toBe(b.relativePath);
    expect(b.relativePath.startsWith("tenant-b/")).toBe(true);
  });

  it("detects corruption on read", async () => {
    const store = newStore();
    const manifest = await store.write(writeRequest());

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: manifest.relativePath,
        Body: new TextEncoder().encode("tampered"),
      }),
    );

    await expect(store.read(manifest)).rejects.toMatchObject({
      code: "ArtifactHashMismatch",
    });
    expect(await store.verify(manifest)).toBe(false);
  });

  it("reports verify=false for a missing object", async () => {
    const store = newStore();
    const missing = {
      artifactId: "ghost",
      runId: "run-1",
      kind: "observation" as const,
      mediaType: "application/json",
      relativePath: "tenant-a/project-a/run-1/00/" + "0".repeat(64),
      sha256: "0".repeat(64),
      size: 4,
      createdAt: fixedClock.now(),
    };
    expect(await store.verify(missing)).toBe(false);
  });

  it("rejects unsafe path segments and cross-scope manifests", async () => {
    expect(() => newStore({ tenantId: "../escape" })).toThrow(
      S3ArtifactStoreError,
    );
    const store = newStore();
    await expect(
      store.write(writeRequest({ name: "../../etc/passwd" })),
    ).rejects.toMatchObject({ code: "ArtifactPathRejected" });
    await expect(
      store.read({
        artifactId: "foreign",
        runId: "run-1",
        kind: "observation",
        mediaType: "application/json",
        relativePath: "tenant-b/project-a/run-1/00/" + "0".repeat(64),
        sha256: "0".repeat(64),
        size: 0,
        createdAt: fixedClock.now(),
      }),
    ).rejects.toMatchObject({ code: "ArtifactPathRejected" });
  });

  it("deletes only the scoped object and keeps deletion failures explicit", async () => {
    const store = newStore();
    const manifest = await store.write(writeRequest({ artifactId: "delete-me" }));
    await store.delete?.(manifest);
    expect(await store.verify(manifest)).toBe(false);

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: manifest.relativePath,
        Body: new TextEncoder().encode("restored"),
      }),
    );
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: manifest.relativePath }));
    expect(await store.verify(manifest)).toBe(false);
  });
});
