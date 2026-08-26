import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const composeDir = join(process.cwd(), "deployments", "self-hosted", "compose");
const composeFile = join(composeDir, "compose.yaml");
const runtimePermissionProbeImage =
  "node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7";
const serverVolumePermissionCommand = [
  "mkdir -p /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing",
  "chown 0:0 /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing",
  "chmod 0770 /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing",
  "chown -R 1000:1000 /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing",
].join(" && ");

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
  QUALIGENCE_SERVER_PG_ROLE: "qualigence_server",
} as NodeJS.ProcessEnv;

interface ComposeService {
  image?: string;
  command?: unknown;
  entrypoint?: unknown;
  user?: string;
  read_only?: boolean;
  security_opt?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  network_mode?: string;
  ports?: unknown[];
  tmpfs?: string[];
  volumes?: unknown[];
  depends_on?: Record<string, { condition?: string; required?: boolean }>;
  environment?: Record<string, string>;
  secrets?: Array<{ source: string; target: string }>;
  deploy?: { resources?: { limits?: { cpus?: unknown; memory?: unknown; pids?: unknown } } };
  logging?: { options?: Record<string, string> };
  build?: { dockerfile?: string };
  healthcheck?: { test?: unknown };
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
  secrets: Record<string, { file?: string }>;
  volumes?: Record<string, unknown>;
}

async function loadComposeConfig(): Promise<ComposeConfig> {
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", "-f", composeFile, "config", "--format", "json"],
    { env: composeEnv, cwd: composeDir },
  );
  return JSON.parse(stdout) as ComposeConfig;
}

describe("Self-hosted Compose topology invariants", () => {
  let config: ComposeConfig;

  beforeAll(async () => {
    await requireDocker();
    config = await loadComposeConfig();
  }, 60_000);

  it("keeps PostgreSQL and MinIO off the public network (no host-published ports)", () => {
    expect(config.services.postgres?.ports ?? []).toEqual([]);
    expect(config.services.minio?.ports ?? []).toEqual([]);
    // The reverse proxy is the only public HTTP entrypoint, and Ticket 12
    // intentionally allows exactly one dedicated Server Runner gRPC host port.
    const proxyPorts = (config.services.proxy?.ports ?? []) as Array<{ target: number }>;
    expect(proxyPorts.some((port) => port.target === 443)).toBe(true);
    const serverPorts = (config.services.server?.ports ?? []) as Array<{ target: number }>;
    expect(serverPorts).toHaveLength(1);
    expect(serverPorts[0]?.target).toBe(50555);
    for (const [name, service] of Object.entries(config.services)) {
      if (name === "proxy" || name === "server") {
        continue;
      }
      expect(service.ports ?? [], `${name} must not publish host ports`).toEqual([]);
    }
  });

  it("persists Server Runner Artifact and skill-signing state outside tmpfs", () => {
    const server = config.services.server;
    expect(config.volumes?.artifactdata, "artifactdata volume must be declared").toBeDefined();
    expect(config.volumes?.skill_signing_data, "skill_signing_data volume must be declared").toBeDefined();
    expect(server?.environment?.SERVER_ARTIFACT_DATA_DIR).toBe("/var/lib/qualigence/artifacts");
    expect(server?.environment?.SERVER_SKILL_SIGNING_DATA_DIR).toBe("/var/lib/qualigence/skill-signing");
    const volumes = (server?.volumes ?? []) as Array<{ source?: string; target?: string }>;
    expect(volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "artifactdata",
          target: "/var/lib/qualigence/artifacts",
        }),
        expect.objectContaining({
          source: "skill_signing_data",
          target: "/var/lib/qualigence/skill-signing",
        }),
      ]),
    );
    expect(server?.tmpfs ?? []).toContain("/tmp");
    expect(server?.tmpfs ?? []).not.toContain("/var/lib/qualigence/artifacts");
    expect(server?.tmpfs ?? []).not.toContain("/var/lib/qualigence/skill-signing");
  });

  it("prepares Server state volume permissions before non-root Server startup", () => {
    const prep = config.services["server-volume-permissions"];
    const server = config.services.server;
    expect(prep, "server-volume-permissions service is missing").toBeDefined();
    expect(prep?.user).toBe("0:0");
    expect(prep?.read_only).toBe(true);
    expect(prep?.security_opt).toContain("no-new-privileges:true");
    expect(prep?.cap_drop).toContain("ALL");
    expect(prep?.cap_add).toEqual(["CHOWN"]);
    expect(prep?.network_mode).toBe("none");
    expect(prep?.ports ?? []).toEqual([]);
    expect(prep?.secrets ?? []).toEqual([]);
    const commandText = Array.isArray(prep?.command) ? prep?.command.join("\n") : String(prep?.command ?? "");
    expect(commandText).toContain("mkdir -p /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing");
    expect(commandText).toContain("chown 0:0 /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing");
    expect(commandText).toContain("chmod 0770 /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing");
    expect(commandText).toContain("chown -R 1000:1000 /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing");
    expect(commandText.indexOf("chown 0:0")).toBeLessThan(commandText.indexOf("chmod 0770"));
    expect(commandText.indexOf("chmod 0770")).toBeLessThan(commandText.indexOf("chown -R 1000:1000"));
    const volumes = (prep?.volumes ?? []) as Array<{ source?: string; target?: string }>;
    expect(volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "artifactdata",
          target: "/var/lib/qualigence/artifacts",
        }),
        expect.objectContaining({
          source: "skill_signing_data",
          target: "/var/lib/qualigence/skill-signing",
        }),
      ]),
    );
    expect(volumes).toHaveLength(2);
    expect(server?.depends_on?.["server-volume-permissions"]?.condition).toBe("service_completed_successfully");
  });

  it("prepares fresh Server state volumes idempotently before uid/gid 1000 read-only writes", async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const artifactVolume = `qualigence_artifact_permission_probe_${suffix}`;
    const signingVolume = `qualigence_signing_permission_probe_${suffix}`;
    const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: "1" };
    const mountArgs = [
      "--mount",
      `type=volume,source=${artifactVolume},target=/var/lib/qualigence/artifacts`,
      "--mount",
      `type=volume,source=${signingVolume},target=/var/lib/qualigence/skill-signing`,
    ];

    try {
      for (const pass of ["initial", "retained-volume rerun"]) {
        await execFileAsync(
          "docker",
          [
            "run",
            "--rm",
            "--read-only",
            "--user",
            "0:0",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CHOWN",
            "--network",
            "none",
            ...mountArgs,
            "--entrypoint",
            "/bin/sh",
            runtimePermissionProbeImage,
            "-ec",
            serverVolumePermissionCommand,
          ],
          { env: { ...dockerEnv, QUALIGENCE_PERMISSION_PREP_PASS: pass }, timeout: 60_000 },
        );
      }

      const { stdout } = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "--read-only",
          "--user",
          "1000:1000",
          "--cap-drop",
          "ALL",
          "--network",
          "none",
          ...mountArgs,
          "--entrypoint",
          "/bin/sh",
          runtimePermissionProbeImage,
          "-ec",
          [
            "touch /var/lib/qualigence/artifacts/probe",
            "touch /var/lib/qualigence/skill-signing/probe",
            "stat -c '%u:%g %a %n' /var/lib/qualigence/artifacts /var/lib/qualigence/skill-signing /var/lib/qualigence/artifacts/probe /var/lib/qualigence/skill-signing/probe",
          ].join(" && "),
        ],
        { env: dockerEnv, timeout: 60_000 },
      );

      expect(stdout).toContain("1000:1000 770 /var/lib/qualigence/artifacts");
      expect(stdout).toContain("1000:1000 770 /var/lib/qualigence/skill-signing");
      expect(stdout).toContain("1000:1000 644 /var/lib/qualigence/artifacts/probe");
      expect(stdout).toContain("1000:1000 644 /var/lib/qualigence/skill-signing/probe");
    } finally {
      await Promise.all(
        [artifactVolume, signingVolume].map((volume) =>
          execFileAsync("docker", ["volume", "rm", "-f", volume], { timeout: 15_000 }).catch(() => undefined),
        ),
      );
    }
  }, 120_000);

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

  it("serves the Console as a static asset image, not a Node process", async () => {
    const console = config.services.console;
    expect(console).toBeDefined();
    // The console builds the static-asset Dockerfile and runs no server/worker role.
    expect(console?.build?.dockerfile ?? "").toContain("console.Dockerfile");
    await expect(readConsoleRuntimeImage()).resolves.toContain("caddy:2.8-alpine@sha256:");
    expect(console?.command).toEqual(["caddy", "file-server", "--listen", ":8080", "--root", "/srv"]);
    expect(console?.cap_add).toEqual(["NET_BIND_SERVICE"]);
    expect(composeHealthcheckText(console)).toContain("wget -qO- http://127.0.0.1:8080/ >/dev/null");
    expect(composeHealthcheckText(console)).not.toMatch(/\bnode\b|node -e/);
    // There is no additional Node service for the web console.
    const nodeConsoleServices = Object.entries(config.services).filter(
      ([name, service]) =>
        name.includes("web-console") ||
        (Array.isArray(service.command) && service.command.includes("web-console")),
    );
    expect(nodeConsoleServices).toEqual([]);
  });

  it("uses a Console healthcheck command available in the Caddy runtime image", async () => {
    const console = config.services.console;
    expect(composeHealthcheckText(console)).toContain("wget -qO- http://127.0.0.1:8080/ >/dev/null");
    expect(composeHealthcheckText(console)).not.toMatch(/\bnode\b|node -e/);

    const { stdout } = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_BIND_SERVICE",
        "--security-opt",
        "no-new-privileges:true",
        "--network",
        "none",
        "--entrypoint",
        "/bin/sh",
        await readConsoleRuntimeImage(),
        "-ec",
        "command -v wget && caddy version >/dev/null",
      ],
      { env: { ...process.env, MSYS_NO_PATHCONV: "1" }, timeout: 60_000 },
    );
    expect(stdout.trim()).toMatch(/wget$/);
  }, 90_000);

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

function composeHealthcheckText(service: ComposeService | undefined): string {
  const test = service?.healthcheck?.test;
  return Array.isArray(test) ? test.join(" ") : String(test ?? "");
}

async function readConsoleRuntimeImage(): Promise<string> {
  const dockerfile = await readFile(
    join(process.cwd(), "deployments", "self-hosted", "docker", "console.Dockerfile"),
    "utf8",
  );
  const runtimeImage = /^FROM\s+(caddy:2\.8-alpine@sha256:[a-f0-9]{64})\s+AS\s+runtime$/m.exec(dockerfile)?.[1];
  if (runtimeImage === undefined) {
    throw new Error("Console Dockerfile Caddy runtime image was not found");
  }
  return runtimeImage;
}

async function requireDocker(): Promise<void> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 15_000 });
  } catch (cause) {
    throw Object.assign(new Error("DockerUnavailable: docker info failed"), {
      code: "DockerUnavailable",
      cause,
    });
  }
}
