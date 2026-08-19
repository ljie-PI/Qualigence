import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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
    cart = await startCartFixture("normal");

    const init = await launch(dataDir, "init");
    expect(init.exitCode, init.stderr).toBe(0);
    const start = await launch(dataDir, "start");
    expect(start.exitCode, start.stderr).toBe(0);
    const matches = [...start.stdout.matchAll(/bootstrap token:\s*([A-Za-z0-9_-]{43})/g)];
    expect(matches).toHaveLength(1);
    const bootstrap = matches[0]?.[1];
    expect(bootstrap).toBeDefined();

    const session = await fetch(`http://127.0.0.1:${httpPort}/api/v1/local/session`, {
      method: "POST", headers: { authorization: `Bearer ${bootstrap}` },
    });
    expect(session.status).toBe(201);
    const { sessionToken } = await session.json() as { sessionToken: string };
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const accepted = await fetch(`http://127.0.0.1:${httpPort}/api/v1/local/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ targetUrl: cart.url, objective: "add one item to the cart" }),
    });
    expect(accepted.status).toBe(202);
    const initial = await accepted.json() as { runId: string; status: string };
    expect(initial.status).toBe("pending_runner");

    const terminal = await pollRun(initial.runId, sessionToken);
    expect(terminal.status).toBe("passed");
    expect(model.requestCount()).toBeGreaterThanOrEqual(2);

    const stop = await launch(dataDir, "stop");
    expect(stop.exitCode, stop.stderr).toBe(0);
    expect(existsSync(join(dataDir, "runtime-state.json"))).toBe(false);

    const forbidden = [bootstrap!, sessionToken, API_KEY];
    for (const file of [join(dataDir, "config.yaml"), join(dataDir, "qualigence.db"), ...((await readdir(join(dataDir, "logs"))).map((name) => join(dataDir!, "logs", name)))]) {
      const text = await readFile(file, "latin1");
      for (const value of forbidden) expect(text).not.toContain(value);
    }
  }, 180_000);
});

async function pollRun(runId: string, token: string): Promise<{ readonly status: string }> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${httpPort}/api/v1/local/runs/${runId}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as { status: string };
    if (["passed", "finding", "blocked", "error"].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local Run did not reach a terminal status.");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Expected TCP port.");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
