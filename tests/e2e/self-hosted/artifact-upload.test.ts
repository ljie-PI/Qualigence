import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3ArtifactStore } from "@qualigence/artifact-s3";
import { TenantRunnerApplicationResolver } from "@qualigence/core-application";
import { ArtifactUploadService } from "@qualigence/evidence";
import type { AuthenticatedRunnerContext, RunnerSession } from "@qualigence/grpc-runner-protocol";
import {
  createPostgresRuntime,
  OperationScopedPostgresArtifactManifestStore,
  OperationScopedPostgresArtifactUploadStore,
  OperationScopedPostgresRunnerControlStore,
  OperationScopedPostgresTraceStore,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  canonicalTraceEventHash,
  type AcceptedExecutionJob,
  type ArtifactUploadChunk,
  type ArtifactUploadManifest,
  type ExecutionEventBatch,
  type RunnerHello,
  type TraceEvent,
} from "@qualigence/runner-protocol";
import { replayPendingRuns } from "@qualigence/runner";
import { AesGcmSpoolCrypto, SqliteRunnerSpool } from "@qualigence/runner-spool";
import { dockerAvailable, startMinio, type StartedMinio } from "../../helpers/docker-container.js";
import { makeHello, makeTestClient, startTestServer, welcomeParameters } from "../../helpers/grpc-harness.js";
import { createGrpcTestPki, type GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { setupPostgresFixture, type PostgresFixture } from "../../helpers/postgres-fixture.js";
import { WEB_GRAPH_V1_REQUIREMENTS, webJob } from "../../helpers/core-runner-harness.js";

const TENANT_ID = "tenant-e2e-artifact-upload";
const PROJECT_ID = "project-artifact-upload";
const RUNNER_ID = "runner-artifact-upload";
const RUN_ID = "run-artifact-upload";
const JOB_ID = "job-artifact-upload";
const ARTIFACT_ID = "artifact-upload-e2e";
const CREATED_AT = "2026-08-25T00:00:00.000Z";
const CLOCK = { now: () => CREATED_AT };
const BUCKET = "qualigence-artifacts";

let runtime: TenantTransactionProvider | undefined;
let s3: S3Client | undefined;

/**
 * Ticket 11's production Self-hosted resolver currently exposes the Artifact
 * upload seam with PostgreSQL state; S3/MinIO composition is not yet wired into
 * apps/server (reserved for later LS-11 evidence work). This acceptance keeps
 * the same tenant-bound Runner application graph and gRPC path, but supplies the
 * repo's real S3ArtifactStore against MinIO so bytes are verified through real
 * object storage rather than an in-process fake.
 */
describe("Self-hosted Artifact upload acceptance", () => {
  let postgres: PostgresFixture;
  let minio: StartedMinio;
  let pki: GrpcTestPki;
  let server: Awaited<ReturnType<typeof startTestServer>>["server"];
  let port: number;
  let spoolRoot: string | undefined;

  beforeAll(async () => {
    if (!dockerAvailable()) {
      throw new Error("DockerUnavailable: PostgreSQL and MinIO are required for self-hosted Artifact upload acceptance");
    }

    postgres = await setupPostgresFixture();
    runtime = createPostgresRuntime(postgres.serverConfig);
    minio = await startMinio();
    s3 = new S3Client({
      endpoint: minio.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
    });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    spoolRoot = await mkdtemp(join(tmpdir(), "qualigence-e2e-artifact-upload-"));

    pki = createGrpcTestPki();
    const resolver = new TenantRunnerApplicationResolver({
      welcome: welcomeParameters({
        traceBatchMaximumBytes: 1024 * 1024,
        maximumPendingWriteBytes: 1024 * 1024,
      }),
      runnerControlStore: (tenantId) => new OperationScopedPostgresRunnerControlStore(runtimeProvider(), tenantId, { projectSelfHostedCompletion: true }),
      traceStore: (tenantId) => new OperationScopedPostgresTraceStore(runtimeProvider(), tenantId, CLOCK),
      artifactUploads: (tenantId) => new ArtifactUploadService({
        uploads: new OperationScopedPostgresArtifactUploadStore(runtimeProvider(), tenantId),
        artifactStore: s3Store(tenantId, PROJECT_ID),
        artifactStoreForManifest: (manifest) => s3Store(tenantId, manifest.projectId),
        manifestStore: new OperationScopedPostgresArtifactManifestStore(runtimeProvider(), tenantId),
        clock: CLOCK,
      }),
      integrityEvents: { emit: () => undefined },
      now: () => Date.parse(CREATED_AT),
    });
    ({ server, port } = await startTestServer(pki, {
      authenticator: tenantAuthenticator(),
      applicationResolver: resolver,
    }));
  }, 240_000);

  afterAll(async () => {
    await server?.shutdown();
    s3?.destroy();
    await runtime?.close();
    await postgres?.stop();
    await minio?.stop();
    if (spoolRoot !== undefined) await rm(spoolRoot, { recursive: true, force: true });
  });

  it("ACKs a resumable MinIO-backed Artifact before allowing Trace to reference it across reconnect", async () => {
    const job = artifactJob();
    await seedExecutionRun(job);

    if (spoolRoot === undefined) throw new Error("Runner spool root is not initialized");
    const spool = await SqliteRunnerSpool.open({
      databaseFile: join(spoolRoot, "runner-spool.db"),
      crypto: new AesGcmSpoolCrypto(randomBytes(32)),
    });
    const artifactBytes = patternedBytes(ARTIFACT_CHUNK_SIZE_BYTES + 17);
    const manifest = manifestFor(artifactBytes, job);
    const chunks = chunksFor(manifest, artifactBytes);
    const trace = traceReferencing(manifest.artifactId, job.runId);
    await spool.saveArtifactManifest(manifest);
    for (const chunk of chunks) await spool.saveArtifactChunk(chunk);
    await spool.append(trace);

    const client = makeTestClient(pki, port, pki.clientFor(RUNNER_ID));
    try {
      const session = await client.connect(makeHello(RUNNER_ID));
      const connection = await server.waitForConnection({ tenantId: TENANT_ID, runnerId: RUNNER_ID });
      const offered = connection.offer(job, WEB_GRAPH_V1_REQUIREMENTS);
      const offer = await session.nextOffer(new AbortController().signal);
      expect(offer.job).toEqual(job);
      const lease = await session.accept(offer.offerId);
      await spool.saveLease(lease);
      await expect(offered).resolves.toMatchObject({ jobId: JOB_ID, runId: RUN_ID });

      await expect(session.submit(batch(trace, "premature-trace"))).rejects.toMatchObject({ code: "ArtifactUnacknowledged" });
      await expect(traceCursor()).resolves.toBe(1);
      await expect(storedTrace()).resolves.toBeUndefined();
      await expect(storedManifests()).resolves.toEqual([]);

      const resumed = await client.connect(makeHello(RUNNER_ID, { resumeToken: session.welcome.resumeToken }));
      const registered = await resumed.registerArtifactManifest!({
        jobId: lease.jobId,
        runId: lease.runId,
        leaseEpoch: lease.leaseEpoch,
        leaseToken: lease.leaseToken,
        manifest,
      });
      await spool.acknowledgeArtifactProgress(registered);
      expect(registered).toEqual({
        artifactId: ARTIFACT_ID,
        runId: RUN_ID,
        acknowledged: false,
        missingRanges: [
          { offset: 0, length: ARTIFACT_CHUNK_SIZE_BYTES },
          { offset: ARTIFACT_CHUNK_SIZE_BYTES, length: 17 },
        ],
      });

      const firstChunk = await resumed.uploadArtifactChunk!({
        jobId: lease.jobId,
        runId: lease.runId,
        leaseEpoch: lease.leaseEpoch,
        leaseToken: lease.leaseToken,
        chunk: chunks[0]!,
      });
      await spool.acknowledgeArtifactProgress(firstChunk);
      expect(firstChunk).toEqual({
        artifactId: ARTIFACT_ID,
        runId: RUN_ID,
        acknowledged: false,
        missingRanges: [{ offset: ARTIFACT_CHUNK_SIZE_BYTES, length: 17 }],
      });
      await expect(storedManifests()).resolves.toEqual([]);
      await expect(traceCursor()).resolves.toBe(1);

      const replaySession = await client.connect(makeHello(RUNNER_ID, { resumeToken: resumed.welcome.resumeToken }));
      const calls: string[] = [];
      await expect(replayPendingRuns(recordingReplaySession(replaySession, calls), spool)).resolves.toEqual([RUN_ID]);
      expect(calls).toEqual([`artifact:chunk:${ARTIFACT_CHUNK_SIZE_BYTES}`, "trace:1"]);

      await expect(traceCursor()).resolves.toBe(2);
      await expect(storedTrace()).resolves.toMatchObject({ runId: RUN_ID, sequenceNumber: 1, stage: "finding" });
      await expect(spool.pendingArtifactManifests(RUN_ID)).resolves.toEqual([]);
      await expect(spool.pending(RUN_ID, 1, replayBatchLimit(replaySession))).resolves.toEqual([]);

      const manifests = await storedManifests();
      expect(manifests).toHaveLength(1);
      expect(manifests[0]).toMatchObject({
        artifactId: ARTIFACT_ID,
        runId: RUN_ID,
        sha256: sha256(artifactBytes),
        size: artifactBytes.length,
      });
      expect(manifests[0]!.relativePath).toBe(`${TENANT_ID}/${PROJECT_ID}/${RUN_ID}/${ARTIFACT_ID}/${sha256(artifactBytes).slice(0, 2)}/${sha256(artifactBytes)}`);
      await expect(s3Store(TENANT_ID, PROJECT_ID).read(manifests[0]!)).resolves.toEqual(artifactBytes);
      await expect(uploadSnapshot()).resolves.toMatchObject({
        status: "verified",
        relativePath: manifests[0]!.relativePath,
      });
    } finally {
      await client.close();
      await spool.close();
    }
  }, 240_000);
});

function s3Store(tenantId: string, projectId: string): S3ArtifactStore {
  return new S3ArtifactStore({ client: s3Client(), bucket: BUCKET, tenantId, projectId, clock: CLOCK });
}

function s3Client(): S3Client {
  if (s3 === undefined) throw new Error("S3 client is not initialized");
  return s3;
}

function tenantAuthenticator() {
  return {
    authenticate: async (_peer: unknown, hello: RunnerHello): Promise<AuthenticatedRunnerContext> => ({
      runnerId: hello.runnerId,
      certificateFingerprint: `fp-${hello.runnerId}`,
      scope: { kind: "tenant", tenantId: TENANT_ID, projectIds: [PROJECT_ID] },
    }),
  };
}

function artifactJob(): AcceptedExecutionJob {
  return webJob({
    jobId: JOB_ID,
    runId: RUN_ID,
    projectId: PROJECT_ID,
    policy: {
      ...webJob().policy,
      allowedOrigins: ["https://shop.example.test"],
      issuedAt: CREATED_AT,
      expiresAt: "2026-08-25T00:01:00.000Z",
    },
    plan: {
      missionId: "mission-artifact-upload",
      missionRevision: 1,
      testCaseId: "case-artifact-upload",
      steps: [{ kind: "verify", claimIds: ["claim-artifact"] as [string] }],
      expectedClaimIds: ["claim-artifact"] as [string],
      budget: { maximumStepsPerJob: 1, maximumWallClockMs: 60_000, maximumModelTokens: 1_000 },
    },
  });
}

async function seedExecutionRun(job: AcceptedExecutionJob): Promise<void> {
  await runtimeProvider().withTenant(TENANT_ID, async ({ db }) => {
    await db.insertInto("execution_runs").values({
      tenant_id: TENANT_ID,
      run_id: job.runId,
      job_id: job.jobId,
      target_kind: "web",
      objective: job.objective,
      status: "running",
      next_sequence_number: 1,
      created_at: CREATED_AT,
      completed_at: null,
      error_code: null,
    } as never).execute();
  });
}

function runtimeProvider(): TenantTransactionProvider {
  if (runtime === undefined) throw new Error("PostgreSQL runtime is not initialized");
  return runtime;
}

function manifestFor(bytes: Uint8Array, job: AcceptedExecutionJob): ArtifactUploadManifest {
  return {
    artifactId: ARTIFACT_ID,
    tenantId: TENANT_ID,
    projectId: job.projectId,
    runId: job.runId,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    mediaType: "application/octet-stream",
    sensitivity: "internal",
    chunkSizeBytes: ARTIFACT_CHUNK_SIZE_BYTES,
    totalChunks: Math.ceil(bytes.length / ARTIFACT_CHUNK_SIZE_BYTES),
  };
}

function chunksFor(manifest: ArtifactUploadManifest, bytes: Uint8Array): readonly ArtifactUploadChunk[] {
  const chunks: ArtifactUploadChunk[] = [];
  for (let offset = 0; offset < bytes.length; offset += ARTIFACT_CHUNK_SIZE_BYTES) {
    const chunkBytes = bytes.slice(offset, Math.min(offset + ARTIFACT_CHUNK_SIZE_BYTES, bytes.length));
    chunks.push({
      artifactId: manifest.artifactId,
      tenantId: manifest.tenantId,
      projectId: manifest.projectId,
      runId: manifest.runId,
      offset,
      bytes: chunkBytes,
      sha256: sha256(chunkBytes),
    });
  }
  return chunks;
}

function traceReferencing(artifactId: string, runId: string): TraceEvent {
  const base = {
    protocolVersion: "runner-protocol/v1" as const,
    schemaVersion: "trace-event/v1" as const,
    messageId: "trace-artifact-upload-1",
    idempotencyKey: "trace-artifact-upload-1",
    runId,
    sequenceNumber: 1,
    stage: "finding" as const,
    occurredAt: CREATED_AT,
    payload: {
      findingId: "finding-artifact-upload",
      runId,
      title: "Artifact upload accepted",
      summary: "Trace references the uploaded object-storage Artifact only after ACK.",
      severity: "medium" as const,
      evidenceRefs: [artifactId],
    },
  };
  return { ...base, payloadHash: canonicalTraceEventHash(base) };
}

function batch(event: TraceEvent, batchId: string): ExecutionEventBatch {
  return { batchId, runId: event.runId, firstSequenceNumber: event.sequenceNumber, events: [event] };
}

function recordingReplaySession(session: RunnerSession, calls: string[]): RunnerSession {
  return {
    welcome: session.welcome,
    nextOffer: session.nextOffer.bind(session),
    accept: session.accept.bind(session),
    renew: session.renew.bind(session),
    registerArtifactManifest: async (registration) => {
      calls.push("artifact:manifest");
      return session.registerArtifactManifest!(registration);
    },
    uploadArtifactChunk: async (upload) => {
      calls.push(`artifact:chunk:${upload.chunk.offset}`);
      return session.uploadArtifactChunk!(upload);
    },
    submit: async (submitted) => {
      calls.push(`trace:${submitted.firstSequenceNumber}`);
      return session.submit(submitted);
    },
    complete: session.complete.bind(session),
    close: session.close.bind(session),
  };
}

function replayBatchLimit(session: RunnerSession): { readonly maximumEvents: number; readonly maximumBytes: number } {
  return {
    maximumEvents: session.welcome.traceBatchMaximumEvents,
    maximumBytes: session.welcome.traceBatchMaximumBytes,
  };
}

async function traceCursor(): Promise<number> {
  return new OperationScopedPostgresTraceStore(runtimeProvider(), TENANT_ID, CLOCK).nextTraceSequenceNumber(RUN_ID);
}

async function storedTrace(): Promise<TraceEvent | undefined> {
  return new OperationScopedPostgresTraceStore(runtimeProvider(), TENANT_ID, CLOCK).eventAt(RUN_ID, 1);
}

async function storedManifests() {
  return new OperationScopedPostgresArtifactManifestStore(runtimeProvider(), TENANT_ID).listForRun(RUN_ID);
}

async function uploadSnapshot(): Promise<{ readonly status: string; readonly relativePath: string | null }> {
  return runtimeProvider().withTenant(TENANT_ID, async ({ db }) => {
    const row = await db
      .selectFrom("artifact_upload_manifests")
      .select(["status", "relative_path"])
      .where("tenant_id", "=", TENANT_ID)
      .where("artifact_id", "=", ARTIFACT_ID)
      .executeTakeFirstOrThrow();
    return { status: row.status, relativePath: row.relative_path };
  });
}

function patternedBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
