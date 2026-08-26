import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadServerConfig, type ServerConfig } from "../../../apps/server/src/config.js";
import { main } from "../../../apps/server/src/main.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

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

  it("wires readiness checks for private infrastructure, Runner gRPC, dispatch, and Result consumption", async () => {
    const source = await readFile(join(process.cwd(), "apps/server/src/main.ts"), "utf8");
    for (const check of [
      "postgres",
      "object_storage",
      "artifact_data_plane",
      "runner_grpc",
      "mission_dispatch",
      "intelligence_result_consumer",
    ]) {
      expect(source).toContain(`name: "${check}"`);
    }
  });
});

describe("Self-hosted Server configuration", () => {
  it("loads the dedicated Runner gRPC listener, dispatch tenant list, and object-storage readiness URL from files/env", async () => {
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
      SERVER_OBJECT_STORAGE_READY_URL: "http://minio:9000/minio/health/ready",
      SERVER_ARTIFACT_DATA_DIR: "/var/lib/qualigence/artifacts",
      SERVER_SKILL_SIGNING_DATA_DIR: "/var/lib/qualigence/skill-signing",
      SERVER_OIDC_ISSUER: "https://issuer.example.com",
      SERVER_OIDC_AUDIENCE: "qualigence-self-hosted",
      SERVER_OIDC_JWKS_FILE: files.jwks,
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
    expect(config.objectStorageReadinessUrl).toBe("http://minio:9000/minio/health/ready");
    expect(config.artifactDataDir).toBe("/var/lib/qualigence/artifacts");
    expect(config.skillSigningDataDir).toBe("/var/lib/qualigence/skill-signing");
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
        jwksJson: "[]",
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
    expect(compose).toContain("chown -R 1000:1000 /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing");
    expect(compose).toContain("server-volume-permissions:\n        condition: service_completed_successfully");
  });

  it("requires Docker explicitly and classifies absence as DockerUnavailable instead of skipping", async () => {
    await expect(requireDocker()).resolves.toBeUndefined();
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

async function writeConfigFiles(dir: string): Promise<Record<string, string>> {
  const paths = {
    jwks: join(dir, "jwks.json"),
    claimMap: join(dir, "claim-map.json"),
    runnerCaCert: join(dir, "runner-ca-cert.pem"),
    runnerCaKey: join(dir, "runner-ca-key.pem"),
    runnerServerCert: join(dir, "runner-server-cert.pem"),
    runnerServerKey: join(dir, "runner-server-key.pem"),
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
  return paths;
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
