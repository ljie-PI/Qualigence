import { createHash, randomBytes } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { S3ArtifactStore } from "@qualigence/artifact-s3";
import { SelfHostedKms } from "@qualigence/kms-self-hosted";
import { ClaimMapper, OidcAuthenticator, RbacAuthorizer, StaticJwksResolver } from "@qualigence/oidc";
import {
  createPostgresRuntime,
  PostgresEvidenceLifecycleStore,
  PostgresReviewTaskRepository,
  PostgresSelfHostedKmsKeyStore,
  type PostgresConnectionConfig,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { ARTIFACT_CHUNK_SIZE_BYTES } from "@qualigence/runner-protocol";
import { PemCaRunnerCertificateIssuer } from "@qualigence/runner-mtls";
import {
  bootstrapServerDatabase,
  buildServer,
  PostgresRunnerEnrollmentStore,
  PostgresRunnerPrincipalStore,
  type ServerDeps,
  type TenantStores,
} from "@qualigence/server";
import type { ArtifactManifest, EvidenceEncryptionProfile } from "@qualigence/evidence";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerAvailable, startMinio, startPostgres, type StartedMinio, type StartedPostgres } from "../../helpers/docker-container.js";
import { createTestJwtIssuer, standardClaims, type TestJwtIssuer } from "../../helpers/oidc-jwt.js";
import { createRunnerCa } from "../../helpers/runner-identity-pki.js";

const SERVER_ROLE = "qualigence_server";
const SERVER_PASSWORD = "server_pw";
const WORKER_ROLE = "qualigence_worker";
const WORKER_PASSWORD = "worker_pw";
const ISSUER = "https://oidc.example.test/";
const AUDIENCE = "qualigence-self-hosted";
const TENANT_CLAIM = "https://qualigence.example/tenant";
const ROLES_CLAIM = "https://qualigence.example/roles";
const TENANT_A = "tenant-evidence-e2e-a";
const TENANT_B = "tenant-evidence-e2e-b";
const BUCKET = "qualigence-evidence-api";
const NOW = "2026-08-25T00:00:00.000Z";
const CLOCK = { now: () => NOW };

describe("Self-hosted Evidence API S3/KMS acceptance", () => {
  let fx: EvidenceApiFixture;

  beforeAll(async () => {
    if (!dockerAvailable()) {
      throw new Error("DockerUnavailable: PostgreSQL and MinIO are required for self-hosted Evidence API acceptance");
    }
    fx = await setupEvidenceApiFixture();
  }, 240_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("serves authorized S3-backed metadata and bytes while hiding unauthorized plaintext", async () => {
    const secret = new TextEncoder().encode("authorized S3/KMS evidence plaintext");
    const seeded = await seedEvidenceArtifact(fx, {
      tenantId: TENANT_A,
      projectId: "project-authorized",
      runId: "run-authorized",
      artifactId: "artifact-authorized",
      bytes: secret,
    });
    await seedEvidenceArtifact(fx, {
      tenantId: TENANT_B,
      projectId: "project-hidden",
      runId: "run-hidden",
      artifactId: "artifact-hidden",
      bytes: new TextEncoder().encode("tenant B private evidence plaintext"),
    });

    expect(seeded.manifest.relativePath).toBe(
      `${TENANT_A}/project-authorized/run-authorized/${seeded.manifest.sha256.slice(0, 2)}/${seeded.manifest.sha256}`,
    );
    await expect(fx.liveStore(TENANT_A, "project-authorized").read(seeded.manifest)).resolves.toEqual(secret);
    await expect(kmsKeyVersionCount(fx, TENANT_A)).resolves.toBeGreaterThan(0);

    const tenantAHeaders = { authorization: `Bearer ${fx.token(TENANT_A, ["viewer"])}` };
    const metadata = await fetch(fx.url("/v1/projects/project-authorized/runs/run-authorized/artifacts/artifact-authorized?purpose=investigation"), {
      headers: tenantAHeaders,
    });
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      artifactId: "artifact-authorized",
      runId: "run-authorized",
      kind: "log",
      mediaType: "text/plain",
      size: secret.byteLength,
      sha256: sha256(secret),
      downloadAllowed: true,
    });

    const bytes = await fetch(fx.url("/v1/projects/project-authorized/runs/run-authorized/artifacts/artifact-authorized/bytes?purpose=investigation"), {
      headers: tenantAHeaders,
    });
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toContain("text/plain");
    expect(await bytes.text()).toBe("authorized S3/KMS evidence plaintext");
    const authorizedAudit = await evidenceAuditReasons(fx, TENANT_A, "artifact-authorized");
    expect(authorizedAudit).toEqual(expect.arrayContaining([
      "profile:allowed:metadata_access",
      "unwrap:allowed:plaintext_access",
    ]));
    expect(authorizedAudit).toHaveLength(2);

    const wrongPurpose = await fetch(fx.url("/v1/projects/project-authorized/runs/run-authorized/artifacts/artifact-authorized/bytes?purpose=export"), {
      headers: tenantAHeaders,
    });
    expect(wrongPurpose.status).toBe(422);
    expect(await wrongPurpose.text()).not.toContain("authorized S3/KMS evidence plaintext");

    const hidden = await fetch(fx.url("/v1/projects/project-hidden/runs/run-hidden/artifacts/artifact-hidden/bytes?purpose=investigation"), {
      headers: tenantAHeaders,
    });
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain("tenant B private evidence plaintext");
  }, 180_000);

  it("runs lifecycle revoke-before-delete through durable KMS and S3 providers", async () => {
    const seeded = await seedEvidenceArtifact(fx, {
      tenantId: TENANT_A,
      projectId: "project-lifecycle",
      runId: "run-lifecycle",
      artifactId: "artifact-lifecycle",
      bytes: new TextEncoder().encode("lifecycle plaintext evidence"),
    });
    await expect(fx.liveStore(TENANT_A, "project-lifecycle").verify(seeded.manifest)).resolves.toBe(true);

    const deleted = await fetch(fx.url("/v1/projects/project-lifecycle/runs/run-lifecycle/artifacts/artifact-lifecycle?purpose=investigation"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${fx.token(TENANT_A, ["admin"])}` },
    });
    expect(deleted.status).toBe(202);
    expect(await deleted.json()).toEqual({ artifactId: "artifact-lifecycle", lifecycleState: "deleted" });

    await expect(fx.liveStore(TENANT_A, "project-lifecycle").verify(seeded.manifest)).resolves.toBe(false);
    await expect(evidenceLifecycleState(fx, TENANT_A, "artifact-lifecycle")).resolves.toEqual({
      state: "deleted",
      ciphertextPresent: false,
    });
    await expect(kmsRevocationExists(fx, TENANT_A, seeded.scopeId, "artifact-lifecycle")).resolves.toBe(true);

    const plaintext = await fetch(fx.url("/v1/projects/project-lifecycle/runs/run-lifecycle/artifacts/artifact-lifecycle/bytes?purpose=investigation"), {
      headers: { authorization: `Bearer ${fx.token(TENANT_A, ["viewer"])}` },
    });
    expect(plaintext.status).toBe(404);
    expect(await plaintext.text()).not.toContain("lifecycle plaintext evidence");
    expect(await evidenceAuditReasons(fx, TENANT_A, "artifact-lifecycle")).toEqual(expect.arrayContaining([
      "revoke:allowed:ok",
      "delete:allowed:ok",
      "unwrap:denied:EvidenceLifecycleNotActive",
    ]));
  }, 180_000);

  it("fails closed without plaintext or false success audit when KMS or S3 providers are unavailable", async () => {
    await seedEvidenceArtifact(fx, {
      tenantId: TENANT_A,
      projectId: "project-kms-unavailable",
      runId: "run-kms-unavailable",
      artifactId: "artifact-kms-unavailable",
      bytes: new TextEncoder().encode("KMS unavailable plaintext must not leak"),
    });
    await seedEvidenceArtifact(fx, {
      tenantId: TENANT_A,
      projectId: "project-s3-unavailable",
      runId: "run-s3-unavailable",
      artifactId: "artifact-s3-unavailable",
      bytes: new TextEncoder().encode("S3 unavailable plaintext must not leak"),
    });

    fx.evidenceKms.setAvailable(false);
    try {
      const kmsUnavailable = await fetch(fx.url("/v1/projects/project-kms-unavailable/runs/run-kms-unavailable/artifacts/artifact-kms-unavailable/bytes?purpose=investigation"), {
        headers: { authorization: `Bearer ${fx.token(TENANT_A, ["viewer"])}` },
      });
      expect(kmsUnavailable.status).toBe(503);
      expect(await kmsUnavailable.text()).not.toContain("KMS unavailable plaintext must not leak");
    } finally {
      fx.evidenceKms.setAvailable(true);
    }

    fx.setObjectStorageAvailable(false);
    try {
      const s3Unavailable = await fetch(fx.url("/v1/projects/project-s3-unavailable/runs/run-s3-unavailable/artifacts/artifact-s3-unavailable/bytes?purpose=investigation"), {
        headers: { authorization: `Bearer ${fx.token(TENANT_A, ["viewer"])}` },
      });
      expect(s3Unavailable.status).toBe(503);
      expect(await s3Unavailable.text()).not.toContain("S3 unavailable plaintext must not leak");
    } finally {
      fx.setObjectStorageAvailable(true);
    }

    expect(await evidenceAuditReasons(fx, TENANT_A, "artifact-kms-unavailable")).toEqual([
      "unwrap:failed:EvidenceKmsUnavailable",
    ]);
    expect(await evidenceAuditReasons(fx, TENANT_A, "artifact-s3-unavailable")).not.toContain(
      "unwrap:allowed:plaintext_access",
    );
  }, 180_000);

  it("keeps ciphertext and revoked retry state when S3 delete is unavailable, then resumes deletion", async () => {
    const seeded = await seedEvidenceArtifact(fx, {
      tenantId: TENANT_A,
      projectId: "project-delete-unavailable",
      runId: "run-delete-unavailable",
      artifactId: "artifact-delete-unavailable",
      bytes: new TextEncoder().encode("delete unavailable plaintext must not leak"),
    });

    fx.setObjectStorageAvailable(false);
    try {
      const failedDelete = await fetch(fx.url("/v1/projects/project-delete-unavailable/runs/run-delete-unavailable/artifacts/artifact-delete-unavailable?purpose=investigation"), {
        method: "DELETE",
        headers: { authorization: `Bearer ${fx.token(TENANT_A, ["admin"])}` },
      });
      expect(failedDelete.status).toBe(503);
      expect(await failedDelete.text()).not.toContain("delete unavailable plaintext must not leak");
    } finally {
      fx.setObjectStorageAvailable(true);
    }

    await expect(fx.liveStore(TENANT_A, "project-delete-unavailable").verify(seeded.manifest)).resolves.toBe(true);
    await expect(evidenceLifecycleState(fx, TENANT_A, "artifact-delete-unavailable")).resolves.toEqual({
      state: "revoked",
      ciphertextPresent: true,
    });
    expect(await evidenceAuditReasons(fx, TENANT_A, "artifact-delete-unavailable")).toEqual(expect.arrayContaining([
      "revoke:allowed:ok",
      "delete:failed:EvidenceDeletionFailed",
    ]));

    const retry = await fetch(fx.url("/v1/projects/project-delete-unavailable/runs/run-delete-unavailable/artifacts/artifact-delete-unavailable?purpose=investigation"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${fx.token(TENANT_A, ["admin"])}` },
    });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ artifactId: "artifact-delete-unavailable", lifecycleState: "deleted" });
    await expect(fx.liveStore(TENANT_A, "project-delete-unavailable").verify(seeded.manifest)).resolves.toBe(false);
    await expect(evidenceLifecycleState(fx, TENANT_A, "artifact-delete-unavailable")).resolves.toEqual({
      state: "deleted",
      ciphertextPresent: false,
    });
  }, 180_000);

  it("retains ciphertext and object bytes when KMS revoke is unavailable", async () => {
    const seeded = await seedEvidenceArtifact(fx, {
      tenantId: TENANT_A,
      projectId: "project-revoke-unavailable",
      runId: "run-revoke-unavailable",
      artifactId: "artifact-revoke-unavailable",
      bytes: new TextEncoder().encode("KMS revoke unavailable plaintext must not leak"),
    });

    fx.evidenceKms.setAvailable(false);
    try {
      const failedDelete = await fetch(fx.url("/v1/projects/project-revoke-unavailable/runs/run-revoke-unavailable/artifacts/artifact-revoke-unavailable?purpose=investigation"), {
        method: "DELETE",
        headers: { authorization: `Bearer ${fx.token(TENANT_A, ["admin"])}` },
      });
      expect(failedDelete.status).toBe(503);
      expect(await failedDelete.text()).not.toContain("KMS revoke unavailable plaintext must not leak");
    } finally {
      fx.evidenceKms.setAvailable(true);
    }

    await expect(fx.liveStore(TENANT_A, "project-revoke-unavailable").verify(seeded.manifest)).resolves.toBe(true);
    await expect(evidenceLifecycleState(fx, TENANT_A, "artifact-revoke-unavailable")).resolves.toEqual({
      state: "revoking",
      ciphertextPresent: true,
    });
    expect(await evidenceAuditReasons(fx, TENANT_A, "artifact-revoke-unavailable")).toEqual([
      "revoke:failed:EvidenceRevocationFailed",
    ]);

    const retry = await fetch(fx.url("/v1/projects/project-revoke-unavailable/runs/run-revoke-unavailable/artifacts/artifact-revoke-unavailable?purpose=investigation"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${fx.token(TENANT_A, ["admin"])}` },
    });
    expect(retry.status).toBe(202);
    await expect(fx.liveStore(TENANT_A, "project-revoke-unavailable").verify(seeded.manifest)).resolves.toBe(false);
  }, 180_000);
});

interface EvidenceApiFixture {
  readonly app: FastifyInstance;
  readonly baseUrl: string;
  readonly jwt: TestJwtIssuer;
  readonly provider: TenantTransactionProvider;
  readonly postgres: StartedPostgres;
  readonly minio: StartedMinio;
  readonly s3: S3Client;
  readonly unavailableS3: S3Client;
  readonly evidenceKms: SelfHostedKms;
  url(path: string): string;
  token(tenantId: string, roles: readonly string[], overrides?: Record<string, unknown>): string;
  liveStore(tenantId: string, projectId: string): S3ArtifactStore;
  setObjectStorageAvailable(available: boolean): void;
  stop(): Promise<void>;
}

async function setupEvidenceApiFixture(): Promise<EvidenceApiFixture> {
  const postgres = await startPostgres();
  const adminConfig: PostgresConnectionConfig = {
    host: postgres.host,
    port: postgres.port,
    database: postgres.database,
    user: postgres.superuser,
    password: postgres.password,
  };
  await bootstrapServerDatabase({
    admin: adminConfig,
    roles: {
      server: { name: SERVER_ROLE, password: SERVER_PASSWORD },
      worker: { name: WORKER_ROLE, password: WORKER_PASSWORD },
    },
  });
  const provider = createPostgresRuntime({ ...adminConfig, user: SERVER_ROLE, password: SERVER_PASSWORD });

  const minio = await startMinio();
  const s3 = new S3Client({
    endpoint: minio.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
  });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  const unavailableS3 = new S3Client({
    endpoint: "http://127.0.0.1:1",
    region: "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
  });

  const jwt = createTestJwtIssuer("RS256");
  const oidc = new OidcAuthenticator({
    issuer: ISSUER,
    audience: AUDIENCE,
    allowedAlgorithms: ["RS256"],
    jwks: new StaticJwksResolver([jwt.signingKey]),
    clock: { now: () => new Date().toISOString() },
    claimMapper: new ClaimMapper({
      tenantClaim: TENANT_CLAIM,
      rolesClaim: ROLES_CLAIM,
      allowedTenants: [TENANT_A, TENANT_B],
      roleMap: {
        "qa-admin": "admin",
        "qa-tester": "tester",
        "qa-reviewer": "reviewer",
        "qa-viewer": "viewer",
      },
    }),
  });
  const ca = createRunnerCa();
  const evidenceKms = new SelfHostedKms({
    rootKey: randomBytes(32),
    keyStore: new PostgresSelfHostedKmsKeyStore(provider),
    now: CLOCK.now,
  });
  let objectStorageAvailable = true;

  const liveStore = (tenantId: string, projectId: string): S3ArtifactStore => new S3ArtifactStore({
    client: s3,
    bucket: BUCKET,
    tenantId,
    projectId,
    clock: CLOCK,
  });
  const deps: ServerDeps = {
    provider,
    oidc,
    rbac: new RbacAuthorizer(),
    issuer: new PemCaRunnerCertificateIssuer({ caCertificatePem: ca.certPem, caPrivateKeyPem: ca.keyPem }),
    caCertificatePem: ca.certPem,
    clock: CLOCK,
    artifactStore: ({ tenantId, projectId }) => new S3ArtifactStore({
      client: objectStorageAvailable ? s3 : unavailableS3,
      bucket: BUCKET,
      tenantId,
      projectId,
      clock: CLOCK,
    }),
    evidenceLifecycleStore: (stores: TenantStores, tenantId: string) => new PostgresEvidenceLifecycleStore(stores.db, tenantId),
    evidenceKeyPolicy: evidenceKms,
    enrollmentStore: (stores: TenantStores) => new PostgresRunnerEnrollmentStore(stores.aux),
    principalStore: (stores: TenantStores) => new PostgresRunnerPrincipalStore(stores.aux),
    reviewRepository: (stores: TenantStores) => new PostgresReviewTaskRepository(stores.db),
  };
  const app = buildServer(deps);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const roleMapReverse: Record<string, string> = {
    admin: "qa-admin",
    tester: "qa-tester",
    reviewer: "qa-reviewer",
    viewer: "qa-viewer",
  };

  return {
    app,
    baseUrl,
    jwt,
    provider,
    postgres,
    minio,
    s3,
    unavailableS3,
    evidenceKms,
    url: (path) => `${baseUrl}${path}`,
    token: (tenantId, roles, overrides = {}) => jwt.sign(standardClaims({
      iss: ISSUER,
      aud: AUDIENCE,
      [TENANT_CLAIM]: tenantId,
      [ROLES_CLAIM]: roles.map((role) => roleMapReverse[role] ?? role),
      ...overrides,
    })),
    liveStore,
    setObjectStorageAvailable(available) {
      objectStorageAvailable = available;
    },
    async stop() {
      await app.close().catch(() => undefined);
      s3.destroy();
      unavailableS3.destroy();
      await provider.close().catch(() => undefined);
      await postgres.stop().catch(() => undefined);
      await minio.stop().catch(() => undefined);
    },
  };
}

async function seedEvidenceArtifact(
  fx: EvidenceApiFixture,
  input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly artifactId: string;
    readonly bytes: Uint8Array;
    readonly lifecycleState?: "active" | "revoking" | "revoked" | "deleting" | "deleted";
    readonly caseId?: string;
    readonly jobCaseId?: string;
    readonly policyId?: string;
  },
): Promise<{ readonly manifest: ArtifactManifest; readonly profile: EvidenceEncryptionProfile; readonly scopeId: string }> {
  const manifest = await fx.liveStore(input.tenantId, input.projectId).write({
    artifactId: input.artifactId,
    runId: input.runId,
    name: `${input.artifactId}.txt`,
    kind: "log",
    mediaType: "text/plain",
    bytes: input.bytes,
  });
  const caseId = input.caseId ?? `case-${input.artifactId}`;
  const jobCaseId = input.jobCaseId ?? caseId;
  const profile = await fx.evidenceKms.encryptionProfile({
    tenantId: input.tenantId,
    caseId,
    region: "self-hosted",
    purpose: "investigation",
  });
  const policyId = input.policyId ?? profile.policyId;
  const lifecycleState = input.lifecycleState ?? "active";
  const protectedHeader = {
    schemaVersion: profile.aadSchemaVersion,
    capsuleId: input.artifactId,
    profileId: profile.profileId,
    payloadSchemaVersion: "evidence-capsule/v1",
    tenantId: input.tenantId,
    caseId,
    recipient: profile.recipient,
    region: profile.region,
    purpose: profile.purpose,
    policyId,
    contentEncryptionAlgorithm: profile.contentEncryptionAlgorithm,
    keyWrappingAlgorithm: profile.keyWrappingAlgorithm,
    wrappingKeyId: profile.wrappingKeyId,
    plaintextSha256: manifest.sha256,
    plaintextBytes: manifest.size,
    createdAt: manifest.createdAt,
    expiresAt: profile.expiresAt,
  };
  const missionId = `mission-${input.artifactId}`;
  const logicalJobId = `logical-${input.artifactId}`;
  const runnerJobId = `runner-job-${input.artifactId}`;
  const attemptId = `attempt-${input.artifactId}`;

  await fx.provider.withTenant(input.tenantId, async ({ db }) => {
    await db.insertInto("missions").values({
      tenant_id: input.tenantId,
      mission_id: missionId,
      revision: 1,
      project_id: input.projectId,
      plan_id: `plan-${input.artifactId}`,
      prd_id: `prd-${input.artifactId}`,
      prd_revision: 1,
      target_id: `target-${input.artifactId}`,
      compiled_hash: `compiled-${input.artifactId}`,
      status: "running",
      dispatch_json: "{}",
      stop_on_blocked: 1,
    } as never).execute();
    await db.insertInto("execution_jobs").values({
      tenant_id: input.tenantId,
      job_id: logicalJobId,
      mission_id: missionId,
      mission_revision: 1,
      test_case_id: jobCaseId,
      objective: "Evidence API read",
      required_capabilities_json: "[]",
      source_refs_json: "[]",
      snapshot_hash: `snapshot-${input.artifactId}`,
      snapshot_json: "{}",
      idempotency_key: logicalJobId,
      status: "queued",
    } as never).execute();
    await db.insertInto("execution_runs").values({
      tenant_id: input.tenantId,
      run_id: input.runId,
      job_id: runnerJobId,
      target_kind: "web",
      objective: "Evidence API read",
      status: "running",
      next_sequence_number: 1,
      created_at: NOW,
      completed_at: null,
      error_code: null,
    } as never).execute();
    await db.insertInto("mission_job_attempts").values({
      tenant_id: input.tenantId,
      attempt_id: attemptId,
      mission_id: missionId,
      mission_revision: 1,
      logical_job_id: logicalJobId,
      runner_job_id: runnerJobId,
      run_id: input.runId,
      status: "accepted",
      created_at: NOW,
    } as never).execute();
    await db.insertInto("artifact_manifests").values({
      tenant_id: input.tenantId,
      artifact_id: manifest.artifactId,
      run_id: manifest.runId,
      kind: manifest.kind,
      media_type: manifest.mediaType,
      relative_path: manifest.relativePath,
      sha256: manifest.sha256,
      size_bytes: manifest.size,
      created_at: manifest.createdAt,
    } as never).execute();
    await db.insertInto("artifact_upload_manifests").values({
      tenant_id: input.tenantId,
      artifact_id: manifest.artifactId,
      project_id: input.projectId,
      run_id: manifest.runId,
      job_id: runnerJobId,
      size_bytes: manifest.size,
      sha256: manifest.sha256,
      media_type: manifest.mediaType,
      sensitivity: "sensitive",
      chunk_size_bytes: ARTIFACT_CHUNK_SIZE_BYTES,
      total_chunks: Math.ceil(manifest.size / ARTIFACT_CHUNK_SIZE_BYTES),
      registered_by_runner_id: `runner-${input.artifactId}`,
      registered_lease_epoch: 1,
      status: "verified",
      relative_path: manifest.relativePath,
      created_at: manifest.createdAt,
      verified_at: manifest.createdAt,
    } as never).execute();
    await db.insertInto("evidence_encryption_profiles").values({
      tenant_id: input.tenantId,
      profile_id: profile.profileId,
      case_id: profile.caseId,
      recipient: profile.recipient,
      region: profile.region,
      purpose: profile.purpose,
      policy_id: profile.policyId,
      wrapping_key_id: profile.wrappingKeyId,
      wrapping_public_key_pem: profile.wrappingPublicKeyPem,
      content_encryption_algorithm: profile.contentEncryptionAlgorithm,
      key_wrapping_algorithm: profile.keyWrappingAlgorithm,
      aad_schema_version: profile.aadSchemaVersion,
      allowed_entry_kinds_json: JSON.stringify(profile.allowedEntryKinds),
      maximum_entry_bytes: profile.maximumEntryBytes,
      maximum_plaintext_bytes: profile.maximumPlaintextBytes,
      maximum_ciphertext_bytes: profile.maximumCiphertextBytes,
      expires_at: profile.expiresAt,
      created_at: manifest.createdAt,
    } as never).onConflict((oc) => oc.columns(["tenant_id", "profile_id"]).doNothing()).execute();
    await db.insertInto("evidence_capsule_manifests").values({
      tenant_id: input.tenantId,
      capsule_id: input.artifactId,
      revision: 1,
      parent_revision: null,
      profile_id: profile.profileId,
      payload_schema_version: "evidence-capsule/v1",
      aad_schema_version: profile.aadSchemaVersion,
      case_id: caseId,
      recipient: profile.recipient,
      region: profile.region,
      purpose: profile.purpose,
      policy_id: policyId,
      content_encryption_algorithm: profile.contentEncryptionAlgorithm,
      key_wrapping_algorithm: profile.keyWrappingAlgorithm,
      wrapping_key_id: profile.wrappingKeyId,
      plaintext_sha256: manifest.sha256,
      plaintext_bytes: manifest.size,
      ciphertext_sha256: manifest.sha256,
      ciphertext_bytes: manifest.size,
      ciphertext: Buffer.from(input.bytes),
      wrapped_dek_base64: "acceptance-wrapped-dek",
      nonce_base64: "acceptance-nonce",
      auth_tag_base64: "acceptance-tag",
      protected_header_json: JSON.stringify(protectedHeader),
      revocation_state: lifecycleState === "active" || lifecycleState === "revoking" ? "active" : "revoked",
      revoked_at: lifecycleState === "active" || lifecycleState === "revoking" ? null : manifest.createdAt,
      revoked_reason: lifecycleState === "active" || lifecycleState === "revoking" ? null : "test",
      lifecycle_state: lifecycleState,
      lifecycle_updated_at: manifest.createdAt,
      deleted_at: lifecycleState === "deleted" ? manifest.createdAt : null,
      last_lifecycle_error: null,
      created_at: manifest.createdAt,
      expires_at: profile.expiresAt,
    } as never).execute();
  });

  return { manifest, profile, scopeId: `${input.tenantId}|${caseId}|self-hosted|investigation` };
}

async function evidenceAuditReasons(fx: EvidenceApiFixture, tenantId: string, capsuleId: string): Promise<readonly string[]> {
  return fx.provider.withTenant(tenantId, async ({ db }) => {
    const rows = await db
      .selectFrom("evidence_audit_events")
      .select(["operation", "decision", "reason_code"])
      .where("tenant_id", "=", tenantId)
      .where("capsule_id", "=", capsuleId)
      .orderBy("occurred_at", "asc")
      .execute();
    return rows.map((row) => `${row.operation}:${row.decision}:${row.reason_code}`);
  });
}

async function evidenceLifecycleState(fx: EvidenceApiFixture, tenantId: string, capsuleId: string): Promise<{ readonly state: string; readonly ciphertextPresent: boolean } | undefined> {
  return fx.provider.withTenant(tenantId, async ({ db }) => {
    const row = await db
      .selectFrom("evidence_capsule_manifests")
      .select(["lifecycle_state", "ciphertext"])
      .where("tenant_id", "=", tenantId)
      .where("capsule_id", "=", capsuleId)
      .orderBy("revision", "desc")
      .executeTakeFirst();
    return row === undefined ? undefined : { state: row.lifecycle_state, ciphertextPresent: row.ciphertext !== null };
  });
}

async function kmsKeyVersionCount(fx: EvidenceApiFixture, tenantId: string): Promise<number> {
  return fx.provider.withTenant(tenantId, async ({ db }) => {
    const row = await db
      .selectFrom("self_hosted_kms_key_versions")
      .select(({ fn }) => fn.count<number>("key_id").as("count"))
      .where("tenant_id", "=", tenantId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  });
}

async function kmsRevocationExists(fx: EvidenceApiFixture, tenantId: string, scopeId: string, capsuleId: string): Promise<boolean> {
  return fx.provider.withTenant(tenantId, async ({ db }) => {
    const row = await db
      .selectFrom("self_hosted_kms_capsule_revocations")
      .select("capsule_id")
      .where("tenant_id", "=", tenantId)
      .where("scope_id", "=", scopeId)
      .where("capsule_id", "=", capsuleId)
      .executeTakeFirst();
    return row !== undefined;
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
