#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import BetterSqlite3 from "better-sqlite3";
import {
  aggregateHealthStatus,
  type HealthCheck,
  type HealthReport,
  type LocalConfig,
  encodeBootstrapCredential,
} from "@qualigence/local-control";
import { SqliteRuntime, SUPPORTED_SCHEMA_VERSION } from "@qualigence/sqlite-runtime";
import { SystemClock } from "@qualigence/shared-kernel";
import { BackupManager } from "./backup-manager.js";
import { certPathsFor, ensureLocalCerts } from "./certs.js";
import { loadLocalConfig, loadYaml, LocalConfigError } from "./config.js";
import {
  claimMatchingStopRequest,
  ChildProcessUnit,
  terminateProcess,
} from "./child-process-unit.js";
import { LocalDoctor } from "./doctor.js";
import { LauncherError } from "./errors.js";
import { HealthClient } from "./health-client.js";
import { MigrationGuard } from "./migration-guard.js";
import { createBootstrapCredentialHandoff } from "./bootstrap-credential-handoff.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import {
  clearRuntimeState,
  clearOwnedTopologyFiles,
  isPidAlive,
  isTopologyRunning,
  publishStopRequest,
  readRuntimeState,
  sameTopology,
  writeRuntimeState,
  type RuntimeState,
} from "./runtime-state.js";

const VERSION = "0.1.0";
const SHUTDOWN_GRACE_MS = 5_000;
const STARTUP_TIMEOUT_MS = 15_000;

/** Injectable IO so the command layer stays testable and side-effect explicit. */
export interface LauncherIo {
  out(line: string): void;
  err(line: string): void;
  exit(code: number): void;
}

export interface LauncherDependencies {
  readonly createBootstrapCredentials?: typeof createBootstrapCredentialHandoff;
}

const defaultIo: LauncherIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  exit: (code) => {
    process.exitCode = code;
  },
};

interface LauncherContext {
  readonly dataDir: string;
  readonly configPath: string;
  readonly dbFile: string;
  readonly artifactDir: string;
  readonly logsDir: string;
  readonly config: LocalConfig;
}

function launcherRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..");
}

function resolveDataDir(cliDataDir: string | undefined, env: NodeJS.ProcessEnv): string {
  return resolve(cliDataDir ?? env.QUALIGENCE_DATA_DIR ?? "./.qualigence-local");
}

function paths(dataDir: string): Omit<LauncherContext, "config"> {
  return {
    dataDir,
    configPath: join(dataDir, "config.yaml"),
    dbFile: join(dataDir, "qualigence.db"),
    artifactDir: join(dataDir, "artifacts"),
    logsDir: join(dataDir, "logs"),
  };
}

/** Build the default configuration object written by `init`. */
function defaultConfig(dataDir: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    dataDir,
    core: {
      host: "127.0.0.1",
      port: Number.parseInt(env.QUALIGENCE_CORE_PORT ?? "50555", 10),
      httpPort: Number.parseInt(env.QUALIGENCE_CORE_HTTP_PORT ?? "50556", 10),
    },
    runner: {
      id: env.QUALIGENCE_RUNNER_ID ?? "qualigence-local-runner",
      spoolSoftBytes: 64 * 1024 * 1024,
      spoolHardBytes: 128 * 1024 * 1024,
    },
    modelProfile: {
      provider: "openai-compatible",
      baseUrl: env.QUALIGENCE_MODEL_BASE_URL ?? "http://127.0.0.1:11434/v1",
      model: env.QUALIGENCE_MODEL ?? "qwen2.5",
      credentialRef: env.QUALIGENCE_CREDENTIAL_REF ?? "local-model-credential",
      visualInput: env.QUALIGENCE_VISUAL_INPUT ?? "disabled",
    },
    auth: { bootstrapTtlMs: 600_000, userSessionTtlMs: 900_000 },
    completionReconciliationRetryBaseMs: 1_000,
    completionReconciliationRetryMaximumMs: 60_000,
    completionReconciliationMaximumAttempts: 8,
    completionReconciliationPollIntervalMs: 250,
    completionReconciliationBatchSize: 64,
    shutdown: { stopRequestPollIntervalMs: 250, stopRequestMaximumAgeMs: 30_000, stopRequestWaitTimeoutMs: 60_000, drainTimeoutMs: 30_000 },
  };
}

async function loadContext(
  cliDataDir: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<LauncherContext> {
  const dataDir = resolveDataDir(cliDataDir, env);
  const base = paths(dataDir);
  const yaml = existsSync(base.configPath)
    ? loadYaml(await readFile(base.configPath, "utf8"))
    : undefined;
  const cli: Record<string, unknown> = { dataDir };
  const config = loadLocalConfig({ yaml, env, cli });
  return { ...base, config };
}

function currentSchemaVersion(dbFile: string): number {
  const db = new BetterSqlite3(dbFile, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    return row.version ?? 0;
  } finally {
    db.close();
  }
}

function parseEnvJson(raw: string | undefined): NodeJS.ProcessEnv {
  if (raw === undefined || raw.length === 0) return {};
  return JSON.parse(raw) as NodeJS.ProcessEnv;
}

function parseArgsJson(raw: string | undefined, fallback: string): readonly string[] {
  if (raw === undefined || raw.length === 0) return [fallback];
  return JSON.parse(raw) as string[];
}

function resolveSecret(credentialRef: string, env: NodeJS.ProcessEnv): string {
  const normalized = credentialRef.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return env.QUALIGENCE_MODEL_API_KEY ?? env[`QUALIGENCE_SECRET_${normalized}`] ?? "";
}

function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const settle = (result: boolean): void => {
      socket.destroy();
      resolvePromise(result);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1_000, () => settle(false));
  });
}

function buildCoreUnit(ctx: LauncherContext, env: NodeJS.ProcessEnv, frame: Buffer): ChildProcessUnit {
  const certs = certPathsFor(ctx.dataDir);
  const command = env.QUALIGENCE_CORE_COMMAND ?? process.execPath;
  const args = parseArgsJson(
    env.QUALIGENCE_CORE_ARGS,
    join(launcherRoot(), "apps", "core-daemon", "dist", "main.js"),
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CORE_HOST: "127.0.0.1",
    CORE_PORT: String(ctx.config.core.port),
    CORE_HTTP_PORT: String(ctx.config.core.httpPort),
    CORE_DEPLOYMENT_MODE: "local",
    CORE_CONFIGURED_RUNNER_ID: ctx.config.runner.id,
    CORE_BOOTSTRAP_CREDENTIAL_FD: "3",
    CORE_USER_SESSION_TTL_MS: String(ctx.config.auth.userSessionTtlMs),
    CORE_COMPLETION_RETRY_BASE_MS: String(ctx.config.completionReconciliationRetryBaseMs),
    CORE_COMPLETION_RETRY_MAXIMUM_MS: String(ctx.config.completionReconciliationRetryMaximumMs),
    CORE_COMPLETION_MAXIMUM_ATTEMPTS: String(ctx.config.completionReconciliationMaximumAttempts),
    CORE_COMPLETION_POLL_INTERVAL_MS: String(ctx.config.completionReconciliationPollIntervalMs),
    CORE_COMPLETION_BATCH_SIZE: String(ctx.config.completionReconciliationBatchSize),
    CORE_TLS_CA: certs.ca,
    CORE_TLS_CERT: certs.coreCert,
    CORE_TLS_KEY: certs.coreKey,
    CORE_DATA_DIR: ctx.dataDir,
    ...parseEnvJson(env.QUALIGENCE_CORE_EXTRA_ENV),
  };
  return new ChildProcessUnit({
    name: "core",
    unhealthyCode: "CoreUnhealthy",
    command,
    args,
    env: childEnv,
    logFile: join(ctx.logsDir, "core.log"),
    readyEvent: "core-daemon.ready",
    readyProbe: async () => (await new HealthClient(VERSION).coreHealth("127.0.0.1", ctx.config.core.httpPort ?? 50_556, "/health/internal-ready")).status === "pass",
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    detached: true,
    fd3Frame: frame,
    lifecycleLogFile: join(ctx.logsDir, "lifecycle.jsonl"),
  });
}

function buildRunnerUnit(ctx: LauncherContext, env: NodeJS.ProcessEnv): ChildProcessUnit {
  const certs = certPathsFor(ctx.dataDir);
  const command = env.QUALIGENCE_RUNNER_COMMAND ?? process.execPath;
  const args = parseArgsJson(
    env.QUALIGENCE_RUNNER_ARGS,
    join(launcherRoot(), "apps", "runner", "dist", "main.js"),
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    RUNNER_ID: ctx.config.runner.id,
    CORE_ADDRESS: `127.0.0.1:${ctx.config.core.port}`,
    CORE_AUTHORITY: "localhost",
    RUNNER_TLS_CA: certs.ca,
    RUNNER_TLS_CERT: certs.runnerCert,
    RUNNER_TLS_KEY: certs.runnerKey,
    RUNNER_DATA_DIR: ctx.dataDir,
    RUNNER_MODEL_BASE_URL: ctx.config.modelProfile.baseUrl,
    RUNNER_MODEL_API_KEY: resolveSecret(ctx.config.modelProfile.credentialRef, env),
    RUNNER_MODEL_NAME: ctx.config.modelProfile.model,
    ...parseEnvJson(env.QUALIGENCE_RUNNER_EXTRA_ENV),
  };
  return new ChildProcessUnit({
    name: "runner",
    unhealthyCode: "RunnerUnhealthy",
    command,
    args,
    env: childEnv,
    logFile: join(ctx.logsDir, "runner.log"),
    readyEvent: "runner.ready",
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    detached: true,
    lifecycleLogFile: join(ctx.logsDir, "lifecycle.jsonl"),
  });
}

async function commandInit(
  cliDataDir: string | undefined,
  env: NodeJS.ProcessEnv,
  io: LauncherIo,
): Promise<void> {
  const dataDir = resolveDataDir(cliDataDir, env);
  const base = paths(dataDir);
  await mkdir(dataDir, { recursive: true });
  await mkdir(base.artifactDir, { recursive: true });
  await mkdir(base.logsDir, { recursive: true });
  await ensureLocalCerts(dataDir);

  if (!existsSync(base.configPath)) {
    const object = defaultConfig(dataDir, env);
    // Validate before persisting so a broken template never lands on disk.
    loadLocalConfig({ yaml: object });
    await writeFile(base.configPath, stringifyYaml(object), "utf8");
  }

  const ctx: LauncherContext = {
    ...base,
    config: loadLocalConfig({ yaml: loadYaml(await readFile(base.configPath, "utf8")), env }),
  };

  const productVersion = VERSION;
  if (existsSync(ctx.dbFile)) {
    const current = currentSchemaVersion(ctx.dbFile);
    if (current > SUPPORTED_SCHEMA_VERSION) throw new LauncherError("MigrationBlocked", "database schema is newer than this Launcher");
    if (current < SUPPORTED_SCHEMA_VERSION) {
      const guard = new MigrationGuard(
        new BackupManager({
          dataDir: ctx.dataDir,
          dbFile: ctx.dbFile,
          artifactDir: ctx.artifactDir,
          productVersion,
          configFile: ctx.configPath,
        }),
      );
      await guard.protect("schema migration during init", async () => {
        const runtime = await SqliteRuntime.open({
          filename: ctx.dbFile,
          busyTimeoutMs: 5_000,
          clock: new SystemClock(),
        });
        await runtime.close();
      });
    }
  } else {
    const runtime = await SqliteRuntime.open({
      filename: ctx.dbFile,
      busyTimeoutMs: 5_000,
      clock: new SystemClock(),
    });
    await runtime.close();
  }
  const current = await SqliteRuntime.open({ filename: ctx.dbFile, busyTimeoutMs: 5_000, openMode: "require-current" });
  await current.close();

  io.out(`Initialized Qualigence Local in ${ctx.dataDir}`);
  io.out(`  config: ${ctx.configPath}`);
  io.out(`  certs:  ${certPathsFor(ctx.dataDir).dir}`);
  io.out("Run `qualigence-local start` to launch Core and Runner.");
}

async function commandStart(
  ctx: LauncherContext,
  env: NodeJS.ProcessEnv,
  io: LauncherIo,
  foreground: boolean,
  dependencies: LauncherDependencies,
): Promise<void> {
  const existing = await readRuntimeState(ctx.dataDir);
  if (isTopologyRunning(existing)) {
    throw new LauncherError("AlreadyRunning", "Qualigence Local is already running.");
  }
  if (existing !== undefined) {
    await clearRuntimeState(ctx.dataDir);
  }
  await mkdir(ctx.logsDir, { recursive: true });
  await mkdir(ctx.artifactDir, { recursive: true });
  const schema = await SqliteRuntime.open({ filename: ctx.dbFile, busyTimeoutMs: 5_000, openMode: "require-current" });
  await schema.close();

  const credentials = (dependencies.createBootstrapCredentials ?? createBootstrapCredentialHandoff)({ bootstrapTtlMs: ctx.config.auth.bootstrapTtlMs });
  const core = buildCoreUnit(ctx, env, credentials.frame());
  const runner = buildRunnerUnit(ctx, env);
  const supervisor = new ProcessSupervisor({ version: VERSION, units: [core, runner] });
  let topology: RuntimeState | undefined;
  try {
    await supervisor.start();
    const finalReady = await new HealthClient(VERSION).coreHealth("127.0.0.1", ctx.config.core.httpPort ?? 50_556, "/health/ready");
    if (finalReady.status !== "pass") throw new LauncherError("RunnerUnhealthy", "configured Runner did not register required capability");
    const corePid = core.pid();
    const runnerPid = runner.pid();
    if (corePid === undefined || runnerPid === undefined) throw new LauncherError("CoreUnhealthy", "a supervised process did not report a PID.");
    const startedAt = new Date().toISOString();
    const supervisorPid = foreground ? process.pid : await ProcessSupervisor.handoffDetached({ dataDir: ctx.dataDir, corePid, runnerPid, coreHttpPort: ctx.config.core.httpPort ?? 50_556, startedAt, supervisorCredential: credentials.supervisor, shutdown: ctx.config.shutdown });
    topology = { supervisorPid, corePid, runnerPid, corePort: ctx.config.core.port, dataDir: ctx.dataDir, startedAt };
    await writeRuntimeState(topology);
    io.out("Qualigence Local is running.");
    io.out(`  Core:            http://127.0.0.1:${ctx.config.core.httpPort ?? 50_556}`);
    io.out(`  bootstrap token: ${encodeBootstrapCredential(credentials.userBootstrap)}`);
    if (foreground) {
      credentials.userBootstrap.fill(0);
      await runForeground(supervisor, ctx, io, credentials.supervisor, ctx.config.shutdown.drainTimeoutMs, topology);
    } else {
      credentials.destroy();
      core.detach();
      runner.detach();
    }
  } catch (error) {
    credentials.destroy();
    let rollbackFailure: unknown;
    if (topology !== undefined && topology.supervisorPid !== process.pid) {
      try { await terminateProcess(topology.supervisorPid, SHUTDOWN_GRACE_MS); } catch (failure) { rollbackFailure ??= failure; }
    }
    try { await supervisor.stop(); } catch (failure) { rollbackFailure ??= failure; }
    if (topology !== undefined && rollbackFailure === undefined) {
      try { await clearOwnedTopologyFiles(ctx.dataDir, topology); } catch (failure) { rollbackFailure ??= failure; }
    }
    throw rollbackFailure ?? error;
  }
}

function runForeground(
  supervisor: ProcessSupervisor,
  ctx: LauncherContext,
  io: LauncherIo,
  supervisorCredential: Uint8Array,
  drainTimeoutMs: number,
  topology: RuntimeState,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const signals: readonly NodeJS.Signals[] = process.platform === "win32"
      ? ["SIGBREAK"]
      : ["SIGINT", "SIGTERM"];
    let shutdownPromise: Promise<void> | undefined;
    let polling = true;
    const shutdown = (): void => {
      shutdownPromise ??= (async () => {
        try {
          await quiesceCore(ctx.config.core.httpPort ?? 50_556, supervisorCredential, drainTimeoutMs).catch(() => undefined);
          await supervisor.stop();
          await clearOwnedTopologyFiles(ctx.dataDir, topology);
          io.out("Qualigence Local stopped.");
        } finally {
          polling = false;
          Buffer.from(supervisorCredential.buffer, supervisorCredential.byteOffset, supervisorCredential.byteLength).fill(0);
          for (const signal of signals) process.off(signal, shutdown);
        }
      })();
      shutdownPromise.then(resolvePromise, rejectPromise);
    };
    for (const signal of signals) process.once(signal, shutdown);
    void (async () => {
      while (polling && shutdownPromise === undefined) {
        await new Promise((resolve) => setTimeout(resolve, ctx.config.shutdown.stopRequestPollIntervalMs));
        if (await claimMatchingStopRequest(ctx.dataDir, topology, Date.now(), ctx.config.shutdown.stopRequestMaximumAgeMs, process.pid)) {
          shutdown();
        }
      }
    })().catch(rejectPromise);
  });
}

function quiesceCore(port: number, credential: Uint8Array, timeoutMs: number): Promise<void> {
  const bearer = encodeBootstrapCredential(credential);
  return new Promise((resolvePromise, rejectPromise) => {
    const call = request({ host: "127.0.0.1", port, path: "/api/v1/local/quiesce", method: "POST", headers: { authorization: `Bearer ${bearer}` }, timeout: timeoutMs }, (response) => {
      response.resume();
      response.statusCode === 200 ? resolvePromise() : rejectPromise(new Error("quiesce refused"));
    });
    call.once("error", rejectPromise);
    call.once("timeout", () => { call.destroy(); rejectPromise(new Error("quiesce timed out")); });
    call.end();
  });
}

async function commandStop(ctx: LauncherContext, io: LauncherIo): Promise<void> {
  const state = await readRuntimeState(ctx.dataDir);
  if (state === undefined) {
    io.out("Qualigence Local is not running.");
    return;
  }
  if (!isPidAlive(state.supervisorPid)) throw new LauncherError("SupervisorUnavailable", "detached supervisor is unavailable");
  const marker = { version: "local-stop-request/v1" as const, supervisorPid: state.supervisorPid, corePid: state.corePid, runnerPid: state.runnerPid, startedAt: state.startedAt, requestedAt: new Date().toISOString() };
  await publishStopRequest(ctx.dataDir, marker);
  const deadline = Date.now() + ctx.config.shutdown.stopRequestWaitTimeoutMs;
  while (Date.now() < deadline) {
    const current = await readRuntimeState(ctx.dataDir);
    if (current === undefined && !isPidAlive(state.supervisorPid) && !isPidAlive(state.runnerPid) && !isPidAlive(state.corePid)) { io.out("Qualigence Local stopped."); return; }
    if (current !== undefined && !sameTopology(current, state)) throw new LauncherError("StopTopologyChanged", "running topology changed while waiting for shutdown");
    if (!isPidAlive(state.supervisorPid)) throw new LauncherError("SupervisorUnavailable", "detached supervisor became unavailable during shutdown");
    await new Promise((resolve) => setTimeout(resolve, ctx.config.shutdown.stopRequestPollIntervalMs));
  }
  throw new LauncherError("StopTimedOut", "timed out waiting for detached topology shutdown");
}

async function statusReport(ctx: LauncherContext): Promise<HealthReport> {
  const state = await readRuntimeState(ctx.dataDir);
  if (!isTopologyRunning(state)) {
    return {
      status: "unhealthy",
      version: VERSION,
      checks: [
        {
          name: "database",
          status: "fail",
          code: "NotRunning",
          safeMessage: "Qualigence Local is not running",
        },
      ],
    };
  }
  const client = new HealthClient(VERSION);
  const corePort = await client.checkCorePort("127.0.0.1", state.corePort);
  const readiness = await client.readiness({
    coreHost: "127.0.0.1",
    corePort: state.corePort,
    dbFile: ctx.dbFile,
    artifactDir: ctx.artifactDir,
    corePid: state.corePid,
    runnerPid: state.runnerPid,
  });
  const checks: HealthCheck[] = [corePort, ...readiness.checks];
  return { status: aggregateHealthStatus(checks), version: VERSION, checks };
}

function printReport(report: HealthReport, json: boolean, io: LauncherIo): void {
  if (json) {
    io.out(JSON.stringify(report));
    return;
  }
  io.out(`status: ${report.status}`);
  for (const check of report.checks) {
    io.out(`  [${check.status}] ${check.name}: ${check.safeMessage}`);
  }
}

async function commandStatus(ctx: LauncherContext, json: boolean, io: LauncherIo): Promise<void> {
  printReport(await statusReport(ctx), json, io);
}

async function commandDoctor(ctx: LauncherContext, json: boolean, io: LauncherIo): Promise<void> {
  const certs = certPathsFor(ctx.dataDir);
  const doctor = new LocalDoctor({
    version: VERSION,
    config: ctx.config,
    dbFile: ctx.dbFile,
    artifactDir: ctx.artifactDir,
    certPaths: { ca: certs.ca, cert: certs.coreCert, key: certs.coreKey },
  });
  printReport(await doctor.run(false), json, io);
}

async function commandBackup(ctx: LauncherContext, reason: string, io: LauncherIo): Promise<void> {
  const backups = new BackupManager({
    dataDir: ctx.dataDir,
    dbFile: ctx.dbFile,
    artifactDir: ctx.artifactDir,
    productVersion: VERSION,
    configFile: ctx.configPath,
  });
  const manifest = await backups.create(reason);
  io.out(`Backup created at ${manifest.directory}`);
  io.out(`  schema version: ${manifest.schemaVersion}`);
  io.out(`  files:          ${manifest.files.length}`);
}

function exitCodeFor(error: unknown): number {
  if (error instanceof LauncherError && error.code === "AlreadyRunning") {
    return 3;
  }
  return 1;
}

function describeError(error: unknown): string {
  if (error instanceof LauncherError || error instanceof LocalConfigError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function run(
  argv: readonly string[],
  io: LauncherIo = defaultIo,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: LauncherDependencies = {},
): Promise<void> {
  const program = new Command();
  program
    .name("qualigence-local")
    .description("Local Launcher for the Qualigence Core Daemon and Runner")
    .version(VERSION)
    .option("--data-dir <dir>", "path to the local data directory")
    .exitOverride();

  const withContext = (
    handler: (ctx: LauncherContext) => Promise<void>,
  ): (() => Promise<void>) => {
    return async () => {
      try {
        const ctx = await loadContext(program.opts().dataDir as string | undefined, env);
        await handler(ctx);
      } catch (error) {
        io.err(describeError(error));
        io.exit(exitCodeFor(error));
      }
    };
  };

  program
    .command("init")
    .description("first-time setup: data dir, certs, config and database")
    .action(async () => {
      try {
        await commandInit(program.opts().dataDir as string | undefined, env, io);
      } catch (error) {
        io.err(describeError(error));
        io.exit(exitCodeFor(error));
      }
    });

  program
    .command("start")
    .description("supervised start of Core and Runner")
    .option("--foreground", "run in the foreground and supervise until interrupted")
    .action((options: { foreground?: boolean }) =>
      withContext((ctx) => commandStart(ctx, env, io, options.foreground === true, dependencies))(),
    );

  program
    .command("stop")
    .description("graceful shutdown of the running topology")
    .action(withContext((ctx) => commandStop(ctx, io)));

  program
    .command("status")
    .description("report a layered health report")
    .option("--json", "emit the health report as JSON")
    .action((options: { json?: boolean }) =>
      withContext((ctx) => commandStatus(ctx, options.json === true, io))(),
    );

  program
    .command("doctor")
    .description("one-shot diagnostics for configuration, ports, DB, disk and certs")
    .option("--json", "emit the diagnostic report as JSON")
    .action((options: { json?: boolean }) =>
      withContext((ctx) => commandDoctor(ctx, options.json === true, io))(),
    );

  program
    .command("backup")
    .description("create a verified point-in-time backup")
    .requiredOption("--reason <text>", "why the backup is being taken")
    .action((options: { reason: string }) =>
      withContext((ctx) => commandBackup(ctx, options.reason, io))(),
    );

  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    // commander's exitOverride throws for help/version/usage; surface non-zero.
    const code = (error as { exitCode?: number }).exitCode ?? 1;
    if (code !== 0) {
      io.exit(code);
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv[2] === "__supervise") ProcessSupervisor.runDetachedChild();
  else void run(process.argv.slice(2));
}
