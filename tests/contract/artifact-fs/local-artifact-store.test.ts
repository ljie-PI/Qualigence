import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactWriteRequest } from "@qualigence/evidence";
import type { Clock } from "@qualigence/shared-kernel";
import { LocalArtifactStore } from "@qualigence/artifact-fs";

const fixedClock: Clock = {
  now: () => "2026-08-01T00:00:00.000Z",
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), ".tmp-artifact-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function validRequest(name: string): ArtifactWriteRequest {
  return {
    artifactId: "a1",
    runId: "run-1",
    name,
    kind: "screenshot",
    mediaType: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
  };
}

describe("LocalArtifactStore", () => {
  it("writes, reopens, and verifies bytes", async () => {
    const store = new LocalArtifactStore(root, fixedClock);
    const manifest = await store.write({
      artifactId: "a1",
      runId: "run-1",
      name: "before.png",
      kind: "screenshot",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(manifest.relativePath).toBe("run-1/before.png");
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.size).toBe(3);
    expect(manifest.createdAt).toBe("2026-08-01T00:00:00.000Z");

    const reopened = new LocalArtifactStore(root, fixedClock);
    expect(await reopened.verify(manifest)).toBe(true);
    expect([...(await reopened.read(manifest))]).toEqual([1, 2, 3]);
  });

  it("leaves no temporary file after a successful write", async () => {
    const store = new LocalArtifactStore(root, fixedClock);
    await store.write(validRequest("before.png"));
    const files = await readdir(join(root, "run-1"));
    expect(files).toEqual(["before.png"]);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it.each(["../x", "x/y", "C:\\x", "/x", "..", ".", ""])(
    "rejects unsafe name %s",
    async (name) => {
      const store = new LocalArtifactStore(root, fixedClock);
      await expect(store.write(validRequest(name))).rejects.toMatchObject({
        code: "ArtifactPathRejected",
      });
    },
  );

  it("rejects a run id that escapes the artifact root", async () => {
    const store = new LocalArtifactStore(root, fixedClock);
    await expect(
      store.write({ ...validRequest("a.png"), runId: "../escape" }),
    ).rejects.toMatchObject({ code: "ArtifactPathRejected" });
  });

  it("verify returns false when the stored file is corrupted", async () => {
    const store = new LocalArtifactStore(root, fixedClock);
    const manifest = await store.write(validRequest("before.png"));
    await writeFile(join(root, manifest.relativePath), new Uint8Array([9, 9, 9]));
    expect(await store.verify(manifest)).toBe(false);
  });

  it("read rejects a corrupted file with ArtifactHashMismatch", async () => {
    const store = new LocalArtifactStore(root, fixedClock);
    const manifest = await store.write(validRequest("before.png"));
    await writeFile(join(root, manifest.relativePath), new Uint8Array([9, 9, 9]));
    await expect(store.read(manifest)).rejects.toMatchObject({
      code: "ArtifactHashMismatch",
    });
  });

  it("verify returns false when the file is missing", async () => {
    const store = new LocalArtifactStore(root, fixedClock);
    const manifest = await store.write(validRequest("before.png"));
    await rm(join(root, manifest.relativePath));
    expect(await store.verify(manifest)).toBe(false);
  });

  it("fails with ArtifactWriteFailed and cleans up when the destination is unwritable", async () => {
    const store = new LocalArtifactStore(root, fixedClock);
    // Occupy the destination path with a directory so the atomic rename fails.
    await mkdir(join(root, "run-1", "before.png"), { recursive: true });
    await expect(store.write(validRequest("before.png"))).rejects.toMatchObject({
      code: "ArtifactWriteFailed",
    });
    const files = await readdir(join(root, "run-1"));
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it("overwrites atomically when the same artifact is rewritten", async () => {
    const store = new LocalArtifactStore(root, fixedClock);
    await store.write(validRequest("before.png"));
    const manifest = await store.write({
      ...validRequest("before.png"),
      bytes: new Uint8Array([4, 5, 6, 7]),
    });
    expect(manifest.size).toBe(4);
    expect(await store.verify(manifest)).toBe(true);
    const files = await readdir(join(root, "run-1"));
    expect(files).toEqual(["before.png"]);
  });

  it("computes a stable sha256 for known bytes", async () => {
    const store = new LocalArtifactStore(root, fixedClock);
    const manifest = await store.write({
      ...validRequest("known.bin"),
      bytes: new Uint8Array([1, 2, 3]),
    });
    // sha256 of bytes 0x01 0x02 0x03
    expect(manifest.sha256).toBe(
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
  });
});
