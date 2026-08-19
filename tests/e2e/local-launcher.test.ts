import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { runCli } from "../helpers/cli-process.js";
import { run } from "../../apps/local-launcher/src/main.js";
import { startMockModelServer, type MockModelHandle } from "../fixtures/openai-compatible/mock-server.js";
import { startCartFixture, type FixtureHandle } from "../fixtures/web-cart/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const launcherEntry = join(repoRoot, "apps", "local-launcher", "dist", "main.js");
const DEADLINE_MS = 120_000;
const API_KEY = "sk-local-e2e-DO-NOT-LEAK";
const USER_BOOTSTRAP = Buffer.alloc(32, 0x31);
const SUPERVISOR_CREDENTIAL = Buffer.alloc(32, 0xa7);

let dataDir: string | undefined;
let model: MockModelHandle | undefined;
let cart: FixtureHandle | undefined;
let grpcPort: number;
let httpPort: number;

beforeAll(async () => {
  if (!existsSync(launcherEntry)) throw new Error("Built Local Launcher is required.");
  [grpcPort, httpPort] = await distinctPorts();
});

afterEach(async () => {
  if (dataDir !== undefined && existsSync(join(dataDir, "runtime-state.json"))) {
    await launch(dataDir, "stop").catch(() => undefined);
  }
  await cart?.close(); await model?.close();
  if (dataDir !== undefined) await removeEventually(dataDir);
  dataDir = undefined; cart = undefined; model = undefined;
});

function launcherEnv(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    QUALIGENCE_DATA_DIR: directory,
    QUALIGENCE_CORE_PORT: String(grpcPort),
    QUALIGENCE_CORE_HTTP_PORT: String(httpPort),
    QUALIGENCE_MODEL_BASE_URL: model?.url,
    QUALIGENCE_MODEL_API_KEY: API_KEY,
    QUALIGENCE_MODEL: "qualigence-mock-model",
  };
}

async function launch(directory: string, ...args: string[]) {
  const harness = await writeLauncherHarness(directory);
  return runCli([harness, ...args], launcherEnv(directory), DEADLINE_MS);
}

async function writeLauncherHarness(directory: string): Promise<string> {
  const harness = join(directory, "launcher-test-harness.mjs");
  const launcherModule = pathToFileURL(join(repoRoot, "apps", "local-launcher", "dist", "index.js")).href;
  const localControlModule = pathToFileURL(join(repoRoot, "packages", "contracts", "local-control", "dist", "index.js")).href;
  await writeFile(harness, `import { ProcessSupervisor, run } from ${JSON.stringify(launcherModule)};
import { encodeBootstrapFrame } from ${JSON.stringify(localControlModule)};
const createBootstrapCredentials = ({ bootstrapTtlMs }) => {
  const createdAtEpochMs = Date.now();
  const userExpiresAtEpochMs = createdAtEpochMs + bootstrapTtlMs;
  const userBootstrap = Buffer.alloc(32, 0x31);
  const supervisor = Buffer.alloc(32, 0xa7);
  return { userBootstrap, supervisor, createdAtEpochMs, userExpiresAtEpochMs,
    frame: () => encodeBootstrapFrame({ userBootstrap, supervisor, createdAtEpochMs, userExpiresAtEpochMs }),
    destroy: () => { userBootstrap.fill(0); supervisor.fill(0); } };
};
if (process.argv[2] === "__supervise") ProcessSupervisor.runDetachedChild();
else await run(process.argv.slice(2), undefined, process.env, { createBootstrapCredentials });
`, "utf8");
  return harness;
}

describe("local-launcher real process loop", () => {
  it("authenticates intake, dispatches through the real Runner and Chromium, reconciles completion, and stops detached", async () => {
    dataDir = await mkdtemp(join(repoRoot, ".tmp-launcher-e2e-"));
    model = await startMockModelServer();
    cart = await startCartFixture("fault");

    const init = await launch(dataDir, "init");
    expect(init.exitCode, init.stderr).toBe(0);
    const configFile = join(dataDir, "config.yaml");
    const configured = (await readFile(configFile, "utf8"))
      .replace("userSessionTtlMs: 900000", "userSessionTtlMs: 30000")
      .replace("completionReconciliationRetryBaseMs: 1000", "completionReconciliationRetryBaseMs: 10000")
      .replace("completionReconciliationRetryMaximumMs: 60000", "completionReconciliationRetryMaximumMs: 20000")
      .replace("completionReconciliationMaximumAttempts: 8", "completionReconciliationMaximumAttempts: 5")
      .replace("completionReconciliationPollIntervalMs: 250", "completionReconciliationPollIntervalMs: 200")
      .replace("completionReconciliationBatchSize: 64", "completionReconciliationBatchSize: 7");
    await writeFile(configFile, configured);
    const start = await launch(dataDir, "start");
    expect(start.exitCode, start.stderr).toBe(0);
    const matches = [...start.stdout.matchAll(/bootstrap token:\s*([A-Za-z0-9_-]{43})/g)];
    expect(matches).toHaveLength(1);
    const bootstrap = matches[0]?.[1];
    expect(bootstrap).toBeDefined();

    const liveState = JSON.parse(await readFile(join(dataDir, "runtime-state.json"), "utf8")) as { supervisorPid: number; corePid: number; runnerPid: number };
    await writeFile(join(dataDir, "local-stop-request.json"), "not json");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isPidAlive(liveState.supervisorPid)).toBe(true);
    expect(isPidAlive(liveState.corePid)).toBe(true);
    expect(isPidAlive(liveState.runnerPid)).toBe(true);

    const session = await fetch(`http://127.0.0.1:${httpPort}/api/v1/local/session`, {
      method: "POST", headers: { authorization: `Bearer ${bootstrap}` },
    });
    expect(session.status).toBe(201);
    const sessionCreatedAt = Date.now();
    const { sessionToken, expiresAt } = await session.json() as { sessionToken: string; expiresAt: string };
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt) - sessionCreatedAt).toBeGreaterThan(29_500);
    expect(Date.parse(expiresAt) - sessionCreatedAt).toBeLessThanOrEqual(30_000);

    const accepted = await fetch(`http://127.0.0.1:${httpPort}/api/v1/local/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ targetUrl: cart.url, objective: "add one item to the cart" }),
    });
    expect(accepted.status).toBe(202);
    const initial = await accepted.json() as { runId: string; status: string };
    expect(initial.status).toBe("pending_runner");

    const terminal = await pollRun(initial.runId, sessionToken);
    expect(terminal.status).toBe("finding");
    expect(terminal.evidenceReferences?.some((reference) => reference.kind === "finding")).toBe(true);
    expect(model.requestCount()).toBeGreaterThanOrEqual(2);

    const firstStateText = await readFile(join(dataDir, "runtime-state.json"), "utf8");
    const firstState = JSON.parse(firstStateText) as { supervisorPid: number; corePid: number; runnerPid: number };
    const database = new BetterSqlite3(join(dataDir, "qualigence.db"));
    try {
      expect((database.prepare("SELECT COUNT(*) AS count FROM trace_events WHERE run_id = ?").get(initial.runId) as { count: number }).count).toBeGreaterThan(0);
      expect((database.prepare("SELECT COUNT(*) AS count FROM findings WHERE run_id = ?").get(initial.runId) as { count: number }).count).toBeGreaterThan(0);
    } finally { database.close(); }

    const stop = await launch(dataDir, "stop");
    expect(stop.exitCode, stop.stderr).toBe(0);
    expect(existsSync(join(dataDir, "runtime-state.json"))).toBe(false);
    expect(isPidAlive(firstState.runnerPid)).toBe(false);
    expect(isPidAlive(firstState.corePid)).toBe(false);
    expect(isPidAlive(firstState.supervisorPid)).toBe(false);
    await expectStopOrder(dataDir, firstState.runnerPid, firstState.corePid);

    const interrupted = new BetterSqlite3(join(dataDir, "qualigence.db"));
    try {
      interrupted.prepare("UPDATE execution_runs SET status = 'running', completed_at = NULL, error_code = NULL WHERE run_id = ?").run(initial.runId);
      interrupted.prepare("UPDATE local_run_intakes SET completion_state = 'awaiting', completion_sha256 = NULL, completion_applied_at = NULL, completion_next_attempt_at = created_at WHERE run_id = ?").run(initial.runId);
    } finally { interrupted.close(); }

    const restarted = await launch(dataDir, "start");
    expect(restarted.exitCode, restarted.stderr).toBe(0);
    const restartedBootstrap = [...restarted.stdout.matchAll(/bootstrap token:\s*([A-Za-z0-9_-]{43})/g)][0]?.[1];
    expect(restartedBootstrap).toBeDefined();
    const restartedSession = await fetch(`http://127.0.0.1:${httpPort}/api/v1/local/session`, { method: "POST", headers: { authorization: `Bearer ${restartedBootstrap}` } });
    const { sessionToken: restartedSessionToken } = await restartedSession.json() as { sessionToken: string };
    const reconciled = await pollRun(initial.runId, restartedSessionToken);
    expect(reconciled.status).toBe("finding");
    expect(reconciled.evidenceReferences).toEqual(terminal.evidenceReferences);

    const secondStateText = await readFile(join(dataDir, "runtime-state.json"), "utf8");
    const secondState = JSON.parse(secondStateText) as { supervisorPid: number; corePid: number; runnerPid: number };
    const finalStop = await launch(dataDir, "stop");
    expect(finalStop.exitCode, finalStop.stderr).toBe(0);
    expect(isPidAlive(secondState.runnerPid)).toBe(false);
    expect(isPidAlive(secondState.corePid)).toBe(false);
    expect(isPidAlive(secondState.supervisorPid)).toBe(false);
    await expectStopOrder(dataDir, secondState.runnerPid, secondState.corePid);

    const pendingAuthority = new BetterSqlite3(join(dataDir, "qualigence.db"));
    try {
      pendingAuthority.prepare("DELETE FROM execution_completions WHERE run_id = ?").run(initial.runId);
      pendingAuthority.prepare("UPDATE execution_runs SET status = 'running', completed_at = NULL, error_code = NULL WHERE run_id = ?").run(initial.runId);
      pendingAuthority.prepare("UPDATE local_run_intakes SET completion_state = 'awaiting', completion_attempt = 0, completion_last_attempt_at = NULL, completion_next_attempt_at = created_at, completion_error_code = NULL, completion_sha256 = NULL, completion_applied_at = NULL, completion_blocked_at = NULL WHERE run_id = ?").run(initial.runId);
    } finally { pendingAuthority.close(); }
    const policyStart = await launch(dataDir, "start");
    expect(policyStart.exitCode, policyStart.stderr).toBe(0);
    const policyStateText = await readFile(join(dataDir, "runtime-state.json"), "utf8");
    const policyBootstrap = [...policyStart.stdout.matchAll(/bootstrap token:\s*([A-Za-z0-9_-]{43})/g)][0]?.[1];
    const policySessionResponse = await fetch(`http://127.0.0.1:${httpPort}/api/v1/local/session`, { method: "POST", headers: { authorization: `Bearer ${policyBootstrap}` } });
    const { sessionToken: policySessionToken } = await policySessionResponse.json() as { sessionToken: string };
    const policyDatabase = new BetterSqlite3(join(dataDir, "qualigence.db"), { readonly: true });
    try {
      const retry = policyDatabase.prepare("SELECT completion_attempt AS attempt, completion_last_attempt_at AS attemptedAt, completion_next_attempt_at AS nextAttemptAt FROM local_run_intakes WHERE run_id = ?").get(initial.runId) as { attempt: number; attemptedAt: string; nextAttemptAt: string };
      expect(retry.attempt).toBe(1);
      expect(Date.parse(retry.nextAttemptAt) - Date.parse(retry.attemptedAt)).toBe(10_000);
    } finally { policyDatabase.close(); }
    const blockedDatabase = new BetterSqlite3(join(dataDir, "qualigence.db"));
    try {
      blockedDatabase.prepare("UPDATE local_run_intakes SET completion_state = 'integrity_blocked', completion_error_code = 'CompletionIdentityMismatch', completion_blocked_at = ? WHERE run_id = ?").run(new Date().toISOString(), initial.runId);
    } finally { blockedDatabase.close(); }
    expect(await pollRun(initial.runId, policySessionToken)).toMatchObject({ status: "error", errorCode: "CompletionIdentityMismatch" });
    expect((await launch(dataDir, "stop")).exitCode).toBe(0);

    const forbidden = [USER_BOOTSTRAP.toString("base64url"), SUPERVISOR_CREDENTIAL.toString("base64url"), bootstrap!, sessionToken, restartedBootstrap!, restartedSessionToken, policyBootstrap!, policySessionToken];
    for (const file of [join(dataDir, "config.yaml"), join(dataDir, "qualigence.db"), ...((await readdir(join(dataDir, "logs"))).map((name) => join(dataDir!, "logs", name)))]) {
      const bytes = await readFile(file);
      assertNoCredentialRepresentations(bytes, forbidden);
      expect(bytes.includes(Buffer.from(API_KEY))).toBe(false);
    }
    for (const stateText of [firstStateText, secondStateText, policyStateText]) {
      expect(Object.keys(JSON.parse(stateText) as object).sort()).toEqual(["corePid", "corePort", "dataDir", "runnerPid", "startedAt", "supervisorPid"]);
      assertNoCredentialRepresentations(Buffer.from(stateText), forbidden);
      expect(stateText).not.toContain(API_KEY);
    }
  }, 180_000);

  it.each(["handoff", "runtime-state", "token-print"] as const)("rolls back all started processes when %s publication fails", async (failure) => {
    dataDir = await mkdtemp(join(repoRoot, `.tmp-launcher-${failure}-`));
    model = await startMockModelServer();
    expect((await launch(dataDir, "init")).exitCode).toBe(0);
    const originalEntry = process.argv[1] ?? launcherEntry;
    const exits: number[] = [];
    try {
      process.argv[1] = failure === "handoff" ? join(dataDir, "missing-launcher.js") : launcherEntry;
      if (failure === "runtime-state") await mkdir(join(dataDir, "runtime-state.json"));
      await run(["start"], {
        out: (line) => { if (failure === "token-print" && line.includes("bootstrap token:")) throw new Error("injected token print failure"); },
        err: () => undefined,
        exit: (code) => exits.push(code),
      }, launcherEnv(dataDir));
    } finally { process.argv[1] = originalEntry; }
    expect(exits).toEqual([1]);
    if (failure === "runtime-state") await expect((await import("../../apps/local-launcher/src/runtime-state.js")).readRuntimeState(dataDir)).resolves.toBeUndefined();
    else expect(existsSync(join(dataDir, "runtime-state.json"))).toBe(false);
    const events = await lifecycleEvents(dataDir);
    const started = events.filter((event) => event.event.endsWith(":started"));
    expect(started.map((event) => event.event)).toEqual(["core:started", "runner:started"]);
    for (const event of started) expect(isPidAlive(event.pid)).toBe(false);
    expect(events.map((event) => event.event).slice(-4)).toEqual(["runner:stop_requested", "runner:reaped", "core:stop_requested", "core:reaped"]);
  }, 60_000);

  it("quiesces authentically and reaps Runner before Core in foreground mode", async () => {
    const signals: readonly (NodeJS.Signals | "STOP_COMMAND")[] = process.platform === "win32"
      ? ["STOP_COMMAND"]
      : ["SIGINT", "SIGTERM"];
    for (const signal of signals) {
      dataDir = await mkdtemp(join(repoRoot, `.tmp-launcher-foreground-${signal.toLowerCase()}-`));
      const state = await runHostSignalProof(dataDir, signal);
      expect(existsSync(join(dataDir, "runtime-state.json"))).toBe(false);
      await expectStopOrder(dataDir, state.runnerPid, state.corePid, true);
      await removeEventually(dataDir);
      dataDir = undefined;
    }
  }, 600_000);
});

async function runHostSignalProof(directory: string, signal: NodeJS.Signals | "STOP_COMMAND"): Promise<{ readonly corePid: number; readonly runnerPid: number }> {
  [grpcPort, httpPort] = await distinctPorts();
  expect((await runCli([launcherEntry, "--data-dir", directory, "init"], launcherEnv(directory), DEADLINE_MS)).exitCode).toBe(0);
  const stdoutPath = join(directory, "foreground.stdout.log");
  const stderrPath = join(directory, "foreground.stderr.log");
  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  const child = spawn(process.execPath, [launcherEntry, "--data-dir", directory, "start", "--foreground"], { env: launcherEnv(directory), stdio: ["ignore", stdoutFd, stderrFd] });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  await expect.poll(async () => readFile(stdoutPath, "utf8"), { timeout: 30_000, interval: 100, message: await readFile(stderrPath, "utf8").catch(() => "") }).toContain("bootstrap token:");
  const state = JSON.parse(await readFile(join(directory, "runtime-state.json"), "utf8")) as { corePid: number; runnerPid: number };
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, closedBy) => resolve({ code, signal: closedBy })); });
  if (signal === "STOP_COMMAND") {
    const stopped = await runCli([launcherEntry, "--data-dir", directory, "stop"], launcherEnv(directory), DEADLINE_MS);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
  } else {
    process.kill(child.pid as number, signal);
  }
  const exit = await exited;
  child.removeAllListeners();
  child.unref();
  const stdout = await readFile(stdoutPath, "utf8");
  const stderr = await readFile(stderrPath, "utf8");
  expect(exit, `stdout:\n${stdout}\nstderr:\n${stderr}`).toEqual({ code: 0, signal: null });
  expect(isPidAlive(state.runnerPid)).toBe(false); expect(isPidAlive(state.corePid)).toBe(false);
  return state;
}

interface LifecycleEvent { readonly event: string; readonly pid: number; readonly at: string }

async function lifecycleEvents(directory: string): Promise<readonly LifecycleEvent[]> {
  const text = await readFile(join(directory, "logs", "lifecycle.jsonl"), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as LifecycleEvent);
}

async function expectStopOrder(directory: string, runnerPid: number, corePid: number, requireQuiesce = false): Promise<void> {
  const events = await lifecycleEvents(directory);
  const runnerStop = events.findIndex((event) => event.event === "runner:stop_requested" && event.pid === runnerPid);
  const runnerReaped = events.findIndex((event) => event.event === "runner:reaped" && event.pid === runnerPid);
  const coreStop = events.findIndex((event) => event.event === "core:stop_requested" && event.pid === corePid);
  const coreReaped = events.findIndex((event) => event.event === "core:reaped" && event.pid === corePid);
  expect(runnerStop).toBeGreaterThanOrEqual(0); expect(runnerReaped).toBeGreaterThan(runnerStop);
  expect(coreStop).toBeGreaterThan(runnerReaped); expect(coreReaped).toBeGreaterThan(coreStop);
  if (requireQuiesce) {
    let quiesced = -1;
    for (let index = 0; index < runnerStop; index += 1) if (events[index]?.event === "core:quiesced") quiesced = index;
    expect(quiesced).toBeGreaterThanOrEqual(0); expect(quiesced).toBeLessThan(runnerStop);
  }
}

function assertNoCredentialRepresentations(content: Buffer, encodedTokens: readonly string[]): void {
  for (const encoded of encodedTokens) {
    const raw = Buffer.from(encoded, "base64url");
    expect(raw).toHaveLength(32);
    for (const representation of [raw, Buffer.from(raw.toString("hex")), Buffer.from(raw.toString("hex").toUpperCase()), Buffer.from(raw.toString("base64")), Buffer.from(raw.toString("base64url")), Buffer.from(`${raw.toString("base64url")}=`)]) {
      expect(content.indexOf(representation)).toBe(-1);
    }
  }
}

async function pollRun(runId: string, token: string): Promise<{ readonly status: string; readonly errorCode?: string; readonly evidenceReferences?: readonly { readonly id: string; readonly kind: string; readonly createdAt: string }[] }> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${httpPort}/api/v1/local/runs/${runId}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as { status: string; errorCode?: string; evidenceReferences?: readonly { id: string; kind: string; createdAt: string }[] };
    if (["passed", "finding", "blocked", "error"].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local Run did not reach a terminal status.");
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Expected TCP port.");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}

async function distinctPorts(): Promise<readonly [number, number]> {
  const first = await freePort();
  for (;;) {
    const second = await freePort();
    if (second !== first) return [first, second];
  }
}

async function removeEventually(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
