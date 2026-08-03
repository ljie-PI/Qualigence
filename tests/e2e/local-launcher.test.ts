import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli-process.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const launcherEntry = join(repoRoot, "apps", "local-launcher", "dist", "main.js");
const fakeProcess = join(repoRoot, "tests", "fixtures", "local-launcher", "fake-process.mjs");

const DEADLINE_MS = 20_000;
const CORE_PORT = 50_741;
const trackedPids: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Environment that redirects the real Core/Runner to the fake fixture. */
function launcherEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    QUALIGENCE_DATA_DIR: dataDir,
    QUALIGENCE_CORE_PORT: String(CORE_PORT),
    QUALIGENCE_MODEL_API_KEY: "super-secret-api-key-value",
    QUALIGENCE_CORE_COMMAND: process.execPath,
    QUALIGENCE_CORE_ARGS: JSON.stringify([fakeProcess]),
    QUALIGENCE_RUNNER_COMMAND: process.execPath,
    QUALIGENCE_RUNNER_ARGS: JSON.stringify([fakeProcess]),
    QUALIGENCE_CORE_EXTRA_ENV: JSON.stringify({
      FAKE_MODE: "ready",
      FAKE_READY_EVENT: "core-daemon.ready",
      FAKE_PORT: String(CORE_PORT),
    }),
    QUALIGENCE_RUNNER_EXTRA_ENV: JSON.stringify({
      FAKE_MODE: "ready",
      FAKE_READY_EVENT: "runner.ready",
    }),
  };
}

function launch(dataDir: string, ...args: string[]) {
  return runCli([launcherEntry, ...args], launcherEnv(dataDir), DEADLINE_MS, {
    onStdout: (chunk) => {
      for (const match of chunk.matchAll(/"pid":\s*(\d+)/g)) {
        const pid = Number.parseInt(match[1] ?? "", 10);
        if (Number.isFinite(pid)) trackedPids.push(pid);
      }
    },
  });
}

let dataDir: string;

beforeAll(() => {
  if (!existsSync(launcherEntry)) {
    execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit" });
  }
});

afterEach(async () => {
  if (dataDir === undefined) return;
  const stateFile = join(dataDir, "runtime-state.json");
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as {
        corePid?: number;
        runnerPid?: number;
      };
      for (const pid of [state.runnerPid, state.corePid]) {
        if (pid !== undefined && isAlive(pid)) process.kill(pid, "SIGKILL");
      }
    } catch {
      // best effort cleanup
    }
  }
});

afterAll(async () => {
  for (const pid of trackedPids) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

describe("local-launcher end-to-end", () => {
  it("initializes, starts, reports health, refuses double start, backs up, and stops", async () => {
    dataDir = await mkdtemp(join(repoRoot, ".tmp-launcher-e2e-"));

    // init — first-time setup creates the data dir, certs, config and database.
    const init = await launch(dataDir, "init");
    expect(init.exitCode).toBe(0);
    expect(existsSync(join(dataDir, "config.yaml"))).toBe(true);
    expect(existsSync(join(dataDir, "qualigence.db"))).toBe(true);
    expect(existsSync(join(dataDir, "certs", "ca.crt"))).toBe(true);

    // start — supervised launch of the (faked) Core and Runner.
    const start = await launch(dataDir, "start");
    expect(start.exitCode).toBe(0);
    // The bootstrap token is printed exactly once.
    const tokenMatches = start.stdout.match(/bootstrap token:/gi) ?? [];
    expect(tokenMatches).toHaveLength(1);
    expect(existsSync(join(dataDir, "runtime-state.json"))).toBe(true);

    // status — the running topology reports healthy.
    const status = await launch(dataDir, "status", "--json");
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).status).toBe("healthy");

    // start again — refused with a stable AlreadyRunning code and exit 3.
    const second = await launch(dataDir, "start");
    expect(second.exitCode).toBe(3);
    expect(second.stderr).toContain("AlreadyRunning");

    // doctor — one-shot diagnostics succeed and leak no secret.
    const doctor = await launch(dataDir, "doctor", "--json");
    expect(doctor.exitCode).toBe(0);
    expect(doctor.stdout).not.toContain("super-secret-api-key-value");

    // backup — creates a verifiable backup directory.
    const backup = await launch(dataDir, "backup", "--reason", "e2e checkpoint");
    expect(backup.exitCode).toBe(0);
    const backupDirs = await readdir(join(dataDir, "backups"));
    expect(backupDirs.length).toBeGreaterThan(0);

    // No secret ever reaches logs, config or backup manifests.
    const configText = await readFile(join(dataDir, "config.yaml"), "utf8");
    expect(configText).not.toContain("super-secret-api-key-value");
    for (const log of await readdir(join(dataDir, "logs"))) {
      const text = await readFile(join(dataDir, "logs", log), "utf8");
      expect(text).not.toContain("super-secret-api-key-value");
    }

    // stop — graceful shutdown removes runtime state and reaps the children.
    const stop = await launch(dataDir, "stop");
    expect(stop.exitCode).toBe(0);
    expect(existsSync(join(dataDir, "runtime-state.json"))).toBe(false);

    // status after stop — no longer healthy.
    const stopped = await launch(dataDir, "status", "--json");
    expect(JSON.parse(stopped.stdout).status).not.toBe("healthy");
  }, 90_000);
});
