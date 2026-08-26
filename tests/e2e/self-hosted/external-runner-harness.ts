import { createHash, createSign, generateKeyPairSync, X509Certificate, type KeyObject } from "node:crypto";
import { createServer as createModelHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createRunnerCa, mintClientCertificate, type PemPair } from "../../helpers/runner-identity-pki.js";

const execFileAsync = promisify(execFile);

const PASS_MARKER = "qualigence-external-runner-acceptance:pass";
const REPO_ROOT = process.cwd();
const COMPOSE_FILE = join(REPO_ROOT, "deployments", "self-hosted", "compose", "compose.yaml");
const COMPOSE_ENV_FILE = join(REPO_ROOT, "deployments", "self-hosted", "compose", ".env.example");
const COMPOSE_SECRETS_DIR = join(REPO_ROOT, "deployments", "self-hosted", "compose", "secrets");
const API_ISSUER = "https://issuer.example.com";
const API_AUDIENCE = "qualigence-self-hosted";
const TENANT_CLAIM = "https://qualigence.example/tenant";
const ROLES_CLAIM = "https://qualigence.example/roles";
const TENANT_ID = "tenant-external-runner-acceptance";
const PROJECT_ID = "external-runner-project";
const RUNNER_ID = "runner-external-acceptance";
const MODEL_NAME = "qualigence-external-runner-acceptance-model";
const COMPLETION_TIMEOUT_MS = 180_000;
const SECRET_FILE_NAMES: Readonly<Record<string, string>> = {
  pg_admin_password: "pg_admin_password",
  pg_server_password: "pg_server_password",
  pg_worker_password: "pg_worker_password",
  s3_access_key_id: "s3_access_key_id",
  s3_secret_access_key: "s3_secret_access_key",
  kms_root_key: "kms_root_key",
  oidc_jwks: "oidc_jwks.json",
  oidc_claim_map: "oidc_claim_map.json",
  runner_ca_cert: "runner_ca_cert.pem",
  runner_ca_key: "runner_ca_key.pem",
  runner_server_cert: "runner_server_cert.pem",
  runner_server_key: "runner_server_key.pem",
  worker_model_api_key: "worker_model_api_key",
  tls_cert: "tls_cert.pem",
  tls_key: "tls_key.pem",
};

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface HarnessContext {
  readonly projectName: string;
  readonly workDir: string;
  readonly overrideFile: string;
  readonly runnerDataDir: string;
  readonly proxyPort: number;
  readonly runnerGrpcPort: number;
  readonly proxyCaPem: string;
  readonly runnerCa: PemPair;
  readonly runnerServer: PemPair;
  readonly runnerClient: RunnerClientMaterial;
  readonly jwt: TestJwtIssuer;
  readonly secrets: SecretBackup;
  readonly modelServer: Awaited<ReturnType<typeof startModelServer>>;
}

interface RunnerClientMaterial extends PemPair {
  readonly caPem: string;
  readonly fingerprintSha256: string;
  readonly certificateNotAfter: string;
  readonly uriSan: string;
  readonly certPath: string;
  readonly keyPath: string;
  readonly caPath: string;
}

interface SecretBackup {
  readonly entries: readonly { readonly path: string; readonly previous?: Buffer }[];
}

interface CommandEnvelope<T> {
  readonly resource: T;
  readonly version: number;
  readonly correlationId: string;
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
  readonly source: "server-container" | "public-proxy";
  readonly httpStatus?: number;
  readonly report?: ReadinessReportDto;
  readonly body?: string;
  readonly error?: string;
}

interface ProjectDto {
  readonly projectId: string;
  readonly version: number;
}

interface PrdRevisionDto {
  readonly prdId: string;
  readonly revision: number;
  readonly contentSha256: string;
}

interface TargetDto {
  readonly targetId: string;
  readonly version: number;
  readonly snapshotHash: string;
}

interface TestPlanDto {
  readonly planId: string;
  readonly version: number;
  readonly status: string;
}

interface MissionDto {
  readonly missionId: string;
  readonly version: number;
  readonly status: string;
}

interface StartMissionResultDto {
  readonly missionId: string;
  readonly missionVersion: number;
  readonly status: string;
  readonly runs: readonly { readonly runId: string; readonly attemptId: string; readonly runnerJobId: string }[];
}

interface RunDto {
  readonly runId: string;
  readonly missionId?: string;
  readonly status: string;
  readonly evidenceRefs: readonly string[];
  readonly completedAt?: string;
}

interface TraceEventDto {
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly stage: string;
  readonly payloadHash: string;
}

interface ListEnvelope<T> {
  readonly items: readonly T[];
}

interface TestJwtIssuer {
  readonly jwksEntries: readonly { readonly kid: string; readonly alg: "RS256"; readonly publicKeyPem: string }[];
  sign(claims: Readonly<Record<string, unknown>>): string;
}

export async function runRepositoryExternalRunnerHarness(): Promise<string> {
  const output: string[] = [];
  let ctx: HarnessContext | undefined;
  let runner: ChildProcessWithoutNullStreams | undefined;
  try {
    await requireDocker();
    ctx = await createHarnessContext();
    output.push(`harness:project=${ctx.projectName}`);
    output.push(`harness:runnerGrpcPort=${ctx.runnerGrpcPort}`);
    output.push(`harness:proxyPort=${ctx.proxyPort}`);

    await writeComposeOverride(ctx);
    await ensureWorkspaceBuild();
    await writeHarnessSecrets(ctx);
    await compose(ctx, ["up", "-d", "postgres", "minio"], 180_000);
    await compose(ctx, ["run", "--rm", "migrate"], 180_000);
    await compose(ctx, ["up", "-d", "server", "worker", "console", "proxy"], 240_000);
    await waitForStackReadiness(ctx);

    const apiBaseUrl = `https://127.0.0.1:${ctx.proxyPort}/api/v1`;
    const token = ctx.jwt.sign(standardClaims({
      [TENANT_CLAIM]: TENANT_ID,
      [ROLES_CLAIM]: ["qa-admin", "qa-tester", "qa-viewer"],
    }));

    const project = await createProject(apiBaseUrl, ctx.proxyCaPem, token);
    const prd = await ingestPrd(apiBaseUrl, ctx.proxyCaPem, token);
    const target = await createTarget(apiBaseUrl, ctx.proxyCaPem, token);
    const plan = await createApprovedPlan(apiBaseUrl, ctx.proxyCaPem, token, prd);
    const mission = await createMission(apiBaseUrl, ctx.proxyCaPem, token, target, plan);
    output.push(`harness:mission=${mission.missionId}`);

    runner = spawnExternalRunner(ctx, ctx.runnerClient);
    await waitForRunnerReady(runner);

    const started = await postJson<CommandEnvelope<StartMissionResultDto>>(apiBaseUrl, ctx.proxyCaPem, token, `/missions/${mission.missionId}/start`, {
      expectedVersion: mission.version,
    }, "external-runner-start");
    if (started.resource.runs.length !== 1) {
      throw new Error(`ExternalRunnerAcceptanceFailed: expected exactly one scheduled Run, got ${started.resource.runs.length}`);
    }
    const runId = started.resource.runs[0]?.runId;
    if (runId === undefined) {
      throw new Error("ExternalRunnerAcceptanceFailed: scheduled Run id was missing");
    }

    const evidence = await waitForDurableEvidence(apiBaseUrl, ctx.proxyCaPem, token, mission.missionId, runId);
    output.push(`harness:run=${evidence.run.runId}`);
    output.push(`harness:traceEvents=${evidence.trace.length}`);
    output.push(`harness:artifactRefs=${evidence.run.evidenceRefs.length}`);
    output.push(`${PASS_MARKER} ${JSON.stringify({
      projectId: project.projectId,
      missionId: mission.missionId,
      runId: evidence.run.runId,
      runStatus: evidence.run.status,
      missionStatus: evidence.mission.status,
      traceEvents: evidence.trace.length,
      artifactRefs: evidence.run.evidenceRefs.length,
      runnerPid: runner.pid,
    })}`);
    return `${output.join("\n")}\n`;
  } catch (error) {
    if (ctx !== undefined) {
      output.push(await safeComposeDiagnostics(ctx));
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${output.join("\n")}`, { cause: error });
  } finally {
    if (runner !== undefined) {
      await stopChild(runner);
    }
    if (ctx !== undefined) {
      await compose(ctx, ["down", "-v", "--remove-orphans", "--timeout", "10"], 180_000).catch(() => undefined);
      await restoreHarnessSecrets(ctx.secrets).catch(() => undefined);
      ctx.modelServer.close();
      await rm(ctx.workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function createHarnessContext(): Promise<HarnessContext> {
  const workDir = await mkdtemp(join(tmpdir(), "qualigence-external-runner-"));
  const runnerDataDir = join(workDir, "runner-data");
  await mkdir(runnerDataDir, { recursive: true });
  const [runnerGrpcPort, proxyPort] = await Promise.all([freeTcpPort(), freeTcpPort()]);
  const jwt = createJwtIssuer();
  const runnerCa = createRunnerCa("Qualigence external Runner acceptance CA");
  const runnerServer = mintServerCertificate(runnerCa, "localhost");
  const runnerClient = mintClientMaterial(runnerCa, workDir);
  const proxy = createSelfSignedServerCertificate("localhost");
  const modelServer = await startModelServer();
  const secrets = await backupSecretFiles();
  const projectName = `qualigence-ext-${process.pid}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

  await writeFile(join(workDir, "runner-ca.crt"), runnerCa.certPem, "utf8");
  await writeFile(join(workDir, "runner-server.crt"), runnerServer.certPem, "utf8");
  await writeFile(join(workDir, "runner-server.key"), runnerServer.keyPem, "utf8");
  await writeFile(runnerClient.certPath, runnerClient.certPem, "utf8");
  await writeFile(runnerClient.keyPath, runnerClient.keyPem, "utf8");
  await writeFile(runnerClient.caPath, runnerClient.caPem, "utf8");
  await writeFile(join(workDir, "proxy.crt"), proxy.certPem, "utf8");
  await writeFile(join(workDir, "proxy.key"), proxy.keyPem, "utf8");

  return {
    projectName,
    workDir,
    overrideFile: join(workDir, "compose.override.yaml"),
    runnerDataDir,
    proxyPort,
    runnerGrpcPort,
    proxyCaPem: proxy.certPem,
    runnerCa,
    runnerServer,
    runnerClient,
    jwt,
    secrets,
    modelServer,
  };
}

async function writeHarnessSecrets(ctx: HarnessContext): Promise<void> {
  await mkdir(COMPOSE_SECRETS_DIR, { recursive: true });
  const secretValues: Record<string, string> = {
    pg_admin_password: "qualigence_admin_pw",
    pg_server_password: "qualigence_server_pw",
    pg_worker_password: "qualigence_worker_pw",
    s3_access_key_id: "qualigence-access-key",
    s3_secret_access_key: "qualigence-secret-key",
    kms_root_key: "0123456789abcdef0123456789abcdef",
    oidc_jwks: JSON.stringify(ctx.jwt.jwksEntries),
    oidc_claim_map: JSON.stringify({
      tenantClaim: TENANT_CLAIM,
      rolesClaim: ROLES_CLAIM,
      allowedTenants: [TENANT_ID],
      roleMap: {
        "qa-admin": "admin",
        "qa-tester": "tester",
        "qa-viewer": "viewer",
      },
    }),
    runner_ca_cert: ctx.runnerCa.certPem,
    runner_ca_key: ctx.runnerCa.keyPem,
    runner_server_cert: ctx.runnerServer.certPem,
    runner_server_key: ctx.runnerServer.keyPem,
    worker_model_api_key: "worker-model-api-key",
    tls_cert: await readFile(join(ctx.workDir, "proxy.crt"), "utf8"),
    tls_key: await readFile(join(ctx.workDir, "proxy.key"), "utf8"),
  };

  for (const [name, value] of Object.entries(secretValues)) {
    await writeFile(join(COMPOSE_SECRETS_DIR, secretFileName(name)), value, "utf8");
  }
}

async function backupSecretFiles(): Promise<SecretBackup> {
  const entries = await Promise.all(Object.values(SECRET_FILE_NAMES).map(async (fileName) => {
    const path = join(COMPOSE_SECRETS_DIR, fileName);
    try {
      return { path, previous: await readFile(path) };
    } catch {
      return { path };
    }
  }));
  return { entries };
}

function secretFileName(name: string): string {
  const fileName = SECRET_FILE_NAMES[name];
  if (fileName === undefined) throw new Error(`Unknown Compose secret ${name}`);
  return fileName;
}

async function restoreHarnessSecrets(backup: SecretBackup): Promise<void> {
  for (const entry of backup.entries) {
    if (entry.previous === undefined) {
      await rm(entry.path, { force: true });
      continue;
    }
    await writeFile(entry.path, entry.previous);
  }
}

async function writeComposeOverride(ctx: HarnessContext): Promise<void> {
  await writeFile(join(ctx.workDir, "bootstrap.mjs"), `
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
  await db.insertInto("runner_principals").values({
    tenant_id: ${JSON.stringify(TENANT_ID)},
    fingerprint_sha256: ${JSON.stringify("__RUNNER_FINGERPRINT__")},
    runner_id: ${JSON.stringify(RUNNER_ID)},
    project_ids_json: ${JSON.stringify(JSON.stringify([PROJECT_ID]))},
    certificate_uri_san: ${JSON.stringify("__RUNNER_URI_SAN__")},
    enrollment_id: "external-runner-harness",
    status: "active",
    certificate_not_after: ${JSON.stringify("__RUNNER_NOT_AFTER__")},
  }).onConflict((oc) => oc.columns(["tenant_id", "fingerprint_sha256"]).doNothing()).execute();
} finally {
  await db.destroy();
}
console.log("external-runner-harness:database-provisioned");
`.replace("__RUNNER_FINGERPRINT__", ctx.runnerClient.fingerprintSha256).replace("__RUNNER_URI_SAN__", ctx.runnerClient.uriSan).replace("__RUNNER_NOT_AFTER__", ctx.runnerClient.certificateNotAfter), "utf8");
  await writeFile(ctx.overrideFile, [
    "services:",
    "  server-volume-permissions:",
    `    image: ${nodeRuntimeImage()}`,
    "    build: !reset null",
    "  migrate:",
    `    image: ${nodeRuntimeImage()}`,
    "    build: !reset null",
    `    volumes:`,
    `      - \"${composePath(REPO_ROOT)}:/workspace:ro\"`,
    `      - \"${composePath(ctx.workDir)}:/harness:ro\"`,
    "    entrypoint: [\"node\", \"/harness/bootstrap.mjs\"]",
    "    command: !override []",
    "  server:",
    `    image: ${nodeRuntimeImage()}`,
    "    build: !reset null",
    "    working_dir: /workspace",
    "    user: \"1000:1000\"",
    "    entrypoint: [\"node\", \"/workspace/apps/server/dist/main.js\"]",
    "    command: !override []",
    "    volumes:",
    `      - \"${composePath(REPO_ROOT)}:/workspace:ro\"`,
    "      - artifactdata:/var/lib/qualigence/artifacts",
    "      - skill_signing_data:/var/lib/qualigence/skill-signing",
    "    environment:",
    "      SERVER_MISSION_DISPATCH_INTERVAL_MS: \"250\"",
    "      SERVER_MISSION_DISPATCH_INITIAL_BACKOFF_MS: \"50\"",
    "      SERVER_MISSION_DISPATCH_MAXIMUM_BACKOFF_MS: \"1000\"",
    "  worker:",
    `    image: ${nodeRuntimeImage()}`,
    "    build: !reset null",
    "    working_dir: /workspace",
    "    user: \"1000:1000\"",
    "    entrypoint: [\"node\", \"/workspace/apps/intelligence-worker/dist/main.js\"]",
    "    command: !override []",
    "    volumes:",
    `      - \"${composePath(REPO_ROOT)}:/workspace:ro\"`,
    "    healthcheck:",
    "      test:",
    "        - CMD-SHELL",
    "        - >-",
    "          node -e \"Promise.all([fetch('http://minio:9000/minio/health/ready').then(r=>{if(!r.ok)throw new Error('minio status '+r.status)}),import('pg').then(async (pg)=>{const {Client}=pg.default??pg;const fs=await import('node:fs/promises');const c=new Client({host:process.env.WORKER_PG_HOST,port:Number(process.env.WORKER_PG_PORT),database:process.env.WORKER_PG_DATABASE,user:process.env.WORKER_PG_USER,password:(await fs.readFile(process.env.WORKER_PG_PASSWORD_FILE,'utf8')).trim(),connectionTimeoutMillis:5000});try{await c.connect();await c.query('select 1')}finally{await c.end().catch(()=>undefined)}})]).then(()=>process.exit(0),(error)=>{console.error(error&&error.stack?error.stack:String(error));process.exit(1)})\"",
    "      timeout: 20s",
    "      retries: 18",
    "  console:",
    "    image: caddy:2.8-alpine@sha256:af32e97399febea808609119bb21544d0265c58a02836576e32a2d082c262c17",
    "    build: !reset null",
    "    volumes:",
    `      - \"${composePath(join(REPO_ROOT, "apps", "web-console", "dist"))}:/srv:ro\"`,
    "  proxy:",
    "    ports: !override",
    `      - \"127.0.0.1:${ctx.proxyPort}:443\"`,
    "",
  ].join("\n"), "utf8");
}

async function createProject(apiBaseUrl: string, ca: string, token: string): Promise<ProjectDto> {
  const result = await postJson<CommandEnvelope<ProjectDto>>(apiBaseUrl, ca, token, "/projects", {
    name: "External Runner Acceptance",
  }, PROJECT_ID);
  return result.resource;
}

async function ingestPrd(apiBaseUrl: string, ca: string, token: string): Promise<PrdRevisionDto> {
  const content = "A user can load the Example Domain page and see the Example Domain heading.";
  const result = await postJson<CommandEnvelope<PrdRevisionDto>>(apiBaseUrl, ca, token, `/projects/${PROJECT_ID}/prd-revisions`, {
    title: "External Runner Acceptance PRD",
    content,
  }, "external-runner-prd");
  return result.resource;
}

async function createTarget(apiBaseUrl: string, ca: string, token: string): Promise<TargetDto> {
  const result = await postJson<CommandEnvelope<TargetDto>>(apiBaseUrl, ca, token, `/projects/${PROJECT_ID}/targets`, {
    targetId: "external-runner-target",
    displayName: "Example Domain",
    runnerId: RUNNER_ID,
    expectedVersion: 0,
    configuration: {
      kind: "web",
      startUrl: "https://example.com/",
      allowedOrigins: ["https://example.com"],
      browser: "chromium",
    },
  }, "external-runner-target");
  return result.resource;
}

async function createApprovedPlan(apiBaseUrl: string, ca: string, token: string, prd: PrdRevisionDto): Promise<TestPlanDto> {
  const content = "A user can load the Example Domain page and see the Example Domain heading.";
  const sourceRef = {
    prdId: prd.prdId,
    revision: prd.revision,
    startOffset: 0,
    endOffset: content.length,
    quotedTextSha256: sha256(content),
  };
  const draft = await postJson<CommandEnvelope<TestPlanDto>>(apiBaseUrl, ca, token, "/test-plans", {
    projectId: PROJECT_ID,
    prdId: prd.prdId,
    prdRevision: prd.revision,
    sourceContentSha256: prd.contentSha256,
    expectedClaims: [{
      semanticKey: "example.heading.visible",
      statement: "The Example Domain heading is visible.",
      sourceRefs: [sourceRef],
      confidence: 1,
    }],
    testCases: [{
      title: "Verify Example Domain",
      objective: "Verify that the Example Domain page is reachable and visible.",
      preconditions: [],
      steps: [
        { kind: "navigate", path: "/" },
        { kind: "verify", claimSemanticKeys: ["example.heading.visible"] },
      ],
      expectedClaimSemanticKeys: ["example.heading.visible"],
      sourceRefs: [sourceRef],
      priority: "high",
    }],
  }, "external-runner-plan");
  const approved = await postJson<CommandEnvelope<TestPlanDto>>(apiBaseUrl, ca, token, `/test-plans/${draft.resource.planId}/approve`, {
    expectedVersion: draft.resource.version,
  }, "external-runner-plan-approve");
  if (approved.resource.status !== "approved") {
    throw new Error(`ExternalRunnerAcceptanceFailed: plan did not become approved (${approved.resource.status})`);
  }
  return approved.resource;
}

async function createMission(
  apiBaseUrl: string,
  ca: string,
  token: string,
  target: TargetDto,
  plan: TestPlanDto,
): Promise<MissionDto> {
  const result = await postJson<CommandEnvelope<MissionDto>>(apiBaseUrl, ca, token, "/missions", {
    projectId: PROJECT_ID,
    targetId: target.targetId,
    targetVersion: target.version,
    targetSnapshotHash: target.snapshotHash,
    planId: plan.planId,
    planVersion: plan.version,
  }, "external-runner-mission");
  if (result.resource.status !== "approved") {
    throw new Error(`ExternalRunnerAcceptanceFailed: mission did not become approved (${result.resource.status})`);
  }
  return result.resource;
}

function spawnExternalRunner(
  ctx: HarnessContext,
  certificate: { readonly certPath: string; readonly keyPath: string; readonly caPath: string },
): ChildProcessWithoutNullStreams {
  const runnerEntrypoint = join(REPO_ROOT, "apps", "runner", "dist", "main.js");
  const child = spawn(process.execPath, [runnerEntrypoint], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RUNNER_ID,
      RUNNER_TENANT_ID: TENANT_ID,
      RUNNER_TLS_CA: certificate.caPath,
      RUNNER_TLS_CERT: certificate.certPath,
      RUNNER_TLS_KEY: certificate.keyPath,
      RUNNER_DATA_DIR: ctx.runnerDataDir,
      CORE_ADDRESS: `127.0.0.1:${ctx.runnerGrpcPort}`,
      CORE_AUTHORITY: "localhost",
      RUNNER_MODEL_BASE_URL: ctx.modelServer.baseUrl,
      RUNNER_MODEL_API_KEY: "external-runner-model-api-key",
      RUNNER_MODEL_NAME: MODEL_NAME,
      RUNNER_MODEL_MAXIMUM_TOKENS_PER_CALL: "1000",
      RUNNER_NAVIGATION_TIMEOUT_MS: "30000",
      RUNNER_ACTION_TIMEOUT_MS: "15000",
      RUNNER_HEADED: "false",
    },
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[external-runner] ${String(chunk)}`);
  });
  return child;
}

async function waitForRunnerReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  let output = "";
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(new Error(`ExternalRunnerUnavailable: product Runner did not report ready before timeout. stdout=${output}`));
    }, 60_000);
    const onStdout = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes('"event":"runner.ready"')) {
        cleanup();
        resolveReady();
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      rejectReady(new Error(`ExternalRunnerUnavailable: product Runner exited before ready with code ${String(code)}. stdout=${output}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onStdout);
    child.once("exit", onExit);
  });
}

async function waitForDurableEvidence(
  apiBaseUrl: string,
  ca: string,
  token: string,
  missionId: string,
  runId: string,
): Promise<{ readonly mission: MissionDto; readonly run: RunDto; readonly trace: readonly TraceEventDto[] }> {
  return poll(async () => {
    const [mission, run, traceEnvelope] = await Promise.all([
      getJson<MissionDto>(apiBaseUrl, ca, token, `/missions/${missionId}`),
      getJson<RunDto>(apiBaseUrl, ca, token, `/runs/${runId}`),
      getJson<ListEnvelope<TraceEventDto>>(apiBaseUrl, ca, token, `/runs/${runId}/trace`),
    ]);
    const trace = traceEnvelope.items;
    const terminal = run.status !== "running" && mission.status === "completed";
    const hasTrace = trace.some((event) => event.stage === "observation") && trace.some((event) => event.stage === "run_completed");
    const hasArtifacts = run.evidenceRefs.length > 0;
    if (terminal && run.status === "passed" && hasTrace && hasArtifacts) {
      return { mission, run, trace };
    }
    if (run.status === "blocked" || run.status === "error" || run.status === "finding" || mission.status === "blocked") {
      throw new Error(`ExternalRunnerAcceptanceFailed: terminal non-pass state mission=${mission.status} run=${run.status} trace=${trace.map((event) => event.stage).join(",")} artifactRefs=${run.evidenceRefs.length}`);
    }
    return undefined;
  }, COMPLETION_TIMEOUT_MS, 2_000, "ExternalRunnerAcceptanceFailed: timed out waiting for Mission/Run/Trace/Artifact completion");
}

async function waitForStackReadiness(ctx: HarnessContext): Promise<void> {
  await poll(async () => {
    const readiness = await serverContainerReadiness(ctx);
    if (readiness.ready) return true;
    throw new Error(formatReadinessProbe(readiness));
  }, 300_000, 2_000, "ExternalRunnerUnavailable: Compose Server readiness did not become ready");

  await poll(async () => {
    const health = await serviceHealth(ctx, "worker");
    if (health === "healthy") return true;
    throw new Error(`worker health=${health ?? "missing"}`);
  }, 120_000, 2_000, "ExternalRunnerUnavailable: Compose Worker did not become healthy");
  await poll(async () => {
    const health = await serviceHealth(ctx, "console");
    if (health === "healthy") return true;
    throw new Error(`console health=${health ?? "missing"}`);
  }, 120_000, 2_000, "ExternalRunnerUnavailable: Compose Console did not become healthy");
  await poll(async () => {
    const health = await serviceHealth(ctx, "proxy");
    if (health === "healthy") return true;
    throw new Error(`proxy health=${health ?? "missing"}`);
  }, 120_000, 2_000, "ExternalRunnerUnavailable: Compose proxy did not become healthy");
  await poll(async () => {
    const readiness = await publicProxyReadiness(ctx);
    if (readiness.ready) return true;
    throw new Error(formatReadinessProbe(readiness));
  }, 120_000, 2_000, "ExternalRunnerUnavailable: public /api/readyz did not become ready through the proxy");
}

async function serverContainerReadiness(ctx: HarnessContext): Promise<ReadinessProbeResult> {
  try {
    const { stdout } = await compose(ctx, [
      "exec",
      "-T",
      "server",
      "node",
      "-e",
      [
        "fetch('http://127.0.0.1:8080/readyz')",
        ".then(async (response) => { console.log(JSON.stringify({ status: response.status, body: await response.text() })); })",
        ".catch((error) => { console.log(JSON.stringify({ error: error && error.stack ? error.stack : String(error) })); })",
      ].join(""),
    ], 30_000);
    const response = parseProbeJson(stdout);
    return readinessProbeFromText("server-container", response.status, response.body, response.error);
  } catch (error) {
    return {
      ready: false,
      source: "server-container",
      error: errorMessage(error),
    };
  }
}

async function publicProxyReadiness(ctx: HarnessContext): Promise<ReadinessProbeResult> {
  try {
    const response = await httpsText(`https://127.0.0.1:${ctx.proxyPort}/api/readyz`, ctx.proxyCaPem, undefined, undefined);
    return readinessProbeFromText("public-proxy", response.status, response.body, undefined);
  } catch (error) {
    return {
      ready: false,
      source: "public-proxy",
      error: errorMessage(error),
    };
  }
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
    ].filter((value) => value !== undefined && value.length > 0).join(":"));
  if (failingChecks !== undefined && failingChecks.length > 0) {
    parts.push(`failingChecks=[${failingChecks.join("; ")}]`);
  }
  if (result.error !== undefined) parts.push(`error=${truncateForDiagnostics(result.error)}`);
  if (result.report === undefined && result.body !== undefined) parts.push(`body=${truncateForDiagnostics(result.body)}`);
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

function nodeRuntimeImage(): string {
  return "node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7";
}

function composePath(path: string): string {
  return path.replaceAll("\\", "/");
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
  ], {
    timeout,
    env: composeEnv(ctx),
  });
}

function composeEnv(ctx: HarnessContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MSYS_NO_PATHCONV: "1",
    QUALIGENCE_IMAGE_TAG: "ticket12-external-runner-harness",
    QUALIGENCE_RUNNER_GRPC_PORT: String(ctx.runnerGrpcPort),
    QUALIGENCE_SITE_ADDRESS: ":443",
    QUALIGENCE_OIDC_ISSUER: API_ISSUER,
    QUALIGENCE_OIDC_AUDIENCE: API_AUDIENCE,
    QUALIGENCE_MODEL_BASE_URL: ctx.modelServer.baseUrl,
    QUALIGENCE_MODEL_NAME: MODEL_NAME,
    QUALIGENCE_SERVER_PG_ROLE: "qualigence_server",
  };
}

async function postJson<T>(
  apiBaseUrl: string,
  ca: string,
  token: string | undefined,
  path: string,
  body: unknown,
  idempotencyKey?: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<T> {
  return httpsJson<T>(`${apiBaseUrl}${path}`, ca, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      ...extraHeaders,
    },
  }, JSON.stringify(body));
}

async function getJson<T>(apiBaseUrl: string, ca: string, token: string, path: string): Promise<T> {
  return httpsJson<T>(`${apiBaseUrl}${path}`, ca, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  }, undefined);
}

async function httpsJson<T>(url: string, ca: string, options: RequestOptions | undefined, body: string | undefined): Promise<T> {
  const response = await httpsText(url, ca, options, body);
  const parsed = response.body.length === 0 ? undefined : JSON.parse(response.body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`ExternalRunnerAcceptanceFailed: ${options?.method ?? "GET"} ${url} returned ${response.status}: ${response.body}`);
  }
  return parsed as T;
}

async function httpsText(
  url: string,
  ca: string,
  options: RequestOptions | undefined,
  body: string | undefined,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(url, {
      ...options,
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
    request.on("timeout", () => {
      request.destroy(new Error(`request timed out: ${url}`));
    });
    if (body !== undefined) request.write(body);
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
    await delay(intervalMs);
  }
  throw new Error(lastError instanceof Error ? `${timeoutMessage}: ${lastError.message}` : timeoutMessage);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly env?: NodeJS.ProcessEnv } = { timeout: 60_000 },
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd: REPO_ROOT,
      env: options.env ?? process.env,
      timeout: options.timeout,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error) {
    const failed = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: unknown; signal?: unknown };
    const stdout = failed.stdout === undefined ? "" : String(failed.stdout);
    const stderr = failed.stderr === undefined ? "" : String(failed.stderr);
    throw new Error(`CommandFailed: ${command} ${args.join(" ")} exited with ${String(failed.code ?? failed.signal ?? "error")}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
  }
}

async function safeComposeDiagnostics(ctx: HarnessContext): Promise<string> {
  const [state, health, serverReadiness, proxyReadiness, logs] = await Promise.all([
    safeComposeState(ctx),
    safeServiceHealthDiagnostics(ctx),
    serverContainerReadiness(ctx).then(formatReadinessProbe, (error: unknown) => `server-container readiness unavailable: ${errorMessage(error)}`),
    publicProxyReadiness(ctx).then(formatReadinessProbe, (error: unknown) => `public-proxy readiness unavailable: ${errorMessage(error)}`),
    safeComposeLogs(ctx),
  ]);
  return [
    "compose diagnostics:",
    state,
    health,
    serverReadiness,
    proxyReadiness,
    logs,
  ].join("\n");
}

async function safeServiceHealthDiagnostics(ctx: HarnessContext): Promise<string> {
  const services = ["postgres", "minio", "server", "worker", "console", "proxy"];
  const diagnostics = await Promise.all(services.map(async (service) => {
    const id = await serviceContainerId(ctx, service).catch(() => undefined);
    if (id === undefined) return `${service}: missing`;
    try {
      const { stdout } = await runCommand("docker", ["inspect", "-f", "{{json .State.Health}}", id], { timeout: 30_000 });
      return `${service}: ${truncateForDiagnostics(stdout.trim(), 6_000)}`;
    } catch (error) {
      return `${service}: health inspect unavailable: ${errorMessage(error)}`;
    }
  }));
  return `compose health:\n${diagnostics.join("\n")}`;
}

async function safeComposeState(ctx: HarnessContext): Promise<string> {
  try {
    const ps = await compose(ctx, ["ps", "--format", "json"], 60_000);
    return `compose ps:\n${truncateForDiagnostics(ps.stdout)}`;
  } catch (error) {
    return `compose ps unavailable: ${errorMessage(error)}`;
  }
}

async function safeComposeLogs(ctx: HarnessContext): Promise<string> {
  try {
    const logs = await compose(ctx, ["logs", "--no-color", "--tail", "160"], 60_000);
    return `compose logs (tail):\n${truncateForDiagnostics(`${logs.stdout}\n${logs.stderr}`, 96_000)}`;
  } catch (error) {
    return `compose logs unavailable: ${errorMessage(error)}`;
  }
}

function truncateForDiagnostics(value: string, maxLength = 4_000): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveStop) => child.once("exit", () => resolveStop())),
    delay(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function freeTcpPort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("failed to allocate TCP port");
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
  return address.port;
}

function createJwtIssuer(): TestJwtIssuer {
  const { privateKey, publicKey }: { readonly privateKey: KeyObject; readonly publicKey: KeyObject } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "external-runner-acceptance-key";
  const alg = "RS256" as const;
  return {
    jwksEntries: [{ kid, alg, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() }],
    sign(claims: Readonly<Record<string, unknown>>): string {
      const header = { alg, kid, typ: "JWT" };
      const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
      const signer = createSign("SHA256");
      signer.update(signingInput);
      signer.end();
      return `${signingInput}.${base64url(signer.sign(privateKey))}`;
    },
  };
}

function standardClaims(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    iss: API_ISSUER,
    aud: API_AUDIENCE,
    sub: "external-runner-acceptance-user",
    iat: nowSeconds,
    nbf: nowSeconds - 5,
    exp: nowSeconds + 3600,
    ...overrides,
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mintClientMaterial(ca: PemPair, workDir: string): RunnerClientMaterial {
  const uriSan = `spiffe://qualigence.local/tenants/${TENANT_ID}/runners/${RUNNER_ID}`;
  const certificate = mintClientCertificate({ ca, commonName: RUNNER_ID, uriSan, keyKind: "rsa-3072" });
  const parsed = new X509Certificate(certificate.certPem);
  return {
    ...certificate,
    caPem: ca.certPem,
    fingerprintSha256: parsed.fingerprint256.replace(/:/g, "").toLowerCase(),
    certificateNotAfter: new Date(parsed.validTo).toISOString(),
    uriSan,
    certPath: join(workDir, "runner-client.crt"),
    keyPath: join(workDir, "runner-client.key"),
    caPath: join(workDir, "runner-client-ca.crt"),
  };
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

function createSelfSignedServerCertificate(commonName: string): PemPair {
  return withOpenSslScratch((dir, openssl) => {
    openssl([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
      "-subj", `/CN=${commonName}`,
      "-keyout", "server.key",
      "-out", "server.crt",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
    return { certPem: readFileSync(join(dir, "server.crt"), "utf8"), keyPem: readFileSync(join(dir, "server.key"), "utf8") };
  });
}

function withOpenSslScratch<T>(run: (dir: string, openssl: (args: readonly string[]) => Buffer) => T): T {
  const dir = mkdtempSync(join(REPO_ROOT, ".external-runner-pki-"));
  const openssl = (args: readonly string[]): Buffer => execFileSync("openssl", [...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  try {
    return run(dir, openssl);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function startModelServer(): Promise<{ readonly baseUrl: string; close(): void }> {
  const server = createModelHttpServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || !String(request.url ?? "").endsWith("/chat/completions")) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const body = JSON.parse(await readRequestBody(request)) as {
      readonly model?: string;
      readonly messages?: readonly { readonly role: string; readonly content: string }[];
      readonly response_format?: { readonly json_schema?: { readonly name?: string } };
    };
    const operation = body.response_format?.json_schema?.name;
    const output = operation === "execution_verification"
      ? { status: "passed", summary: "the external Runner observed the target page and satisfied the claim", claims: [] }
      : { reason: "follow the approved acceptance plan" };
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: `chatcmpl-external-runner-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? MODEL_NAME,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("ExternalRunnerUnavailable: model harness listener did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => server.close(),
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  runRepositoryExternalRunnerHarness().then(
    (output) => process.stdout.write(output),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
