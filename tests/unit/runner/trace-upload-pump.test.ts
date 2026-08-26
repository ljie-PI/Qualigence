import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  capabilities,
  canonicalPayloadHash,
  type ArtifactUploadAck,
  type ArtifactUploadChunk,
  type ArtifactUploadManifest,
  type ExecutionEventBatch,
  type ExecutionJobLease,
  type TraceEvent,
} from "@qualigence/runner-protocol";
import { AesGcmSpoolCrypto, SqliteRunnerSpool } from "@qualigence/runner-spool";
import { ArtifactUploadPump, RunnerClient, replayPendingRuns, SpoolingArtifactObserver, TraceUploadPump } from "@qualigence/runner";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";

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

describe("SpoolingArtifactObserver", () => {
  it("writes generated artifact manifests and chunks to the Runner Spool before Trace can reference them", async () => {
    const spool = await SqliteRunnerSpool.open({ databaseFile: join(root, "artifact-observer.db") });
    const graph = observationGraphV1("graph-1", [{ id: "node-1", role: "document", confidence: 1, evidenceRefs: ["graph-1.png"] }], { evidenceRefs: ["graph-1.png"] });
    const bytes = new Uint8Array([10, 11, 12]);
    const observer = new SpoolingArtifactObserver({
      observer: { capture: async () => graph },
      source: { captureArtifacts: async () => [{ name: "graph-1.png", mediaType: "image/png", bytes }] },
      spool,
      tenantId: "tenant-a",
    });

    const captured = await observer.capture({
      jobId: "job-run-1",
      runId: "run-1",
      projectId: "project-a",
      target: { kind: "web", url: "https://example.test" },
      objective: "observe",
      policy: { policyId: "policy", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-01T00:01:00.000Z" },
    });

    const [artifactId] = captured.evidenceRefs;
    expect(artifactId).toMatch(/^run-[a-f0-9]{16}-artifact-[a-f0-9]{32}\.png$/);
    expect(artifactId).not.toBe("graph-1.png");
    expect(captured.evidenceRefs).not.toContain("graph-1.png");
    expect(captured.nodes.find((node) => node.id === "node-1")?.evidenceRefs).toEqual([artifactId]);
    expect(await spool.pendingArtifactManifests("run-1")).toMatchObject([{ artifactId, tenantId: "tenant-a", projectId: "project-a", runId: "run-1" }]);
    expect(await spool.pendingArtifactChunks("run-1", artifactId!, [{ offset: 0, length: bytes.length }])).toMatchObject([{ artifactId, offset: 0 }]);
    await spool.close();
  });

  it("uses a deterministic run-bound Artifact ID namespace so a later Run with the same captured filename does not collide", async () => {
    const spool = await SqliteRunnerSpool.open({ databaseFile: join(root, "artifact-observer-noncollision.db") });
    const graph = observationGraphV1("graph-1", [{ id: "node-1", role: "document", confidence: 1 }]);
    const bytes = new Uint8Array([10, 11, 12]);
    const observer = new SpoolingArtifactObserver({
      observer: { capture: async () => graph },
      source: { captureArtifacts: async () => [{ name: "1.png", mediaType: "image/png", bytes }] },
      spool,
      tenantId: "tenant-a",
    });

    const first = await observer.capture(job("run-1"));
    const second = await observer.capture(job("run-2"));
    const firstArtifactId = first.evidenceRefs[0]!;
    const secondArtifactId = second.evidenceRefs[0]!;

    expect(firstArtifactId).not.toBe(secondArtifactId);
    expect(firstArtifactId).not.toBe("1.png");
    expect(secondArtifactId).not.toBe("1.png");
    expect(await spool.pendingArtifactManifests("run-1")).toMatchObject([{ artifactId: firstArtifactId, runId: "run-1" }]);
    expect(await spool.pendingArtifactManifests("run-2")).toMatchObject([{ artifactId: secondArtifactId, runId: "run-2" }]);
    await spool.close();
  });
});

describe("RunnerClient replay", () => {
  it("replays artifact uploads before Trace after reconnect", async () => {
    const spool = await SqliteRunnerSpool.open({
      databaseFile: join(root, "client-replay.db"),
      crypto: new AesGcmSpoolCrypto(randomBytes(32)),
    });
    const bytes = new Uint8Array([8, 9]);
    const manifest = manifestFor(bytes);
    await spool.saveLease(lease());
    await spool.saveArtifactManifest(manifest);
    await spool.saveArtifactChunk(chunkFor(manifest, bytes));
    await spool.append(event(1));
    const calls: string[] = [];
    const session = {
      welcome: { ...welcome(), sessionId: "session-1", resumeToken: "resume-1" },
      nextOffer: async () => { throw new Error("unused"); },
      accept: async () => lease(),
      renew: async () => lease(),
      registerArtifactManifest: async () => {
        calls.push("artifact:manifest");
        return { artifactId: manifest.artifactId, runId: manifest.runId, acknowledged: false, missingRanges: [{ offset: 0, length: bytes.length }] };
      },
      uploadArtifactChunk: async () => {
        calls.push("artifact:chunk");
        return { artifactId: manifest.artifactId, runId: manifest.runId, acknowledged: true, missingRanges: [] };
      },
      submit: async (batch: ExecutionEventBatch) => {
        calls.push(`trace:${batch.firstSequenceNumber}`);
        return { batchId: batch.batchId, runId: batch.runId, nextExpectedSequenceNumber: 2 };
      },
      complete: async () => undefined,
      close: async () => undefined,
    };
    const client = new RunnerClient({
      clientPort: { connect: async () => session },
      makeHello: () => ({ runnerId: "runner-a", runnerVersion: "test", supportedProtocolMajors: [1], capabilities: capabilities() }),
      executor: { execute: async () => ({ lease: lease(), completion: { jobId: "job-run-1", runId: "run-1", status: "passed" }, window: {} as never }) },
      spool,
    });

    await client.connect();
    await client.replay("run-1");

    expect(calls).toEqual(["artifact:manifest", "artifact:chunk", "trace:1"]);
    await spool.close();
  });
});

describe("Standalone Runner recovery", () => {
  it("enumerates pending runs after restart and replays artifacts before Trace using the persisted lease", async () => {
    const databaseFile = join(root, "standalone-restart.db");
    const crypto = new AesGcmSpoolCrypto(randomBytes(32));
    const bytes = new Uint8Array([3, 4, 5]);
    const manifest = manifestFor(bytes);
    const chunk = chunkFor(manifest, bytes);
    const first = await SqliteRunnerSpool.open({ databaseFile, crypto });
    await first.saveLease(lease());
    await first.saveResumeToken({ sessionId: "session-1", resumeToken: "resume-secret" });
    await first.saveArtifactManifest(manifest);
    await first.saveArtifactChunk(chunk);
    await first.append(event(1));
    await first.close();

    const reopened = await SqliteRunnerSpool.open({ databaseFile, crypto });
    expect(await reopened.loadResumeToken()).toEqual({ sessionId: "session-1", resumeToken: "resume-secret" });
    expect(await reopened.pendingRunIds()).toEqual(["run-1"]);
    const calls: string[] = [];
    const session = sessionForReplay(manifest, bytes, calls);

    await expect(replayPendingRuns(session, reopened)).resolves.toEqual(["run-1"]);

    expect(calls).toEqual(["artifact:manifest", "artifact:chunk", "trace:1"]);
    expect(await reopened.pendingRunIds()).toEqual([]);
    await reopened.close();
  });

  it("refuses to advance Trace for a pending Artifact run without a persisted lease", async () => {
    const spool = await SqliteRunnerSpool.open({ databaseFile: join(root, "standalone-missing-lease.db") });
    const bytes = new Uint8Array([3, 4, 5]);
    const manifest = manifestFor(bytes);
    await spool.saveArtifactManifest(manifest);
    await spool.saveArtifactChunk(chunkFor(manifest, bytes));
    await spool.append(event(1));
    const calls: string[] = [];

    await expect(replayPendingRuns(sessionForReplay(manifest, bytes, calls), spool)).rejects.toThrow("without a persisted lease");

    expect(calls).toEqual([]);
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

function job(runId: string) {
  return {
    jobId: `job-${runId}`,
    runId,
    projectId: "project-a",
    target: { kind: "web", url: "https://example.test" } as const,
    objective: "observe",
    policy: { policyId: "policy", environment: "isolated_test" as const, allowedOrigins: ["https://example.test"], allowedActionKinds: ["click" as const], maximumRisk: "Normal" as const, explorationAllowed: false, issuedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-01T00:01:00.000Z" },
  };
}

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

function sessionForReplay(
  manifest: ArtifactUploadManifest,
  bytes: Uint8Array,
  calls: string[],
) {
  return {
    welcome: { ...welcome(), sessionId: "session-1", resumeToken: "resume-1" },
    nextOffer: async () => { throw new Error("unused"); },
    accept: async () => lease(),
    renew: async () => lease(),
    registerArtifactManifest: async () => {
      calls.push("artifact:manifest");
      return { artifactId: manifest.artifactId, runId: manifest.runId, acknowledged: false, missingRanges: [{ offset: 0, length: bytes.length }] };
    },
    uploadArtifactChunk: async () => {
      calls.push("artifact:chunk");
      return { artifactId: manifest.artifactId, runId: manifest.runId, acknowledged: true, missingRanges: [] };
    },
    submit: async (batch: ExecutionEventBatch) => {
      calls.push(`trace:${batch.firstSequenceNumber}`);
      return { batchId: batch.batchId, runId: batch.runId, nextExpectedSequenceNumber: 2 };
    },
    complete: async () => undefined,
    close: async () => undefined,
  };
}

function welcome() {
  return {
    selectedProtocolMajor: 1 as const,
    serverVersion: "0.1.0",
    heartbeatIntervalMs: 10_000,
    leaseDurationMs: 30_000,
    traceBatchMaximumEvents: 10,
    traceBatchMaximumBytes: 4096,
    maximumInFlightBatches: 1,
    maximumPendingWriteBytes: 1024 * 1024,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
