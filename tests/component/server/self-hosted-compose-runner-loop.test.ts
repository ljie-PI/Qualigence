import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactManifest, ArtifactStore, ArtifactWriteRequest } from "@qualigence/evidence";
import { loadServerConfig, type ServerConfig } from "../../../apps/server/src/config.js";
import { main, probeArtifactStore, readinessReport } from "../../../apps/server/src/main.js";
import { buildServer } from "../../../apps/server/src/server.js";
import type { ServerDeps, ServerReadinessReport } from "../../../apps/server/src/server-context.js";
import { IntelligenceResultConsumerLoop } from "../../../apps/server/src/intelligence-result-consumer-loop.js";
import { MissionDispatchLoop } from "../../../apps/server/src/mission-dispatch-loop.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

class RecordingArtifactStore implements ArtifactStore {
  readonly operations: string[] = [];
  failRead = false;
  protected bytes = new Map<string, Uint8Array>();

  async write(request: ArtifactWriteRequest): Promise<ArtifactManifest> {
    this.operations.push("write");
    this.bytes.set(request.artifactId, request.bytes);
    return {
      artifactId: request.artifactId,
      runId: request.runId,
      kind: request.kind,
      mediaType: request.mediaType,
      relativePath: `readiness/${request.artifactId}`,
      sha256: "probe-sha256",
      size: request.bytes.length,
      createdAt: "2026-08-26T00:00:00.000Z",
    };
  }

  async read(manifest: ArtifactManifest): Promise<Uint8Array> {
    this.operations.push("read");
    if (this.failRead) throw new Error("S3 read denied");
    return this.bytes.get(manifest.artifactId) ?? new Uint8Array();
  }

  async verify(): Promise<boolean> {
    this.operations.push("verify");
    return true;
  }

  async delete(manifest: ArtifactManifest): Promise<void> {
    this.operations.push("delete");
    this.bytes.delete(manifest.artifactId);
  }
}

class StallingArtifactStore extends RecordingArtifactStore {
  override async write(request: ArtifactWriteRequest): Promise<ArtifactManifest> {
    this.operations.push("write");
    this.bytes.set(request.artifactId, request.bytes);
    return new Promise<ArtifactManifest>(() => undefined);
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Self-hosted Server readiness endpoints", () => {
  it("keeps liveness cheap while readiness is dependency-backed", async () => {
    const source = await readFile(join(process.cwd(), "apps/server/src/server.ts"), "utf8");
    expect(source).toContain('app.get("/livez"');
    expect(source).toContain('app.get("/readyz"');
    expect(source).toContain('report.status === "ready" ? 200 : 503');
  });

  it("wires readiness checks for private infrastructure, OIDC/JWKS, Runner gRPC, dispatch, and Result consumption", async () => {
    const source = await readFile(join(process.cwd(), "apps/server/src/main.ts"), "utf8");
    for (const check of [
      "postgres",
      "object_storage",
      "artifact_data_plane",
      "kms",
      "oidc_jwks",
      "runner_grpc",
      "mission_dispatch",
      "intelligence_result_consumer",
    ]) {
      expect(source).toContain(`name: "${check}"`);
    }
  });

  it("reports readiness failure and recovery transitions through the Server endpoint", async () => {
    let report: ServerReadinessReport = {
      status: "not-ready",
      checks: [{ name: "oidc_jwks", status: "fail", code: "Unavailable", safeMessage: "OIDC JWKS dependency probe failed" }],
    };
    const app = buildServer({ readiness: () => report } as unknown as ServerDeps);
    try {
      const failing = await app.inject({ method: "GET", url: "/readyz" });
      expect(failing.statusCode).toBe(503);
      expect(failing.json()).toMatchObject({
        status: "not-ready",
        checks: [expect.objectContaining({ name: "oidc_jwks", status: "fail" })],
      });

      report = {
        status: "ready",
        checks: [{ name: "oidc_jwks", status: "pass", safeMessage: "OIDC JWKS dependency is available" }],
      };
      const recovered = await app.inject({ method: "GET", url: "/readyz" });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toMatchObject({ status: "ready" });
    } finally {
      await app.close();
    }
  });

  it("exercises the constructed artifact store for object-storage readiness", async () => {
    const store = new RecordingArtifactStore();
    await expect(probeArtifactStore(store, "server")).resolves.toBeUndefined();
    expect(store.operations).toEqual(["write", "read", "verify", "delete"]);

    const failing = new RecordingArtifactStore();
    failing.failRead = true;
    await expect(probeArtifactStore(failing, "server")).rejects.toThrow(/S3 read denied/);
    expect(failing.operations).toEqual(["write", "read", "delete"]);
  });

  it("returns stable not-ready object-storage evidence when the constructed S3 probe stalls", async () => {
    const store = new StallingArtifactStore();
    const started = Date.now();
    const report = await readinessReport({
      config: readinessConfig(),
      provider: {} as never,
      artifactStore: () => store,
      runnerGrpcReady: false,
      missionDispatchLoops: [],
      resultConsumerLoop: { readiness: () => ({ status: "ready", active: true, aborted: false, inFlight: false, consecutiveFailures: 0, lastSuccessfulObservationAt: "2026-08-26T00:00:00.000Z" }) } as never,
      jwks: { resolve: async () => undefined, refresh: async () => undefined, readiness: () => ({ status: "ready", keyCount: 1 }) },
      objectStorageProbeTimeoutMs: 5,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "object_storage",
        status: "fail",
        code: "Unavailable",
        details: expect.objectContaining({
          error: expect.stringContaining("object storage readiness probe timed out after 5ms during write"),
        }),
      }),
    ]));
    expect(store.operations).toEqual(["write"]);
  });

  it("reports object-storage failure and recovery from the configured S3 artifact store, not a MinIO health URL", async () => {
    const store = new RecordingArtifactStore();
    const report = await readinessReport({
      config: readinessConfig(),
      provider: {} as never,
      artifactStore: () => store,
      runnerGrpcReady: false,
      missionDispatchLoops: [],
      resultConsumerLoop: { readiness: () => ({ status: "ready", active: true, aborted: false, inFlight: false, consecutiveFailures: 0, lastSuccessfulObservationAt: "2026-08-26T00:00:00.000Z" }) } as never,
      jwks: { resolve: async () => undefined, refresh: async () => undefined, readiness: () => ({ status: "ready", keyCount: 1 }) },
    });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "object_storage", status: "pass" }),
    ]));
    expect(store.operations).toEqual(["write", "read", "verify", "delete"]);

    const failing = new RecordingArtifactStore();
    failing.failRead = true;
    const failed = await readinessReport({
      config: readinessConfig(),
      provider: {} as never,
      artifactStore: () => failing,
      runnerGrpcReady: false,
      missionDispatchLoops: [],
      resultConsumerLoop: { readiness: () => ({ status: "ready", active: true, aborted: false, inFlight: false, consecutiveFailures: 0, lastSuccessfulObservationAt: "2026-08-26T00:00:00.000Z" }) } as never,
      jwks: { resolve: async () => undefined, refresh: async () => undefined, readiness: () => ({ status: "ready", keyCount: 1 }) },
    });
    expect(failed.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "object_storage", status: "fail", code: "Unavailable" }),
    ]));
  });

  it("keeps Server dispatch and Result-consumer loops not-ready until a successful startup/restart observation", async () => {
    const clock = { now: () => "2026-08-26T00:00:00.000Z" };
    const dispatchCallbacks: Array<() => void> = [];
    const dispatchLoop = new MissionDispatchLoop({
      tenantId: "tenant-a",
      repository: {
        pendingDispatches: async () => [],
        markDispatchAccepted: async () => { throw new Error("no dispatches expected"); },
        markDispatchBlocked: async () => { throw new Error("no dispatches expected"); },
      },
      runners: { connectionFor: () => undefined },
      leases: { lease: async () => undefined },
      clock,
      setTimeout: (callback) => {
        dispatchCallbacks.push(callback);
        return { timer: true };
      },
      clearTimeout: () => undefined,
    });

    expect(dispatchLoop.readiness()).toMatchObject({ status: "not-ready", active: false });
    dispatchLoop.start();
    expect(dispatchLoop.readiness()).toMatchObject({ status: "not-ready", active: true });
    dispatchCallbacks.shift()?.();
    await waitFor(() => dispatchLoop.readiness().status === "ready");
    expect(dispatchLoop.readiness().lastSuccessfulObservationAt).toBe("2026-08-26T00:00:00.000Z");
    await dispatchLoop.stop();
    dispatchLoop.start();
    expect(dispatchLoop.readiness()).toMatchObject({ status: "not-ready", active: true });
    dispatchCallbacks.shift()?.();
    await waitFor(() => dispatchLoop.readiness().status === "ready");
    await dispatchLoop.stop();

    const makeResultLoop = (): { readonly loop: IntelligenceResultConsumerLoop; readonly callbacks: Array<() => void> } => {
      const callbacks: Array<() => void> = [];
      return {
        callbacks,
        loop: new IntelligenceResultConsumerLoop({
          consumerId: "consumer-a",
          wakeups: {
            claimDueTenants: async () => [],
            complete: async () => "completed",
            retry: async () => "scheduled",
          },
          consumer: { consumeForTenant: async () => ({ applied: 0, duplicate: 0, recompute: 0, rejected: 0, processed: 0, hasMore: false, dispositions: [] }) },
          setTimeout: (callback) => {
            callbacks.push(callback);
            return { timer: true };
          },
          clearTimeout: () => undefined,
        }),
      };
    };

    const firstResult = makeResultLoop();
    expect(firstResult.loop.readiness()).toMatchObject({ status: "not-ready", active: false });
    firstResult.loop.start();
    expect(firstResult.loop.readiness()).toMatchObject({ status: "not-ready", active: true });
    firstResult.callbacks.shift()?.();
    await waitFor(() => firstResult.loop.readiness().status === "ready");
    expect(firstResult.loop.readiness().lastSuccessfulObservationAt).toBeDefined();
    await firstResult.loop.stop();

    const restartedResult = makeResultLoop();
    restartedResult.loop.start();
    expect(restartedResult.loop.readiness()).toMatchObject({ status: "not-ready", active: true });
    restartedResult.callbacks.shift()?.();
    await waitFor(() => restartedResult.loop.readiness().status === "ready");
    await restartedResult.loop.stop();
  });
});

describe("Self-hosted Server configuration", () => {
  it("loads the dedicated Runner gRPC listener, dispatch tenant list, and constructed S3 settings from files/env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qualigence-server-config-"));
    tempDirs.push(dir);
    const files = await writeConfigFiles(dir);

    const config = loadServerConfig({
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: "18080",
      SERVER_PG_HOST: "postgres",
      SERVER_PG_PORT: "5432",
      SERVER_PG_DATABASE: "qualigence",
      SERVER_PG_USER: "qualigence_server",
      SERVER_PG_PASSWORD: "server_pw",
      SERVER_RUNNER_GRPC_HOST: "0.0.0.0",
      SERVER_RUNNER_GRPC_PORT: "50555",
      SERVER_RUNNER_GRPC_TLS_CERT_FILE: files.runnerServerCert,
      SERVER_RUNNER_GRPC_TLS_KEY_FILE: files.runnerServerKey,
      SERVER_TENANT_IDS: "tenant-a, tenant-b, tenant-a",
      SERVER_S3_ENDPOINT: "http://minio:9000",
      SERVER_S3_REGION: "us-east-1",
      SERVER_S3_BUCKET: "qualigence-artifacts",
      SERVER_S3_ACCESS_KEY_ID_FILE: files.s3AccessKeyId,
      SERVER_S3_SECRET_ACCESS_KEY_FILE: files.s3SecretAccessKey,
      SERVER_S3_FORCE_PATH_STYLE: "true",
      SERVER_KMS_ROOT_KEY_BASE64_FILE: files.kmsRootKey,
      SERVER_ARTIFACT_DATA_DIR: "/var/lib/qualigence/artifacts",
      SERVER_SKILL_SIGNING_DATA_DIR: "/var/lib/qualigence/skill-signing",
      SERVER_OIDC_ISSUER: "https://issuer.example.com",
      SERVER_OIDC_AUDIENCE: "qualigence-self-hosted",
      SERVER_OIDC_JWKS_URI: "https://issuer.example.com/.well-known/jwks.json",
      SERVER_OIDC_JWKS_TIMEOUT_MS: "1500",
      SERVER_OIDC_JWKS_CACHE_TTL_MS: "120000",
      SERVER_OIDC_JWKS_ROTATION_COOLDOWN_MS: "250",
      SERVER_OIDC_CLAIM_MAP_FILE: files.claimMap,
      SERVER_RUNNER_CA_CERT_FILE: files.runnerCaCert,
      SERVER_RUNNER_CA_KEY_FILE: files.runnerCaKey,
    });

    expect(config.runnerGrpc).toMatchObject({
      enabled: true,
      host: "0.0.0.0",
      port: 50555,
    });
    expect(config.runnerGrpc?.tlsCertificatePem.toString("utf8")).toBe("server-cert");
    expect(config.runnerGrpc?.tlsPrivateKeyPem.toString("utf8")).toBe("server-key");
    expect(config.missionDispatch).toMatchObject({
      enabled: true,
      tenantIds: ["tenant-a", "tenant-b"],
      batchSize: 32,
    });
    expect(config.oidc.jwks).toEqual({
      kind: "remote",
      jwksUri: "https://issuer.example.com/.well-known/jwks.json",
      timeoutMs: 1500,
      cacheTtlMs: 120000,
      rotationCooldownMs: 250,
    });
    expect(config.objectStorageReadinessUrl).toBeUndefined();
    expect(config.artifactS3).toMatchObject({
      endpoint: "http://minio:9000",
      region: "us-east-1",
      bucket: "qualigence-artifacts",
      accessKeyId: "minio-access",
      secretAccessKey: "minio-secret",
      forcePathStyle: true,
    });
    expect(config.evidenceKms?.rootKey.byteLength).toBe(32);
    expect(config.artifactDataDir).toBe("/var/lib/qualigence/artifacts");
    expect(config.skillSigningDataDir).toBe("/var/lib/qualigence/skill-signing");
  });

  it("rejects an OIDC claim-map file that maps to an unsupported Public API role", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qualigence-server-config-"));
    tempDirs.push(dir);
    const files = await writeConfigFiles(dir);
    const claimMapFile = files.claimMap;
    if (claimMapFile === undefined) throw new Error("claim-map test file path was not created");
    await writeFile(claimMapFile, JSON.stringify({
      tenantClaim: "tenant",
      rolesClaim: "roles",
      allowedTenants: ["tenant-a"],
      roleMap: { owner: "owner" },
    }), "utf8");

    expect(() => loadServerConfig({
      SERVER_RUNNER_GRPC_ENABLED: "false",
      SERVER_PG_HOST: "postgres",
      SERVER_PG_DATABASE: "qualigence",
      SERVER_PG_USER: "qualigence_server",
      SERVER_PG_PASSWORD: "server_pw",
      SERVER_OIDC_ISSUER: "https://issuer.example.com",
      SERVER_OIDC_AUDIENCE: "qualigence-self-hosted",
      SERVER_OIDC_JWKS_FILE: files.jwks,
      SERVER_OIDC_ALLOW_STATIC_JWKS_NON_PRODUCTION: "true",
      SERVER_OIDC_CLAIM_MAP_FILE: claimMapFile,
      SERVER_RUNNER_CA_CERT_FILE: files.runnerCaCert,
      SERVER_RUNNER_CA_KEY_FILE: files.runnerCaKey,
    })).toThrow(/Invalid SERVER_OIDC_CLAIM_MAP_FILE: .*unsupported Public API role/);
  });

  it("cleans up the HTTP listener when Runner gRPC startup fails after HTTP bind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qualigence-server-startup-cleanup-"));
    tempDirs.push(dir);
    const port = await freeTcpPort();
    const config: ServerConfig = {
      host: "127.0.0.1",
      port,
      postgres: {
        host: "postgres",
        port: 5432,
        database: "qualigence",
        user: "qualigence_server",
        password: "server_pw",
      },
      runnerGrpc: {
        enabled: true,
        host: "127.0.0.1",
        port: await freeTcpPort(),
        tlsCertificatePem: Buffer.from("not a pem certificate"),
        tlsPrivateKeyPem: Buffer.from("not a pem private key"),
      },
      missionDispatch: {
        enabled: false,
        tenantIds: ["tenant-a"],
        batchSize: 1,
        intervalMs: 1000,
        initialBackoffMs: 100,
        maximumBackoffMs: 1000,
      },
      intelligenceResultConsumer: {
        enabled: false,
        consumerId: "test-consumer",
        tenantBatchSize: 1,
        resultBatchSize: 1,
        leaseDurationMs: 1000,
        idleBackoffMs: 100,
        errorBackoffMs: 100,
        maximumBackoffMs: 1000,
      },
      oidc: {
        issuer: "https://issuer.example.com",
        audience: "qualigence-self-hosted",
        allowedAlgorithms: ["RS256"],
        jwks: { kind: "static", jwksJson: "[]" },
        claimMapper: {
          tenantClaim: "tenant",
          rolesClaim: "roles",
          allowedTenants: ["tenant-a"],
          roleMap: { admin: "admin" },
        },
      },
      runnerCa: {
        certificatePem: "not a pem ca certificate",
        privateKeyPem: "not a pem ca key",
      },
      artifactDataDir: join(dir, "artifacts"),
      objectStorageReadinessUrl: "http://minio:9000/minio/health/ready",
      skillSigningDataDir: join(dir, "skill-signing"),
    };

    await expect(main({}, async () => undefined, () => config)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${port}/livez`)).rejects.toThrow();
  });

  it("rejects static JWKS runtime config unless explicitly marked non-production", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qualigence-server-config-"));
    tempDirs.push(dir);
    const files = await writeConfigFiles(dir);

    expect(() => loadServerConfig({
      SERVER_RUNNER_GRPC_ENABLED: "false",
      SERVER_PG_HOST: "postgres",
      SERVER_PG_DATABASE: "qualigence",
      SERVER_PG_USER: "qualigence_server",
      SERVER_PG_PASSWORD: "server_pw",
      SERVER_OIDC_ISSUER: "https://issuer.example.com",
      SERVER_OIDC_AUDIENCE: "qualigence-self-hosted",
      SERVER_OIDC_JWKS_FILE: files.jwks,
      SERVER_OIDC_CLAIM_MAP_FILE: files.claimMap,
      SERVER_RUNNER_CA_CERT_FILE: files.runnerCaCert,
      SERVER_RUNNER_CA_KEY_FILE: files.runnerCaKey,
    })).toThrow(/SERVER_OIDC_JWKS_URI is required/);

    expect(loadServerConfig({
      SERVER_RUNNER_GRPC_ENABLED: "false",
      SERVER_PG_HOST: "postgres",
      SERVER_PG_DATABASE: "qualigence",
      SERVER_PG_USER: "qualigence_server",
      SERVER_PG_PASSWORD: "server_pw",
      SERVER_OIDC_ISSUER: "https://issuer.example.com",
      SERVER_OIDC_AUDIENCE: "qualigence-self-hosted",
      SERVER_OIDC_JWKS_FILE: files.jwks,
      SERVER_OIDC_ALLOW_STATIC_JWKS_NON_PRODUCTION: "true",
      SERVER_OIDC_CLAIM_MAP_FILE: files.claimMap,
      SERVER_RUNNER_CA_CERT_FILE: files.runnerCaCert,
      SERVER_RUNNER_CA_KEY_FILE: files.runnerCaKey,
    }).oidc.jwks).toEqual({ kind: "static", jwksJson: "[]" });
  });

  it("fails closed when Runner gRPC is enabled without a Server TLS certificate/key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qualigence-server-config-"));
    tempDirs.push(dir);
    const files = await writeConfigFiles(dir);

    expect(() => loadServerConfig({
      SERVER_PG_HOST: "postgres",
      SERVER_PG_DATABASE: "qualigence",
      SERVER_PG_USER: "qualigence_server",
      SERVER_PG_PASSWORD: "server_pw",
      SERVER_OIDC_ISSUER: "https://issuer.example.com",
      SERVER_OIDC_AUDIENCE: "qualigence-self-hosted",
      SERVER_OIDC_JWKS_FILE: files.jwks,
      SERVER_OIDC_ALLOW_STATIC_JWKS_NON_PRODUCTION: "true",
      SERVER_OIDC_CLAIM_MAP_FILE: files.claimMap,
      SERVER_RUNNER_CA_CERT_FILE: files.runnerCaCert,
      SERVER_RUNNER_CA_KEY_FILE: files.runnerCaKey,
    })).toThrow(/SERVER_RUNNER_GRPC_TLS_CERT_FILE/);
  });
});

describe("Self-hosted Docker gate", () => {
  it("declares a root-only Compose permission prep service before non-root Server startup", async () => {
    const compose = await readFile(join(process.cwd(), "deployments/self-hosted/compose/compose.yaml"), "utf8");
    expect(compose).toContain("server-volume-permissions:");
    expect(compose).toContain('user: "0:0"');
    expect(compose).toContain("network_mode: none");
    expect(compose).toContain("chown 0:0 /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing");
    expect(compose).toContain("chmod 0770 /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing");
    expect(compose).toContain("chown -R 1000:1000 /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing");
    expect(compose.indexOf("chown 0:0")).toBeLessThan(compose.indexOf("chmod 0770"));
    expect(compose.indexOf("chmod 0770")).toBeLessThan(compose.indexOf("chown -R 1000:1000"));
    expect(compose).toContain("server-volume-permissions:\n        condition: service_completed_successfully");
  });

  it("wires the production Server to MinIO/S3 and the Server KMS root-key secret", async () => {
    const compose = await readFile(join(process.cwd(), "deployments/self-hosted/compose/compose.yaml"), "utf8");
    const serverSection = composeServiceSection(compose, "server");
    expect(serverSection).toContain("SERVER_S3_ENDPOINT: http://minio:9000");
    expect(serverSection).toContain("SERVER_S3_BUCKET: qualigence-artifacts");
    expect(serverSection).toContain("SERVER_S3_ACCESS_KEY_ID_FILE: /run/secrets/s3_access_key_id");
    expect(serverSection).toContain("SERVER_S3_SECRET_ACCESS_KEY_FILE: /run/secrets/s3_secret_access_key");
    expect(serverSection).toContain("SERVER_KMS_ROOT_KEY_BASE64_FILE: /run/secrets/kms_root_key");
    expect(serverSection).toContain("SERVER_OIDC_JWKS_URI: ${QUALIGENCE_OIDC_JWKS_URI:?set the remote OIDC JWKS URI}");
    expect(serverSection).not.toContain("SERVER_OIDC_JWKS_FILE");
    expect(serverSection).not.toContain("oidc_jwks");
    expect(serverSection).toContain("SERVER_OIDC_JWKS_TIMEOUT_MS: \"5000\"");
    expect(serverSection).toContain("- s3_access_key_id");
    expect(serverSection).toContain("- s3_secret_access_key");
    expect(serverSection).toContain("- kms_root_key");
  });

  it("keeps the Console healthcheck compatible with the Caddy runtime image", async () => {
    const compose = await readFile(join(process.cwd(), "deployments/self-hosted/compose/compose.yaml"), "utf8");
    const consoleSection = composeServiceSection(compose, "console");
    expect(consoleSection).toContain("dockerfile: deployments/self-hosted/docker/console.Dockerfile");
    expect(consoleSection).toContain("cap_add:");
    expect(consoleSection).toContain("- NET_BIND_SERVICE");
    expect(consoleSection).toContain("command: [\"caddy\", \"file-server\", \"--listen\", \":8080\", \"--root\", \"/srv\"]");
    expect(consoleSection).toContain("wget -qO- http://127.0.0.1:8080/ >/dev/null");
    expect(consoleSection).not.toContain("node -e");
  });

  it("requires Docker explicitly and classifies absence as DockerUnavailable instead of skipping", async () => {
    await expect(requireDocker()).resolves.toBeUndefined();
  });

  it("keeps Worker and external Runner harness readiness diagnostics tied to the failing service check", async () => {
    const compose = await readFile(join(process.cwd(), "deployments/self-hosted/compose/compose.yaml"), "utf8");
    const workerSection = composeServiceSection(compose, "worker");
    expect(workerSection).not.toContain("WORKER_OBJECT_STORAGE_READY_URL");
    expect(workerSection).toContain("WORKER_HEALTH_PORT: \"8081\"");
    expect(workerSection).toContain("http://127.0.0.1:8081/readyz");
    expect(workerSection).toContain("console.error(error&&error.stack?error.stack:String(error))");

    const harness = await readFile(join(process.cwd(), "tests/e2e/self-hosted/external-runner-harness.ts"), "utf8");
    expect(harness).toContain("serverContainerReadiness");
    expect(harness).toContain("publicProxyReadiness");
    expect(harness).toContain("formatReadinessProbe");
    expect(harness).toContain("failingChecks=[");
    expect(harness).toContain("compose health:");
    expect(harness).toContain("ExternalRunnerUnavailable: public /api/readyz did not become ready through the proxy");
    expect(harness).toContain("ExternalRunnerUnavailable: Compose Worker did not become healthy");
    expect(harness).not.toContain("catch {\n      return undefined;\n    }");
  });

  it("uses the stable DockerUnavailable code when the Docker probe fails", async () => {
    await expect(requireDocker(async () => {
      throw new Error("docker missing");
    })).rejects.toMatchObject({ code: "DockerUnavailable" });
  });
});

async function freeTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function readinessConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 8080,
    postgres: { host: "postgres", port: 5432, database: "qualigence", user: "qualigence_server", password: "server_pw" },
    runnerGrpc: { enabled: false, host: "127.0.0.1", port: 50555, tlsCertificatePem: Buffer.alloc(0), tlsPrivateKeyPem: Buffer.alloc(0) },
    missionDispatch: { enabled: false, tenantIds: ["tenant-a"], batchSize: 1, intervalMs: 1000, initialBackoffMs: 100, maximumBackoffMs: 1000 },
    intelligenceResultConsumer: { enabled: false, consumerId: "consumer-a", tenantBatchSize: 1, resultBatchSize: 1, leaseDurationMs: 1000, idleBackoffMs: 100, errorBackoffMs: 100, maximumBackoffMs: 1000 },
    oidc: {
      issuer: "https://issuer.example.com",
      audience: "qualigence-self-hosted",
      allowedAlgorithms: ["RS256"],
      jwks: { kind: "remote", jwksUri: "https://issuer.example.com/.well-known/jwks.json", timeoutMs: 1000, cacheTtlMs: 1000, rotationCooldownMs: 0 },
      claimMapper: { tenantClaim: "tenant", rolesClaim: "roles", allowedTenants: ["tenant-a"], roleMap: { admin: "admin" } },
    },
    runnerCa: { certificatePem: "ca-cert", privateKeyPem: "ca-key" },
    artifactDataDir: join(tmpdir(), "qualigence-server-readiness-component"),
    artifactS3: { region: "us-east-1", endpoint: "http://minio:9000", bucket: "qualigence-artifacts", accessKeyId: "access", secretAccessKey: "secret", forcePathStyle: true },
    evidenceKms: { rootKey: new Uint8Array(Buffer.alloc(32, 7)) },
  };
}

async function writeConfigFiles(dir: string): Promise<Record<string, string>> {
  const paths = {
    jwks: join(dir, "jwks.json"),
    claimMap: join(dir, "claim-map.json"),
    runnerCaCert: join(dir, "runner-ca-cert.pem"),
    runnerCaKey: join(dir, "runner-ca-key.pem"),
    runnerServerCert: join(dir, "runner-server-cert.pem"),
    runnerServerKey: join(dir, "runner-server-key.pem"),
    s3AccessKeyId: join(dir, "s3-access-key-id"),
    s3SecretAccessKey: join(dir, "s3-secret-access-key"),
    kmsRootKey: join(dir, "kms-root-key"),
  };
  await writeFile(paths.jwks, "[]", "utf8");
  await writeFile(paths.claimMap, JSON.stringify({
    tenantClaim: "tenant",
    rolesClaim: "roles",
    allowedTenants: ["tenant-a", "tenant-b"],
    roleMap: { admin: "admin" },
  }), "utf8");
  await writeFile(paths.runnerCaCert, "ca-cert", "utf8");
  await writeFile(paths.runnerCaKey, "ca-key", "utf8");
  await writeFile(paths.runnerServerCert, "server-cert", "utf8");
  await writeFile(paths.runnerServerKey, "server-key", "utf8");
  await writeFile(paths.s3AccessKeyId, "minio-access", "utf8");
  await writeFile(paths.s3SecretAccessKey, "minio-secret", "utf8");
  await writeFile(paths.kmsRootKey, Buffer.alloc(32, 7).toString("base64"), "utf8");
  return paths;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not observed before timeout");
}

function composeServiceSection(compose: string, serviceName: string): string {
  const start = compose.indexOf(`  ${serviceName}:\n`);
  if (start === -1) {
    throw new Error(`Compose service ${serviceName} was not found`);
  }
  const remainder = compose.slice(start + `  ${serviceName}:\n`.length);
  const nextService = remainder.search(/\n  [a-zA-Z0-9_-]+:\n/);
  if (nextService === -1) {
    return compose.slice(start);
  }
  return compose.slice(start, start + `  ${serviceName}:\n`.length + nextService);
}

async function requireDocker(
  probe: () => Promise<unknown> = () => execFileAsync("docker", ["info"], { timeout: 15_000 }),
): Promise<void> {
  try {
    await probe();
  } catch (cause) {
    throw Object.assign(new Error("DockerUnavailable: docker info failed"), {
      code: "DockerUnavailable",
      cause,
    });
  }
}
