import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { runCli } from "../helpers/cli-process.js";
import { startMockModelServer, type MockModelHandle } from "../fixtures/openai-compatible/mock-server.js";
import { startCartFixture, type FixtureHandle } from "../fixtures/web-cart/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const launcherEntry = join(repoRoot, "apps", "local-launcher", "dist", "main.js");
const DEADLINE_MS = 120_000;
const API_KEY = "sk-local-e2e-DO-NOT-LEAK";

let dataDir: string | undefined;
let model: MockModelHandle | undefined;
let cart: FixtureHandle | undefined;
let grpcPort: number;
let httpPort: number;

beforeAll(async () => {
  if (!existsSync(launcherEntry)) throw new Error("Built Local Launcher is required.");
  grpcPort = await freePort();
  httpPort = await freePort();
});

afterEach(async () => {
  if (dataDir !== undefined && existsSync(join(dataDir, "runtime-state.json"))) {
    await launch(dataDir, "stop").catch(() => undefined);
  }
  await cart?.close(); await model?.close();
  if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
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

function launch(directory: string, ...args: string[]) {
  return runCli([launcherEntry, ...args], launcherEnv(directory), DEADLINE_MS);
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

    const pendingAuthority = new BetterSqlite3(join(dataDir, "qualigence.db"));
    try {
      pendingAuthority.prepare("DELETE FROM execution_completions WHERE run_id = ?").run(initial.runId);
      pendingAuthority.prepare("UPDATE execution_runs SET status = 'running', completed_at = NULL, error_code = NULL WHERE run_id = ?").run(initial.runId);
      pendingAuthority.prepare("UPDATE local_run_intakes SET completion_state = 'awaiting', completion_attempt = 0, completion_last_attempt_at = NULL, completion_next_attempt_at = created_at, completion_error_code = NULL, completion_sha256 = NULL, completion_applied_at = NULL, completion_blocked_at = NULL WHERE run_id = ?").run(initial.runId);
    } finally { pendingAuthority.close(); }
    const policyStart = await launch(dataDir, "start");
    expect(policyStart.exitCode, policyStart.stderr).toBe(0);
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

    const forbidden = [bootstrap!, sessionToken, restartedBootstrap!, restartedSessionToken, policyBootstrap!, policySessionToken, API_KEY];
    for (const file of [join(dataDir, "config.yaml"), join(dataDir, "qualigence.db"), ...((await readdir(join(dataDir, "logs"))).map((name) => join(dataDir!, "logs", name)))]) {
      const text = await readFile(file, "latin1");
      for (const value of forbidden) expect(text).not.toContain(value);
    }
    for (const stateText of [firstStateText, secondStateText]) {
      expect(Object.keys(JSON.parse(stateText) as object).sort()).toEqual(["corePid", "corePort", "dataDir", "runnerPid", "startedAt", "supervisorPid"]);
      for (const value of forbidden) expect(stateText).not.toContain(value);
    }
  }, 180_000);
});

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
