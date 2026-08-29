import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { request as httpsRequest } from "node:https";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRunnerCa, type PemPair } from "../../helpers/runner-identity-pki.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = process.cwd();
const COMPOSE_DIR = join(REPO_ROOT, "deployments", "self-hosted", "compose");
const COMPOSE_FILE = join(COMPOSE_DIR, "compose.yaml");
const COMPOSE_ENV_FILE = join(COMPOSE_DIR, ".env.example");
const NODE_RUNTIME_IMAGE = "node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7";
const JWKS_PORT = 18082;
const READINESS_TIMEOUT_MS = 300_000;

const SECRET_FILE_NAMES: Readonly<Record<string, string>> = {
  pg_admin_password: "pg_admin_password",
  pg_server_password: "pg_server_password",
  pg_worker_password: "pg_worker_password",
  s3_access_key_id: "s3_access_key_id",
  s3_secret_access_key: "s3_secret_access_key",
  kms_root_key: "kms_root_key",
  oidc_claim_map: "oidc_claim_map.json",
  runner_ca_cert: "runner_ca_cert.pem",
  runner_ca_key: "runner_ca_key.pem",
  runner_server_cert: "runner_server_cert.pem",
  runner_server_key: "runner_server_key.pem",
  worker_model_api_key: "worker_model_api_key",
  tls_cert: "tls_cert.pem",
  tls_key: "tls_key.pem",
};

interface HarnessContext {
  readonly projectName: string;
  readonly workDir: string;
  readonly runtimeDir: string;
  readonly runtimeDirName: string;
  readonly overrideFile: string;
  readonly proxyPort: number;
  readonly runnerGrpcPort: number;
  readonly proxyCaPem: string;
  readonly proxyCertificateChainPem: string;
  readonly runnerCa: PemPair;
  readonly runnerServer: PemPair;
  readonly proxy: PemPair;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface ReadinessReportDto {
  readonly status?: string;
  readonly checks?: readonly {
    readonly name?: string;
    readonly status?: string;
    readonly code?: string;
    readonly safeMessage?: string;
    readonly details?: unknown;
  }[];
}

interface ReadinessProbeResult {
  readonly ready: boolean;
  readonly source: "server-container" | "worker-container" | "public-proxy";
  readonly httpStatus?: number;
  readonly report?: ReadinessReportDto;
  readonly body?: string;
  readonly error?: string;
}

describe("Self-hosted readiness E2E (real Docker Compose)", () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    await requireDocker();
    ctx = await createHarnessContext();
    await writeComposeOverride(ctx);
    await writeHarnessSecrets(ctx);
    await ensureWorkspaceBuild();
    await compose(ctx, ["up", "-d", "postgres", "minio"], 180_000);
    await compose(ctx, ["run", "--rm", "minio-bucket"], 120_000);
    await compose(ctx, ["run", "--rm", "migrate"], 180_000);
    await compose(ctx, ["up", "-d", "server", "worker", "console", "proxy"], 240_000);
    await waitForStackReady(ctx);
  }, 900_000);

  afterAll(async () => {
    if (ctx !== undefined) {
      await compose(ctx, ["down", "-v", "--remove-orphans", "--timeout", "10"], 180_000).catch(() => undefined);
      await rm(ctx.workDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(ctx.runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 240_000);

  it("reports dependency failure and recovery through Server, Worker, Console, and proxy", async () => {
    if (ctx === undefined) throw new Error("ReadinessE2EFailed: harness did not initialize");
    const activeCtx = ctx;
    await expect(serverReadiness(activeCtx)).resolves.toMatchObject({ ready: true });
    await expect(workerReadiness(activeCtx)).resolves.toMatchObject({ ready: true });
    await expect(serviceHealth(activeCtx, "console")).resolves.toBe("healthy");
    await expect(publicProxyReadiness(activeCtx)).resolves.toMatchObject({ ready: true });

    await compose(activeCtx, ["stop", "minio"], 120_000);

    const failedServer = await poll(async () => {
      const probe = await serverReadiness(activeCtx);
      const objectStorage = probe.report?.checks?.find((check) => check.name === "object_storage");
      if (!probe.ready && objectStorage?.status === "fail") return probe;
      throw new Error(formatReadinessProbe(probe));
    }, 120_000, 2_000, "ReadinessE2EFailed: Server did not fail object-storage readiness after MinIO stopped");
    expect(failedServer.report?.status).toBe("not-ready");

    const failedWorker = await poll(async () => {
      const probe = await workerReadiness(activeCtx);
      const objectStorage = probe.report?.checks?.find((check) => check.name === "object_storage");
      if (!probe.ready && objectStorage?.status === "fail") return probe;
      throw new Error(formatReadinessProbe(probe));
    }, 120_000, 2_000, "ReadinessE2EFailed: Worker did not fail object-storage readiness after MinIO stopped");
    expect(failedWorker.report?.status).toBe("not-ready");

    await expect(serviceHealth(activeCtx, "console")).resolves.toBe("healthy");
    const failedProxy = await publicProxyReadiness(activeCtx);
    expect(failedProxy.ready).toBe(false);

    await compose(activeCtx, ["start", "minio"], 120_000);
    await compose(activeCtx, ["run", "--rm", "minio-bucket"], 120_000);
    await waitForStackReady(activeCtx);

    await expect(serverReadiness(activeCtx)).resolves.toMatchObject({ ready: true });
    await expect(workerReadiness(activeCtx)).resolves.toMatchObject({ ready: true });
    await expect(serviceHealth(activeCtx, "console")).resolves.toBe("healthy");
    await expect(publicProxyReadiness(activeCtx)).resolves.toMatchObject({ ready: true });
  }, 600_000);
});

async function createHarnessContext(): Promise<HarnessContext> {
  const workDir = await mkdtemp(join(REPO_ROOT, ".tmp-readiness-"));
  const runtimeDir = await mkdtemp(join(COMPOSE_DIR, ".e2e-runtime-"));
  const runtimeDirName = basename(runtimeDir);
  const [proxyPort, runnerGrpcPort] = await Promise.all([freeTcpPort(), freeTcpPort()]);
  const runnerCa = createRunnerCa("Qualigence readiness E2E Runner CA");
  const runnerServer = mintServerCertificate(runnerCa, "localhost");
  const proxyCa = createProxyCertificateAuthority("Qualigence readiness E2E Proxy TLS CA");
  const proxy = mintProxyServerCertificate(proxyCa, "localhost");
  const proxyCertificateChainPem = pemBundle(proxy.certPem, proxyCa.certPem);
  const projectName = `qualigence-ready-${process.pid}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  await writeFile(join(workDir, "runner-ca.crt"), runnerCa.certPem, "utf8");
  await writeFile(join(workDir, "runner-server.crt"), runnerServer.certPem, "utf8");
  await writeFile(join(workDir, "runner-server.key"), runnerServer.keyPem, "utf8");
  await writeFile(join(workDir, "proxy.crt"), proxyCertificateChainPem, "utf8");
  await writeFile(join(workDir, "proxy.key"), proxy.keyPem, "utf8");
  return {
    projectName,
    workDir,
    runtimeDir,
    runtimeDirName,
    overrideFile: join(workDir, "compose.override.yaml"),
    proxyPort,
    runnerGrpcPort,
    proxyCaPem: proxyCa.certPem,
    proxyCertificateChainPem,
    runnerCa,
    runnerServer,
    proxy,
  };
}

async function writeComposeOverride(ctx: HarnessContext): Promise<void> {
  await writeFile(join(ctx.runtimeDir, "jwks-server.mjs"), [
    "import { createPublicKey, generateKeyPairSync } from 'node:crypto';",
    "import { createServer } from 'node:http';",
    "const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });",
    "const jwk = publicKey.export({ format: 'jwk' });",
    "const body = JSON.stringify({ keys: [{ ...jwk, kid: 'readiness-jwks-key', alg: 'RS256', use: 'sig' }] });",
    `createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(body); }).listen(${JWKS_PORT}, '127.0.0.1');`,
  ].join("\n"), "utf8");
  await writeFile(join(ctx.runtimeDir, "bootstrap.mjs"), `
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { bootstrapServerDatabase } from "file:///workspace/apps/server/dist/index.js";
import { markPostgresAuxSchemaCurrent } from "file:///workspace/packages/storage-providers/postgres-runtime/dist/index.js";
const require = createRequire("file:///workspace/package.json");
const { Kysely, PostgresDialect } = await import(require.resolve("kysely"));
const { default: pg } = await import(require.resolve("pg"));
const adminPassword = (await readFile("/run/secrets/pg_admin_password", "utf8")).trim();
const serverPassword = (await readFile("/run/secrets/pg_server_password", "utf8")).trim();
const workerPassword = (await readFile("/run/secrets/pg_worker_password", "utf8")).trim();
const admin = { host: "postgres", port: 5432, database: "qualigence", user: "qualigence_owner", password: adminPassword };
await bootstrapServerDatabase({
  admin,
  roles: {
    server: { name: "qualigence_server", password: serverPassword },
    worker: { name: "qualigence_worker", password: workerPassword },
  },
});
const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool(admin) }) });
try {
  await markPostgresAuxSchemaCurrent(db, "qualigence_server");
} finally {
  await db.destroy();
}
console.log("readiness-e2e:database-provisioned");
`, "utf8");
  await writeFile(ctx.overrideFile, [
    "services:",
    "  server-volume-permissions:",
    `    image: ${NODE_RUNTIME_IMAGE}`,
    "    build: !reset null",
    "  migrate:",
    `    image: ${NODE_RUNTIME_IMAGE}`,
    "    build: !reset null",
    "    volumes: !override",
    `      - \"${composePath(REPO_ROOT)}:/workspace:ro\"`,
    `      - "./${ctx.runtimeDirName}/bootstrap.mjs:/bootstrap.mjs:ro"`,
    `    entrypoint: ["node", "/bootstrap.mjs"]`,
    "    command: !override []",
    "  server:",
    `    image: ${NODE_RUNTIME_IMAGE}`,
    "    build: !reset null",
    "    working_dir: /workspace",
    "    user: \"1000:1000\"",
    "    entrypoint: [\"/bin/sh\", \"-ec\"]",
    `    command: !override ["node /jwks-server.mjs & exec node /workspace/apps/server/dist/main.js"]`,
    "    volumes: !override",
    `      - \"${composePath(REPO_ROOT)}:/workspace:ro\"`,
    `      - "./${ctx.runtimeDirName}/jwks-server.mjs:/jwks-server.mjs:ro"`,
    "      - artifactdata:/var/lib/qualigence/artifacts",
    "      - skill_signing_data:/var/lib/qualigence/skill-signing",
    "    environment:",
    `      SERVER_OIDC_JWKS_URI: http://127.0.0.1:${JWKS_PORT}/jwks`,
    "      SERVER_MISSION_DISPATCH_INTERVAL_MS: \"250\"",
    "      SERVER_MISSION_DISPATCH_INITIAL_BACKOFF_MS: \"50\"",
    "      SERVER_MISSION_DISPATCH_MAXIMUM_BACKOFF_MS: \"1000\"",
    "      SERVER_INTELLIGENCE_RESULT_IDLE_BACKOFF_MS: \"250\"",
    "      SERVER_INTELLIGENCE_RESULT_ERROR_BACKOFF_MS: \"250\"",
    "  worker:",
    `    image: ${NODE_RUNTIME_IMAGE}`,
    "    build: !reset null",
    "    working_dir: /workspace",
    "    user: \"1000:1000\"",
    "    entrypoint: [\"node\", \"/workspace/apps/intelligence-worker/dist/main.js\"]",
    "    command: !override []",
    "    volumes: !override",
    `      - \"${composePath(REPO_ROOT)}:/workspace:ro\"`,
    "  console:",
    "    image: caddy:2.8-alpine@sha256:af32e97399febea808609119bb21544d0265c58a02836576e32a2d082c262c17",
    "    build: !reset null",
    "    volumes: !override",
    `      - \"${composePath(join(REPO_ROOT, "apps", "web-console", "dist"))}:/srv:ro\"`,
    "  proxy:",
    "    ports: !override",
    `      - \"127.0.0.1:${ctx.proxyPort}:443\"`,
    "",
    "secrets:",
    ...Object.entries(SECRET_FILE_NAMES).flatMap(([secretName, fileName]) => [
      `  ${secretName}:`,
      `    file: ${JSON.stringify(composePath(join(ctx.workDir, fileName)))}`,
    ]),
    "",
  ].join("\n"), "utf8");
}

async function writeHarnessSecrets(ctx: HarnessContext): Promise<void> {
  const secretValues: Record<string, string> = {
    pg_admin_password: "qualigence_admin_pw",
    pg_server_password: "qualigence_server_pw",
    pg_worker_password: "qualigence_worker_pw",
    s3_access_key_id: "qualigence-access-key",
    s3_secret_access_key: "qualigence-secret-key",
    kms_root_key: Buffer.alloc(32, 7).toString("base64"),
    oidc_claim_map: JSON.stringify({
      tenantClaim: "https://qualigence.example/tenant",
      rolesClaim: "https://qualigence.example/roles",
      allowedTenants: ["tenant-readiness-e2e"],
      roleMap: { "qa-admin": "admin", "qa-tester": "tester", "qa-viewer": "viewer" },
    }),
    runner_ca_cert: ctx.runnerCa.certPem,
    runner_ca_key: ctx.runnerCa.keyPem,
    runner_server_cert: ctx.runnerServer.certPem,
    runner_server_key: ctx.runnerServer.keyPem,
    worker_model_api_key: "worker-model-api-key",
    tls_cert: ctx.proxyCertificateChainPem,
    tls_key: ctx.proxy.keyPem,
  };

  for (const [name, value] of Object.entries(secretValues)) {
    await writeFile(secretPath(ctx, name), value, "utf8");
  }
}

async function waitForStackReady(ctx: HarnessContext): Promise<void> {
  await poll(async () => {
    const readiness = await serverReadiness(ctx);
    if (readiness.ready) return readiness;
    throw new Error(formatReadinessProbe(readiness));
  }, READINESS_TIMEOUT_MS, 2_000, "ReadinessE2EFailed: Server did not become ready");

  await poll(async () => {
    const readiness = await workerReadiness(ctx);
    if (readiness.ready) return readiness;
    throw new Error(formatReadinessProbe(readiness));
  }, READINESS_TIMEOUT_MS, 2_000, "ReadinessE2EFailed: Worker did not become ready");

  await poll(async () => {
    const health = await serviceHealth(ctx, "console");
    if (health === "healthy") return health;
    throw new Error(`console health=${health ?? "missing"}`);
  }, 120_000, 2_000, "ReadinessE2EFailed: Console did not become healthy");

  await poll(async () => {
    const health = await serviceHealth(ctx, "proxy");
    if (health === "healthy") return health;
    throw new Error(`proxy health=${health ?? "missing"}`);
  }, 120_000, 2_000, "ReadinessE2EFailed: proxy did not become healthy");

  await poll(async () => {
    const readiness = await publicProxyReadiness(ctx);
    if (readiness.ready) return readiness;
    throw new Error(formatReadinessProbe(readiness));
  }, 120_000, 2_000, "ReadinessE2EFailed: public /api/readyz did not become ready through the proxy");
}

async function serverReadiness(ctx: HarnessContext): Promise<ReadinessProbeResult> {
  return containerReadiness(ctx, "server", 8080, "server-container");
}

async function workerReadiness(ctx: HarnessContext): Promise<ReadinessProbeResult> {
  return containerReadiness(ctx, "worker", 8081, "worker-container");
}

async function containerReadiness(
  ctx: HarnessContext,
  service: string,
  port: number,
  source: ReadinessProbeResult["source"],
): Promise<ReadinessProbeResult> {
  try {
    const { stdout } = await compose(ctx, [
      "exec",
      "-T",
      service,
      "node",
      "-e",
      [
        `fetch('http://127.0.0.1:${port}/readyz')`,
        ".then(async (response) => { console.log(JSON.stringify({ status: response.status, body: await response.text() })); })",
        ".catch((error) => { console.log(JSON.stringify({ error: error && error.stack ? error.stack : String(error) })); })",
      ].join(""),
    ], 30_000);
    const response = parseProbeJson(stdout);
    return readinessProbeFromText(source, response.status, response.body, response.error);
  } catch (error) {
    return { ready: false, source, error: errorMessage(error) };
  }
}

async function publicProxyReadiness(ctx: HarnessContext): Promise<ReadinessProbeResult> {
  try {
    const response = await httpsText(`https://127.0.0.1:${ctx.proxyPort}/api/readyz`, ctx.proxyCaPem);
    return readinessProbeFromText("public-proxy", response.status, response.body, undefined);
  } catch (error) {
    return { ready: false, source: "public-proxy", error: errorMessage(error) };
  }
}

function readinessProbeFromText(
  source: ReadinessProbeResult["source"],
  httpStatus: number | undefined,
  body: string | undefined,
  error: string | undefined,
): ReadinessProbeResult {
  const report = parseReadinessReport(body);
  return {
    ready: httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300 && report?.status === "ready",
    source,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(report === undefined ? {} : { report }),
    ...(body === undefined ? {} : { body }),
    ...(error === undefined ? {} : { error }),
  };
}

function parseProbeJson(stdout: string): { readonly status?: number; readonly body?: string; readonly error?: string } {
  const line = stdout.trim().split(/\r?\n/).filter((value) => value.length > 0).at(-1);
  if (line === undefined) return { error: "empty readiness probe output" };
  try {
    const parsed = JSON.parse(line) as { readonly status?: unknown; readonly body?: unknown; readonly error?: unknown };
    return {
      ...(typeof parsed.status === "number" ? { status: parsed.status } : {}),
      ...(typeof parsed.body === "string" ? { body: parsed.body } : {}),
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    };
  } catch (error) {
    return { error: `unparseable readiness probe output: ${line}; ${errorMessage(error)}` };
  }
}

function parseReadinessReport(body: string | undefined): ReadinessReportDto | undefined {
  if (body === undefined || body.length === 0) return undefined;
  try {
    return JSON.parse(body) as ReadinessReportDto;
  } catch {
    return undefined;
  }
}

function formatReadinessProbe(result: ReadinessProbeResult): string {
  const parts = [`${result.source} readiness`];
  if (result.httpStatus !== undefined) parts.push(`http=${result.httpStatus}`);
  if (result.report?.status !== undefined) parts.push(`status=${result.report.status}`);
  const failingChecks = result.report?.checks
    ?.filter((check) => check.status !== "pass")
    .map((check) => [
      check.name ?? "unknown",
      check.status ?? "unknown",
      check.code,
      check.safeMessage,
      check.details === undefined ? undefined : JSON.stringify(check.details),
    ].filter((value): value is string => value !== undefined && value.length > 0).join(":"));
  if (failingChecks !== undefined && failingChecks.length > 0) {
    parts.push(`failingChecks=[${failingChecks.join("; ")}]`);
  }
  if (result.error !== undefined) parts.push(`error=${truncate(result.error)}`);
  if (result.report === undefined && result.body !== undefined) parts.push(`body=${truncate(result.body)}`);
  return parts.join(" ");
}

async function serviceHealth(ctx: HarnessContext, service: string): Promise<string | undefined> {
  const id = await serviceContainerId(ctx, service);
  if (id === undefined) return undefined;
  const { stdout } = await runCommand("docker", ["inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", id], { timeout: 30_000 });
  return stdout.trim();
}

async function serviceContainerId(ctx: HarnessContext, service: string): Promise<string | undefined> {
  return (await compose(ctx, ["ps", "-q", service], 30_000)).stdout.trim().split(/\s+/).filter(Boolean)[0];
}

async function ensureWorkspaceBuild(): Promise<void> {
  if (process.platform === "win32") {
    await runCommand(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "corepack pnpm build"], { timeout: 240_000 });
    return;
  }
  await runCommand("corepack", ["pnpm", "build"], { timeout: 240_000 });
}

async function requireDocker(): Promise<void> {
  try {
    await runCommand("docker", ["info"], { timeout: 15_000 });
  } catch (cause) {
    throw Object.assign(new Error("DockerUnavailable: docker info failed"), { code: "DockerUnavailable", cause });
  }
}

async function compose(ctx: HarnessContext, args: readonly string[], timeout: number): Promise<CommandResult> {
  return runCommand("docker", [
    "compose",
    "-p",
    ctx.projectName,
    "--env-file",
    COMPOSE_ENV_FILE,
    "-f",
    COMPOSE_FILE,
    "-f",
    ctx.overrideFile,
    ...args,
  ], { timeout, env: composeEnv(ctx) });
}

function composeEnv(ctx: HarnessContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MSYS_NO_PATHCONV: "1",
    QUALIGENCE_IMAGE_TAG: "ticket14-readiness-e2e",
    QUALIGENCE_RUNNER_GRPC_PORT: String(ctx.runnerGrpcPort),
    QUALIGENCE_SITE_ADDRESS: ":443",
    QUALIGENCE_OIDC_ISSUER: "https://issuer.example.com",
    QUALIGENCE_OIDC_AUDIENCE: "qualigence-self-hosted",
    QUALIGENCE_OIDC_JWKS_URI: `http://127.0.0.1:${JWKS_PORT}/jwks`,
    QUALIGENCE_MODEL_BASE_URL: "https://models.example.com/v1",
    QUALIGENCE_MODEL_NAME: "qualigence-readiness-model",
    QUALIGENCE_SERVER_PG_ROLE: "qualigence_server",
    QUALIGENCE_SITE_PORT: String(ctx.proxyPort),
  };
}

function secretPath(ctx: HarnessContext, name: string): string {
  const fileName = SECRET_FILE_NAMES[name];
  if (fileName === undefined) throw new Error(`Unknown Compose secret ${name}`);
  return join(ctx.workDir, fileName);
}

async function httpsText(url: string, ca: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(url, {
      ca,
      servername: "localhost",
      rejectUnauthorized: true,
      timeout: 15_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", rejectRequest);
    request.on("timeout", () => request.destroy(new Error(`request timed out: ${url}`)));
    request.end();
  });
}

async function poll<T>(probe: () => Promise<T | undefined>, timeoutMs: number, intervalMs: number, timeoutMessage: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${timeoutMessage}; last=${errorMessage(lastError)}`);
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly env?: NodeJS.ProcessEnv; readonly cwd?: string },
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: 4_194_304,
    });
    return { stdout, stderr };
  } catch (error) {
    const commandLine = `${command} ${args.join(" ")}`;
    const output = error as { readonly stdout?: string; readonly stderr?: string; readonly message?: string };
    throw new Error(`${commandLine} failed: ${output.message ?? errorMessage(error)}\nstdout=${truncate(output.stdout ?? "")}\nstderr=${truncate(output.stderr ?? "")}`, { cause: error });
  }
}

async function freeTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
  return address.port;
}

function createProxyCertificateAuthority(commonName: string): PemPair {
  return withOpenSslScratch((dir, openssl) => {
    openssl(["genrsa", "-out", "ca.key", "2048"]);
    openssl([
      "req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2",
      "-subj", `/CN=${commonName}`, "-out", "ca.crt",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:1",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-addext", "subjectKeyIdentifier=hash",
    ]);
    return { certPem: readFileSync(join(dir, "ca.crt"), "utf8"), keyPem: readFileSync(join(dir, "ca.key"), "utf8") };
  });
}

function mintProxyServerCertificate(ca: PemPair, commonName: string): PemPair {
  return withOpenSslScratch((dir, openssl) => {
    writeFileSync(join(dir, "ca.crt"), ca.certPem);
    writeFileSync(join(dir, "ca.key"), ca.keyPem);
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "server.key"]);
    openssl(["req", "-new", "-key", "server.key", "-subj", `/CN=${commonName}`, "-out", "server.csr"]);
    writeFileSync(join(dir, "server.ext"), [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid,issuer",
      "",
    ].join("\n"));
    openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-sha256", "-out", "server.crt", "-extfile", "server.ext", "-days", "2"]);
    return { certPem: readFileSync(join(dir, "server.crt"), "utf8"), keyPem: readFileSync(join(dir, "server.key"), "utf8") };
  });
}

function mintServerCertificate(ca: PemPair, commonName: string): PemPair {
  return withOpenSslScratch((dir, openssl) => {
    writeFileSync(join(dir, "ca.crt"), ca.certPem);
    writeFileSync(join(dir, "ca.key"), ca.keyPem);
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "server.key"]);
    openssl(["req", "-new", "-key", "server.key", "-subj", `/CN=${commonName}`, "-out", "server.csr"]);
    writeFileSync(join(dir, "server.ext"), [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "",
    ].join("\n"));
    openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-sha256", "-out", "server.crt", "-extfile", "server.ext", "-days", "2"]);
    return { certPem: readFileSync(join(dir, "server.crt"), "utf8"), keyPem: readFileSync(join(dir, "server.key"), "utf8") };
  });
}

function pemBundle(...entries: readonly string[]): string {
  return entries.map((entry) => entry.trim()).join("\n") + "\n";
}

function withOpenSslScratch<T>(run: (dir: string, openssl: (args: readonly string[]) => Buffer) => T): T {
  const dir = mkdtempSync(join(REPO_ROOT, ".readiness-e2e-pki-"));
  const openssl = (args: readonly string[]): Buffer => execFileSync("openssl", [...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  try {
    return run(dir, openssl);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function composePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function truncate(value: string, limit = 32_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...<truncated>`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
