import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalArtifactStore } from "@qualigence/artifact-fs";
import {
  ArtifactUploadService,
  InMemoryArtifactUploadStore,
  InMemoryTraceStore,
  type ArtifactManifest,
  type ArtifactManifestStore,
  type ArtifactStore,
  type ArtifactWriteRequest,
} from "@qualigence/evidence";
import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  canonicalTraceEventHash,
  type ArtifactUploadChunk,
  type ArtifactUploadManifest,
  type TraceEvent,
} from "@qualigence/runner-protocol";
import type { RunnerProtocolApplication } from "@qualigence/runner-control";
import { TenantRunnerApplicationResolver } from "@qualigence/core-application";
import { InMemoryRunnerControlStore } from "../../helpers/in-memory-runner-control-store.js";
import { makeHello, welcomeParameters } from "../../helpers/grpc-harness.js";
import { WEB_GRAPH_V1_REQUIREMENTS, webJob } from "../../helpers/core-runner-harness.js";

const clock = { now: () => "2026-08-01T00:00:00.000Z" };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), ".tmp-artifact-app-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Core Runner Protocol Artifact application path", () => {
  it("accepts uploads through the tenant resolver and gates Trace until the Artifact is acknowledged", async () => {
    const fixture = buildFixture();
    const app = fixture.application("tenant-a");
    const { sessionId, lease } = await acceptJob(app, "tenant-a");
    const bytes = new TextEncoder().encode("artifact bytes");
    const manifest = manifestFor(bytes);

    await expect(app.registerArtifactManifest(sessionId, {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      manifest,
    })).resolves.toMatchObject({ acknowledged: false, missingRanges: [{ offset: 0, length: bytes.length }] });

    await expect(app.ingest(sessionId, { batchId: "batch-1", runId: "run-1", firstSequenceNumber: 1, events: [traceReferencing("artifact-1")] }))
      .rejects.toMatchObject({ code: "ArtifactUnacknowledged" });

    await expect(app.uploadArtifactChunk(sessionId, {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      chunk: chunkFor(manifest, bytes),
    })).resolves.toMatchObject({ acknowledged: true, missingRanges: [] });

    await expect(app.ingest(sessionId, { batchId: "batch-2", runId: "run-1", firstSequenceNumber: 1, events: [traceReferencing("artifact-1")] }))
      .resolves.toMatchObject({ nextExpectedSequenceNumber: 2 });
  });

  it("rejects a manifest whose manifest Run differs from the leased Run", async () => {
    const fixture = buildFixture();
    const app = fixture.application("tenant-a");
    const { sessionId, lease } = await acceptJob(app, "tenant-a");
    const bytes = new Uint8Array([1]);

    await expect(app.registerArtifactManifest(sessionId, {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      manifest: manifestFor(bytes, { runId: "run-other" }),
    })).rejects.toMatchObject({ code: "RunIdentityMismatch" });
  });

  it("rejects cross-tenant chunks before they can use a same-runner registration", async () => {
    const fixture = buildFixture();
    const app = fixture.application("tenant-a");
    const { sessionId, lease } = await acceptJob(app, "tenant-a");
    const bytes = new Uint8Array([2]);
    const manifest = manifestFor(bytes);
    await app.registerArtifactManifest(sessionId, {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      manifest,
    });

    await expect(app.uploadArtifactChunk(sessionId, {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      chunk: { ...chunkFor(manifest, bytes), tenantId: "tenant-b" },
    })).rejects.toMatchObject({ code: "RunIdentityMismatch" });
  });

  it("allows a lost owner to finish a registered Artifact but rejects new manifests", async () => {
    const fixture = buildFixture();
    const app = fixture.application("tenant-a");
    const { sessionId, lease } = await acceptJob(app, "tenant-a");
    const bytes = new Uint8Array([3]);
    const manifest = manifestFor(bytes);
    await app.registerArtifactManifest(sessionId, {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      manifest,
    });
    await fixture.stores.get("tenant-a")?.markLeaseLost("run-1", "2026-08-01T00:00:05.000Z");

    await expect(app.uploadArtifactChunk(sessionId, {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      chunk: chunkFor(manifest, bytes),
    })).resolves.toMatchObject({ acknowledged: true });

    await expect(app.registerArtifactManifest(sessionId, {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      manifest: manifestFor(new Uint8Array([4]), { artifactId: "artifact-new", sha256: sha256(new Uint8Array([4])) }),
    })).rejects.toMatchObject({ code: "LeaseLost" });
  });

  it("does not acknowledge or advance Trace when final object verification fails", async () => {
    const fixture = buildFixture({ artifactStore: () => new FailingVerifyArtifactStore() });
    const app = fixture.application("tenant-a");
    const { sessionId, lease } = await acceptJob(app, "tenant-a");
    const bytes = new Uint8Array([5]);
    const manifest = manifestFor(bytes);
    await app.registerArtifactManifest(sessionId, {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      manifest,
    });

    await expect(app.uploadArtifactChunk(sessionId, {
      jobId: lease.jobId,
      runId: lease.runId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      chunk: chunkFor(manifest, bytes),
    })).rejects.toMatchObject({ code: "ArtifactUploadRejected" });
    await expect(app.ingest(sessionId, { batchId: "batch-failed", runId: "run-1", firstSequenceNumber: 1, events: [traceReferencing("artifact-1")] }))
      .rejects.toMatchObject({ code: "ArtifactUnacknowledged" });
  });
});

function buildFixture(options: { readonly artifactStore?: (tenantId: string) => ArtifactStore } = {}) {
  const stores = new Map<string, InMemoryRunnerControlStore>();
  const uploads = new Map<string, InMemoryArtifactUploadStore>();
  const resolver = new TenantRunnerApplicationResolver({
    welcome: welcomeParameters(),
    runnerControlStore: (tenantId) => {
      const store = new InMemoryRunnerControlStore();
      stores.set(tenantId, store);
      return store;
    },
    traceStore: () => new InMemoryTraceStore(),
    artifactUploads: (tenantId) => {
      const uploadStore = new InMemoryArtifactUploadStore();
      uploads.set(tenantId, uploadStore);
      return new ArtifactUploadService({
        uploads: uploadStore,
        artifactStore: options.artifactStore?.(tenantId) ?? new LocalArtifactStore(join(root, tenantId), clock),
        manifestStore: new MemoryManifestStore(),
        clock,
      });
    },
    integrityEvents: { emit: () => undefined },
    now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    generateSessionId: () => `session-${stores.size}`,
    generateOfferId: () => `offer-${stores.size}`,
    generateLeaseToken: () => `lease-${stores.size}`,
  });
  return {
    resolver,
    stores,
    uploads,
    application: (tenantId: string) => resolver.resolve(identity(tenantId)),
  };
}

async function acceptJob(app: RunnerProtocolApplication, tenantId: string) {
  const welcome = await app.openSession(makeHello("runner-a"), identity(tenantId));
  const offer = await app.createOffer(welcome.sessionId, webJob({ jobId: "job-run-1", runId: "run-1", projectId: "project-a" }), WEB_GRAPH_V1_REQUIREMENTS);
  const lease = await app.accept(welcome.sessionId, offer.offerId);
  return { sessionId: welcome.sessionId, lease };
}

function identity(tenantId: string) {
  return {
    runnerId: "runner-a",
    certificateFingerprint: `fp-${tenantId}`,
    scope: { kind: "tenant" as const, tenantId, projectIds: ["project-a"] },
  };
}

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

class MemoryManifestStore implements ArtifactManifestStore {
  readonly appended: ArtifactManifest[] = [];
  async append(manifest: ArtifactManifest): Promise<"accepted" | "duplicate"> {
    if (this.appended.some((stored) => stored.artifactId === manifest.artifactId)) return "duplicate";
    this.appended.push(manifest);
    return "accepted";
  }
  async listForRun(runId: string): Promise<readonly ArtifactManifest[]> {
    return this.appended.filter((manifest) => manifest.runId === runId);
  }
}

class FailingVerifyArtifactStore implements ArtifactStore {
  async write(request: ArtifactWriteRequest): Promise<ArtifactManifest> {
    return {
      artifactId: request.artifactId,
      runId: request.runId,
      kind: request.kind,
      mediaType: request.mediaType,
      relativePath: request.name,
      sha256: sha256(request.bytes),
      size: request.bytes.length,
      createdAt: clock.now(),
    };
  }
  async read(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async verify(): Promise<boolean> {
    return false;
  }
}
