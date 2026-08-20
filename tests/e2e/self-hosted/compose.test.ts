import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresIntelligenceQueue,
  ServerIntelligenceResultConsumer,
  type IntelligenceJobStore,
  type IntelligenceResultInbox,
} from "@qualigence/core-application";
import { createPostgresRuntime } from "@qualigence/postgres-runtime";
import { WorkerLoop, type Clock, type JobProcessor } from "@qualigence/intelligence-worker";
import type { IntelligenceJob } from "@qualigence/intelligence";
import { dockerAvailable } from "../../helpers/docker-container.js";
import {
  buildJobPair,
  readCaseVersion,
  seedInvestigationCase,
  seedJob,
} from "../../helpers/intelligence-fixtures.js";
import { generateRunnerCsr } from "../../helpers/runner-identity-pki.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

const execFileAsync = promisify(execFile);
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

const composeDir = join(process.cwd(), "deployments", "self-hosted", "compose");
const composeFile = join(composeDir, "compose.yaml");

/**
 * The environment the Compose file requires (all non-secret). Secrets are file
 * mounts, so `docker compose config` resolves the topology without them.
 */
const composeEnv = {
  ...process.env,
  QUALIGENCE_OIDC_ISSUER: "https://issuer.example.com",
  QUALIGENCE_OIDC_AUDIENCE: "qualigence-self-hosted",
  QUALIGENCE_MODEL_BASE_URL: "https://models.example.com/v1",
  QUALIGENCE_MODEL_NAME: "qualigence-analyst",
} as NodeJS.ProcessEnv;

interface ComposeService {
  image?: string;
  command?: unknown;
  read_only?: boolean;
  security_opt?: string[];
  cap_drop?: string[];
  ports?: unknown[];
  environment?: Record<string, string>;
  secrets?: Array<{ source: string; target: string }>;
  deploy?: { resources?: { limits?: { cpus?: unknown; memory?: unknown; pids?: unknown } } };
  logging?: { options?: Record<string, string> };
  build?: { dockerfile?: string };
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
  secrets: Record<string, { file?: string }>;
}

async function loadComposeConfig(): Promise<ComposeConfig> {
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", "-f", composeFile, "config", "--format", "json"],
    { env: composeEnv, cwd: composeDir },
  );
  return JSON.parse(stdout) as ComposeConfig;
}

describe.skipIf(!dockerAvailable())("Self-hosted Compose topology invariants", () => {
  let config: ComposeConfig;

  beforeAll(async () => {
    config = await loadComposeConfig();
  }, 60_000);

  it("keeps PostgreSQL and MinIO off the public network (no host-published ports)", () => {
    expect(config.services.postgres?.ports ?? []).toEqual([]);
    expect(config.services.minio?.ports ?? []).toEqual([]);
    // The reverse proxy is the only public entrypoint.
    const proxyPorts = (config.services.proxy?.ports ?? []) as Array<{ target: number }>;
    expect(proxyPorts.some((port) => port.target === 443)).toBe(true);
    for (const [name, service] of Object.entries(config.services)) {
      if (name === "proxy") {
        continue;
      }
      expect(service.ports ?? [], `${name} must not publish host ports`).toEqual([]);
    }
  });

  it("hardens the runtime application containers", () => {
    for (const name of ["server", "worker", "console"]) {
      const service = config.services[name];
      expect(service, `${name} service is missing`).toBeDefined();
      expect(service?.read_only, `${name} must be read_only`).toBe(true);
      expect(service?.security_opt, `${name} must forbid privilege escalation`).toContain(
        "no-new-privileges:true",
      );
      expect(service?.cap_drop, `${name} must drop all capabilities`).toContain("ALL");
    }
  });

  it("applies CPU, memory, PID and log-rotation limits", () => {
    for (const name of ["server", "worker"]) {
      const limits = config.services[name]?.deploy?.resources?.limits;
      expect(limits?.cpus, `${name} needs a CPU limit`).toBeDefined();
      expect(limits?.memory, `${name} needs a memory limit`).toBeDefined();
      expect(limits?.pids, `${name} needs a PID limit`).toBeDefined();
      const logOptions = config.services[name]?.logging?.options ?? {};
      expect(logOptions["max-size"], `${name} needs log rotation`).toBeDefined();
      expect(logOptions["max-file"], `${name} needs log rotation`).toBeDefined();
    }
  });

  it("pins every third-party image by digest and never uses :latest", () => {
    for (const name of ["postgres", "minio", "proxy"]) {
      const image = config.services[name]?.image ?? "";
      expect(image, `${name} must be digest-pinned`).toContain("@sha256:");
      expect(image).not.toContain(":latest");
    }
  });

  it("sources every secret from a /run/secrets file, never a plaintext env value", () => {
    // The server/worker environments carry only *_FILE paths (or non-secret config).
    const serverEnv = config.services.server?.environment ?? {};
    expect(serverEnv.SERVER_PG_PASSWORD_FILE).toBe("/run/secrets/pg_server_password");
    expect(serverEnv.SERVER_PG_PASSWORD).toBeUndefined();
    const workerEnv = config.services.worker?.environment ?? {};
    expect(workerEnv.WORKER_PG_PASSWORD_FILE).toBe("/run/secrets/pg_worker_password");
    expect(workerEnv.WORKER_S3_SECRET_ACCESS_KEY_FILE).toBe("/run/secrets/s3_secret_access_key");
    expect(workerEnv.WORKER_S3_SECRET_ACCESS_KEY).toBeUndefined();

    // No secret value is placed in any container's environment.
    const forbidden = /password|secret|private[_-]?key/i;
    for (const [name, service] of Object.entries(config.services)) {
      for (const [key, value] of Object.entries(service.environment ?? {})) {
        if (forbidden.test(key) && !key.endsWith("_FILE")) {
          throw new Error(`${name}.${key} looks like a plaintext secret env value`);
        }
        expect(value.startsWith("/run/secrets/") || !value.includes("/run/secrets/")).toBe(true);
      }
    }

    // Mounted secret targets all live under /run/secrets.
    for (const secretRef of config.services.server?.secrets ?? []) {
      expect(secretRef.target.startsWith("/run/secrets/")).toBe(true);
    }
    // Every declared secret is backed by a file (never an inline value).
    for (const [name, secret] of Object.entries(config.secrets)) {
      expect(secret.file, `secret ${name} must be file-backed`).toBeDefined();
    }
  });

  it("serves the Console as a static asset image, not a Node process", () => {
    const console = config.services.console;
    expect(console).toBeDefined();
    // The console builds the static-asset Dockerfile and runs no server/worker role.
    expect(console?.build?.dockerfile ?? "").toContain("console.Dockerfile");
    expect(console?.command ?? undefined).toBeUndefined();
    // There is no additional Node service for the web console.
    const nodeConsoleServices = Object.entries(config.services).filter(
      ([name, service]) =>
        name.includes("web-console") ||
        (Array.isArray(service.command) && service.command.includes("web-console")),
    );
    expect(nodeConsoleServices).toEqual([]);
  });

  it("applies the frozen strict CSP and security headers at the edge proxy", async () => {
    const caddyfile = await readFile(join(composeDir, "Caddyfile"), "utf8");
    expect(caddyfile).toContain("Content-Security-Policy");
    expect(caddyfile).toContain("default-src 'self'");
    expect(caddyfile).toContain("object-src 'none'");
    expect(caddyfile).toContain("base-uri 'none'");
    expect(caddyfile).toContain("frame-ancestors 'none'");
    expect(caddyfile).toContain("Referrer-Policy");
    // /api is routed to the Server (prefix stripped) and /healthz is exposed.
    expect(caddyfile).toContain("handle_path /api/*");
    expect(caddyfile).toContain("reverse_proxy server:8080");
    expect(caddyfile).toContain("/healthz");
  });
});

describe.skipIf(!dockerAvailable())(
  "Self-hosted full loop (realistic compose-up equivalent: enroll -> mission -> worker -> console query)",
  () => {
    let fx: ServerFixture;

    const fixedClock: Clock = { now: () => new Date().toISOString(), sleep: async () => {} };

    function adminConfig() {
      return {
        host: fx.container.host,
        port: fx.container.port,
        database: fx.container.database,
        user: fx.container.superuser,
        password: fx.container.password,
      };
    }

    function url(path: string): string {
      return `${fx.baseUrl}${path}`;
    }

    beforeAll(async () => {
      fx = await setupServerFixture();
    }, 240_000);

    afterAll(async () => {
      await fx?.stop();
    });

    it("runs the whole private-network loop and the Server applies the Worker's result", async () => {
      const tenantId = "tenant-a";

      // 1. Runner enrolls via mTLS (admin OIDC creates the enrollment; the
      //    certificate + self-identity exchange use NO OIDC bearer token).
      const adminToken = fx.token(tenantId, ["admin"]);
      const enrollRes = await fetch(url("/v1/runner-enrollments"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "loop-enroll-1",
        },
        body: JSON.stringify({ runnerId: "runner-loop", projectIds: ["project-1"], ttlMs: 600_000 }),
      });
      expect(enrollRes.status).toBe(201);
      const { resource } = (await enrollRes.json()) as {
        resource: { enrollmentId: string; enrollmentToken: string };
      };
      const csr = generateRunnerCsr({ commonName: "runner-loop" });
      const certRes = await fetch(
        url(`/v1/runner-enrollments/${resource.enrollmentId}/certificate`),
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-tenant-id": tenantId },
          body: JSON.stringify({ enrollmentToken: resource.enrollmentToken, csrPem: csr.csrPem }),
        },
      );
      expect(certRes.status).toBe(201);
      const cert = (await certRes.json()) as { certificatePem: string };
      const selfRes = await fetch(url("/v1/runner-identity/self"), {
        headers: { "x-client-cert": encodeURIComponent(cert.certificatePem) },
      });
      expect(selfRes.status).toBe(200);
      expect((await selfRes.json()) as { runnerId: string }).toMatchObject({
        runnerId: "runner-loop",
      });

      // 2. Server accepts a Mission (project) through the Public API.
      const testerToken = fx.token(tenantId, ["tester"]);
      const projectRes = await fetch(url("/v1/projects"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${testerToken}`,
          "content-type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: "loop-project-1",
        },
        body: JSON.stringify({ name: "Loop Mission", description: "self-hosted E2E" }),
      });
      expect(projectRes.status).toBe(201);

      // 3. Seed an investigation case + Intelligence Job, then the Worker processes it.
      const caseId = "case-loop-e2e";
      const { job, result } = buildJobPair({
        tenantId,
        caseId,
        jobId: "job-loop-e2e",
        baseAggregateVersion: 0,
      });
      await seedInvestigationCase(adminConfig(), { tenantId, caseId, version: 0 });
      await seedJob(adminConfig(), job);

      const queue = new PostgresIntelligenceQueue({
        host: fx.container.host,
        port: fx.container.port,
        database: fx.container.database,
        user: "qualigence_worker",
        password: "worker_pw",
      });
      const processor: JobProcessor = {
        process: async (leased: IntelligenceJob) => {
          expect(leased.jobId).toBe("job-loop-e2e");
          return result;
        },
      };
      try {
        const loop = new WorkerLoop({
          store: queue as IntelligenceJobStore,
          inbox: queue as IntelligenceResultInbox,
          processor,
          workerId: "worker-loop",
          acceptedTypes: ["investigation.reproduction-planning"],
          leaseDurationMs: 60_000,
          idleBackoffMs: 5,
          clock: fixedClock,
        });
        expect(await loop.runOnce()).toBe("processed");
      } finally {
        await queue.close();
      }

      // 4. The Server (never the Worker) applies the result deterministically.
      const provider = createPostgresRuntime({
        host: fx.container.host,
        port: fx.container.port,
        database: fx.container.database,
        user: "qualigence_server",
        password: "server_pw",
      });
      try {
        const consumer = new ServerIntelligenceResultConsumer(provider);
        const summary = await consumer.consumeForTenant(tenantId);
        expect(summary.applied).toBe(1);
      } finally {
        await provider.close();
      }

      // 5. The Console can query the applied result via the Public API.
      const viewerToken = fx.token(tenantId, ["viewer"]);
      const investigationRes = await fetch(url(`/v1/investigations/${caseId}`), {
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(investigationRes.status).toBe(200);
      const dto = (await investigationRes.json()) as { caseId: string; version: number };
      expect(dto.caseId).toBe(caseId);
      expect(dto.version).toBe(1);
      expect(await readCaseVersion(adminConfig(), caseId)).toBe(1);
    }, 240_000);
  },
);
