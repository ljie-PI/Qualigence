import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  canonicalTraceEventHash,
  type ArtifactUploadManifest,
  type TraceEvent,
} from "@qualigence/runner-protocol";
import {
  ArtifactUploadService,
  TraceIngestor,
} from "@qualigence/evidence";
import { LocalArtifactStore } from "@qualigence/artifact-fs";
import {
  createPostgresRuntime,
  PostgresArtifactManifestStore,
  PostgresArtifactUploadStore,
  PostgresTraceStore,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import {
  executionRunRow,
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";

const clock = { now: () => "2026-08-01T00:00:00.000Z" };

describe.skipIf(!dockerAvailable())("PostgreSQL Artifact upload", () => {
  let fixture: PostgresFixture;
  let runtime: TenantTransactionProvider;
  let artifactRoot: string;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
    runtime = createPostgresRuntime(fixture.serverConfig);
    artifactRoot = await mkdtemp(join(process.cwd(), ".tmp-pg-artifact-"));
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await fixture?.stop();
    await rm(artifactRoot, { recursive: true, force: true });
  });

  it("registers, resumes missing ranges, verifies bytes, and only then lets Trace reference the Artifact", async () => {
    const bytes = new TextEncoder().encode("durable artifact bytes");
    const manifest = manifestFor(bytes);

    await runtime.withTenant("tenant-a", async ({ db }) => {
      await db.insertInto("execution_runs").values(executionRunRow({ tenantId: "tenant-a", runId: "run-1" }) as never).execute();
      const uploadStore = new PostgresArtifactUploadStore(db, "tenant-a");
      const service = new ArtifactUploadService({
        uploads: uploadStore,
        artifactStore: new LocalArtifactStore(artifactRoot, clock),
        manifestStore: new PostgresArtifactManifestStore(db, "tenant-a"),
        clock,
      });
      const trace = new TraceIngestor(new PostgresTraceStore(db, "tenant-a", clock), uploadStore);

      const registered = await service.registerManifest({
        identity: { tenantId: "tenant-a", projectId: "project-a", runnerId: "runner-a" },
        jobId: "job-run-1",
        leaseEpoch: 1,
        manifest,
      });
      expect(registered).toEqual({
        artifactId: "artifact-1",
        runId: "run-1",
        acknowledged: false,
        missingRanges: [{ offset: 0, length: bytes.length }],
      });

      await expect(trace.ingest(traceReferencing("artifact-1"))).resolves.toMatchObject({
        status: "artifact_unacknowledged",
        code: "ArtifactUnacknowledged",
      });

      const ack = await service.uploadChunk({
        identity: { runnerId: "runner-a" },
        chunk: {
          artifactId: "artifact-1",
          tenantId: "tenant-a",
          projectId: "project-a",
          runId: "run-1",
          offset: 0,
          bytes,
          sha256: sha256(bytes),
        },
      });
      expect(ack).toEqual({ artifactId: "artifact-1", runId: "run-1", missingRanges: [], acknowledged: true });

      await expect(trace.ingest(traceReferencing("artifact-1"))).resolves.toMatchObject({
        status: "accepted",
        nextSequenceNumber: 2,
      });

      const logical = await new PostgresArtifactManifestStore(db, "tenant-a").listForRun("run-1");
      expect(logical).toHaveLength(1);
      expect(logical[0]).toMatchObject({ artifactId: "artifact-1", sha256: sha256(bytes), size: bytes.length });
    });
  });

  it("keeps tenant upload state isolated and rejects conflicting chunks", async () => {
    const bytes = new Uint8Array(ARTIFACT_CHUNK_SIZE_BYTES + 1);
    bytes.fill(7);
    const firstChunk = bytes.slice(0, ARTIFACT_CHUNK_SIZE_BYTES);
    const alteredFirstChunk = new Uint8Array(ARTIFACT_CHUNK_SIZE_BYTES);
    alteredFirstChunk.fill(9);
    await runtime.withTenant("tenant-a", async ({ db }) => {
      await db.insertInto("execution_runs").values(executionRunRow({ tenantId: "tenant-a", runId: "run-conflict" }) as never).execute();
      const service = new ArtifactUploadService({
        uploads: new PostgresArtifactUploadStore(db, "tenant-a"),
        artifactStore: new LocalArtifactStore(artifactRoot, clock),
        manifestStore: new PostgresArtifactManifestStore(db, "tenant-a"),
        clock,
      });
      const manifest = manifestFor(bytes, { runId: "run-conflict", artifactId: "artifact-conflict" });
      await service.registerManifest({
        identity: { tenantId: "tenant-a", projectId: "project-a", runnerId: "runner-a" },
        jobId: "job-run-conflict",
        leaseEpoch: 1,
        manifest,
      });
      await expect(service.uploadChunk({
        identity: { runnerId: "runner-a" },
        chunk: { artifactId: manifest.artifactId, tenantId: "tenant-a", projectId: "project-a", runId: manifest.runId, offset: 0, bytes: firstChunk, sha256: sha256(firstChunk) },
      })).resolves.toMatchObject({ acknowledged: false });
      await expect(service.uploadChunk({
        identity: { runnerId: "runner-a" },
        chunk: { artifactId: manifest.artifactId, tenantId: "tenant-a", projectId: "project-a", runId: manifest.runId, offset: 0, bytes: alteredFirstChunk, sha256: sha256(alteredFirstChunk) },
      })).rejects.toMatchObject({ code: "ArtifactChunkConflict" });
    });

    await runtime.withTenant("tenant-b", async ({ db }) => {
      expect(await new PostgresArtifactUploadStore(db, "tenant-b").acknowledgedArtifactIds("run-conflict", ["artifact-conflict"])).toEqual(new Set());
    });
  });
});

function manifestFor(bytes: Uint8Array, overrides: Partial<ArtifactUploadManifest> = {}): ArtifactUploadManifest {
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
    totalChunks: Math.ceil(bytes.length / ARTIFACT_CHUNK_SIZE_BYTES),
    ...overrides,
  };
}

function traceReferencing(artifactId: string): TraceEvent {
  const base = {
    protocolVersion: "runner-protocol/v1" as const,
    schemaVersion: "trace-event/v1" as const,
    messageId: "msg-1",
    idempotencyKey: "idem-1",
    runId: "run-1",
    sequenceNumber: 1,
    stage: "finding" as const,
    occurredAt: "2026-08-01T00:00:00.000Z",
    payload: {
      findingId: "finding-1",
      runId: "run-1",
      title: "Finding",
      summary: "Uses artifact",
      severity: "medium" as const,
      evidenceRefs: [artifactId],
    },
  };
  return { ...base, payloadHash: canonicalTraceEventHash(base) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
