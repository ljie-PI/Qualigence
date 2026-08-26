import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  canonicalPayloadHash,
  type ArtifactUploadAck,
  type ArtifactUploadChunk,
  type ArtifactUploadManifest,
  type ExecutionEventBatch,
  type ExecutionJobLease,
  type TraceEvent,
} from "@qualigence/runner-protocol";
import { SqliteRunnerSpool } from "@qualigence/runner-spool";
import { ArtifactUploadPump, TraceUploadPump } from "@qualigence/runner";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), ".tmp-runner-pump-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("TraceUploadPump", () => {
  it("acks the spool only after Core acknowledges the submitted batch", async () => {
    const spool = await SqliteRunnerSpool.open({ databaseFile: join(root, "trace.db") });
    await spool.append(event(1));
    const submitted: ExecutionEventBatch[] = [];
    const pump = new TraceUploadPump(spool, {
      submit: async (batch) => {
        submitted.push(batch);
        return { batchId: batch.batchId, runId: batch.runId, nextExpectedSequenceNumber: 2 };
      },
    }, "run-1", { maximumEvents: 10, maximumBytes: 4096 }, () => "batch-1");

    await expect(pump.pumpOnce()).resolves.toEqual({ submitted: 1, done: true });
    expect(submitted).toHaveLength(1);
    expect(await spool.pending("run-1", 1, { maximumEvents: 10, maximumBytes: 4096 })).toEqual([]);
    await spool.close();
  });

  it("leaves unacknowledged Trace durable when submit fails", async () => {
    const spool = await SqliteRunnerSpool.open({ databaseFile: join(root, "trace-fail.db") });
    await spool.append(event(1));
    const pump = new TraceUploadPump(spool, {
      submit: async () => {
        throw new Error("network lost");
      },
    }, "run-1", { maximumEvents: 10, maximumBytes: 4096 });

    await expect(pump.pumpOnce()).rejects.toThrow("network lost");
    expect(await spool.pending("run-1", 1, { maximumEvents: 10, maximumBytes: 4096 })).toEqual([event(1)]);
    await spool.close();
  });
});

describe("ArtifactUploadPump", () => {
  it("resumes from server missing ranges and removes the artifact after durable ACK", async () => {
    const spool = await SqliteRunnerSpool.open({ databaseFile: join(root, "artifact.db") });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const manifest = manifestFor(bytes);
    const chunk = chunkFor(manifest, bytes);
    await spool.saveArtifactManifest(manifest);
    await spool.saveArtifactChunk(chunk);
    await spool.close();

    const reopened = await SqliteRunnerSpool.open({ databaseFile: join(root, "artifact.db") });
    const calls: string[] = [];
    const pump = new ArtifactUploadPump(reopened, {
      registerArtifactManifest: async () => {
        calls.push("manifest");
        return { artifactId: manifest.artifactId, runId: manifest.runId, acknowledged: false, missingRanges: [{ offset: 0, length: bytes.length }] };
      },
      uploadArtifactChunk: async (upload) => {
        calls.push(`chunk:${upload.chunk.offset}`);
        return { artifactId: manifest.artifactId, runId: manifest.runId, acknowledged: true, missingRanges: [] };
      },
    }, lease());

    await expect(pump.drain("run-1")).resolves.toEqual({ artifacts: 1, acknowledged: 1 });
    expect(calls).toEqual(["manifest", "chunk:0"]);
    expect(await reopened.pendingArtifactManifests("run-1")).toEqual([]);
    expect(await reopened.pendingArtifactChunks("run-1", "artifact-1", [{ offset: 0, length: bytes.length }])).toEqual([]);
    await reopened.close();
  });

  it("keeps unacknowledged artifact chunks durable when upload fails", async () => {
    const spool = await SqliteRunnerSpool.open({ databaseFile: join(root, "artifact-fail.db") });
    const bytes = new Uint8Array([5, 6, 7]);
    const manifest = manifestFor(bytes);
    const chunk = chunkFor(manifest, bytes);
    await spool.saveArtifactManifest(manifest);
    await spool.saveArtifactChunk(chunk);
    const pump = new ArtifactUploadPump(spool, {
      registerArtifactManifest: async (): Promise<ArtifactUploadAck> => ({ artifactId: manifest.artifactId, runId: manifest.runId, acknowledged: false, missingRanges: [{ offset: 0, length: bytes.length }] }),
      uploadArtifactChunk: async () => { throw new Error("lost after manifest"); },
    }, lease());

    await expect(pump.drain("run-1")).rejects.toThrow("lost after manifest");
    expect(await spool.pendingArtifactManifests("run-1")).toEqual([manifest]);
    expect(await spool.pendingArtifactChunks("run-1", "artifact-1", [{ offset: 0, length: bytes.length }])).toEqual([chunk]);
    await spool.close();
  });
});

function event(sequenceNumber: number): TraceEvent {
  const payload = { status: "ok" as const };
  return {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `msg-${sequenceNumber}`,
    idempotencyKey: `idem-${sequenceNumber}`,
    runId: "run-1",
    sequenceNumber,
    stage: "action_executed",
    occurredAt: "2026-08-01T00:00:00.000Z",
    payloadHash: canonicalPayloadHash(payload),
    payload,
  };
}

function manifestFor(bytes: Uint8Array): ArtifactUploadManifest {
  return {
    artifactId: "artifact-1",
    tenantId: "tenant-a",
    projectId: "project-a",
    runId: "run-1",
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    mediaType: "application/octet-stream",
    sensitivity: "internal",
    chunkSizeBytes: ARTIFACT_CHUNK_SIZE_BYTES,
    totalChunks: 1,
  };
}

function chunkFor(manifest: ArtifactUploadManifest, bytes: Uint8Array): ArtifactUploadChunk {
  return {
    artifactId: manifest.artifactId,
    tenantId: manifest.tenantId,
    projectId: manifest.projectId,
    runId: manifest.runId,
    offset: 0,
    bytes,
    sha256: sha256(bytes),
  };
}

function lease(): ExecutionJobLease {
  return {
    jobId: "job-run-1",
    runId: "run-1",
    leaseToken: "lease-token",
    leaseEpoch: 1,
    expiresAt: "2026-08-01T00:01:00.000Z",
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
