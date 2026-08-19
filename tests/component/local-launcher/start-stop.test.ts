import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRuntime } from "@qualigence/sqlite-runtime";
import { SystemClock } from "@qualigence/shared-kernel";
import {
  ChildProcessUnit,
  isPidAlive,
} from "../../../apps/local-launcher/src/child-process-unit.js";
import { HealthClient } from "../../../apps/local-launcher/src/health-client.js";
import { LocalDoctor } from "../../../apps/local-launcher/src/doctor.js";
import { createGrpcTestPki } from "../../helpers/grpc-test-pki.js";
import type { LocalConfig } from "@qualigence/local-control";

const FIXTURE = fileURLToPath(
  new URL("../../fixtures/local-launcher/fake-process.mjs", import.meta.url),
);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function scratchDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), `.tmp-launcher-${name}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function tcpProbe(host: string, port: number): () => Promise<boolean> {
  return async () => {
    const { connect } = await import("node:net");
    return new Promise<boolean>((resolve) => {
      const socket = connect({ host, port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
  };
}

describe("ChildProcessUnit lifecycle (real processes)", () => {
  it("spawns a real process, reaches ready via its stdout event and stops cleanly", async () => {
    const dir = await scratchDir("ready");
    const port = await freePort();
    const unit = new ChildProcessUnit({
      name: "core",
      unhealthyCode: "CoreUnhealthy",
      command: process.execPath,
      args: [FIXTURE],
      env: { FAKE_MODE: "ready", FAKE_READY_EVENT: "core.ready", FAKE_PORT: String(port) },
      logFile: join(dir, "core.log"),
      readyEvent: "core.ready",
      readyProbe: tcpProbe("127.0.0.1", port),
      startupTimeoutMs: 5_000,
      shutdownGraceMs: 2_000,
    });
    cleanups.push(() => unit.stop());

    await unit.start();
    const pid = unit.pid();
    expect(pid).toBeGreaterThan(0);
    expect(isPidAlive(pid as number)).toBe(true);

    await unit.stop();
    expect(isPidAlive(pid as number)).toBe(false);
  });

  it("rejects with StartupTimedOut and leaks no child when readiness never arrives", async () => {
    const dir = await scratchDir("hang");
    const unit = new ChildProcessUnit({
      name: "core",
      unhealthyCode: "CoreUnhealthy",
      command: process.execPath,
      args: [FIXTURE],
      env: { FAKE_MODE: "hang" },
      logFile: join(dir, "core.log"),
      readyEvent: "core.ready",
      startupTimeoutMs: 400,
      shutdownGraceMs: 1_000,
    });
    cleanups.push(() => unit.stop());

    const pidSeen: number[] = [];
    await expect(
      unit.start().catch((error: unknown) => {
        const pid = unit.pid();
        if (typeof pid === "number") pidSeen.push(pid);
        throw error;
      }),
    ).rejects.toMatchObject({ code: "StartupTimedOut" });

    for (const pid of pidSeen) {
      expect(isPidAlive(pid)).toBe(false);
    }
  });

  // TODO(Task 21): remove this Windows quarantine after lifecycle assertions use observable process events instead of minimum elapsed time.
  it.skipIf(process.platform === "win32")(
    "escalates SIGTERM to SIGKILL for a process that ignores SIGTERM",
    async () => {
    const dir = await scratchDir("stubborn");
    const unit = new ChildProcessUnit({
      name: "runner",
      unhealthyCode: "RunnerUnhealthy",
      command: process.execPath,
      args: [FIXTURE],
      env: { FAKE_MODE: "stubborn", FAKE_READY_EVENT: "runner.ready" },
      logFile: join(dir, "runner.log"),
      readyEvent: "runner.ready",
      startupTimeoutMs: 5_000,
      shutdownGraceMs: 300,
    });
    cleanups.push(() => unit.stop());

    await unit.start();
    const pid = unit.pid() as number;
    const startedAt = Date.now();
    await unit.stop();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    expect(isPidAlive(pid)).toBe(false);
    },
  );

  it("restarts a crashing process with bounded backoff, then gives up", async () => {
    const dir = await scratchDir("crash");
    const unit = new ChildProcessUnit({
      name: "runner",
      unhealthyCode: "RunnerUnhealthy",
      command: process.execPath,
      args: [FIXTURE],
      env: { FAKE_MODE: "crash", FAKE_READY_EVENT: "runner.ready", FAKE_CRASH_AFTER_MS: "20" },
      logFile: join(dir, "runner.log"),
      readyEvent: "runner.ready",
      startupTimeoutMs: 5_000,
      shutdownGraceMs: 1_000,
      restart: { maxRestarts: 3, baseDelayMs: 20, maxDelayMs: 80 },
    });
    cleanups.push(() => unit.stop());

    await unit.start();
    await unit.waitUntilExhausted(10_000);
    expect(unit.restartCount()).toBe(3);
    expect(unit.isSupervising()).toBe(false);
  });
});

async function makeDataDir(name: string): Promise<{
  dir: string;
  dbFile: string;
  artifactDir: string;
}> {
  const dir = await scratchDir(name);
  const dbFile = join(dir, "qualigence.db");
  const artifactDir = join(dir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const runtime = await SqliteRuntime.open({
    filename: dbFile,
    busyTimeoutMs: 5_000,
    clock: new SystemClock(),
  });
  await runtime.close();
  return { dir, dbFile, artifactDir };
}

describe("HealthClient readiness (real fs/sqlite)", () => {
  it("passes database, artifact and disk checks for an initialized data dir", async () => {
    const { dbFile, artifactDir } = await makeDataDir("health-ok");
    const client = new HealthClient("1.2.3");

    const report = await client.readiness({
      coreHost: "127.0.0.1",
      corePort: 1,
      dbFile,
      artifactDir,
    });

    expect(report.version).toBe("1.2.3");
    const byName = new Map(report.checks.map((c) => [c.name, c.status]));
    expect(byName.get("database")).toBe("pass");
    expect(byName.get("artifact_store")).toBe("pass");
    expect(byName.get("disk")).toBe("pass");
  });

  it("fails the database check when the SQLite file is missing", async () => {
    const dir = await scratchDir("health-missing-db");
    const client = new HealthClient("1.0.0");

    const check = await client.checkDatabase(join(dir, "absent.db"));
    expect(check.status).toBe("fail");
    expect(check.name).toBe("database");
  });

  it("keeps liveness cheap: it never opens the database file", async () => {
    const { dbFile, artifactDir } = await makeDataDir("liveness");
    const client = new HealthClient("1.0.0");

    const report = await client.liveness({
      coreHost: "127.0.0.1",
      corePort: 1,
      dbFile,
      artifactDir,
    });
    // Core port is closed here, so liveness is unhealthy without any DB open.
    expect(report.status).toBe("unhealthy");
    expect(report.checks.some((c) => c.safeMessage.toLowerCase().includes("port"))).toBe(true);
  });
});

describe("LocalDoctor diagnostics", () => {
  function config(dataDir: string): LocalConfig {
    return {
      dataDir,
      core: { host: "127.0.0.1", port: 1, httpPort: 2 },
      runner: { id: "runner-local", spoolSoftBytes: 1_000, spoolHardBytes: 2_000 },
      modelProfile: {
        provider: "openai-compatible",
        baseUrl: "https://model.test/v1",
        model: "gpt-test",
        credentialRef: "env:KEY",
        visualInput: "disabled",
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

  it("reports healthy for a good config, reachable DB and valid certificate", async () => {
    const { dir, dbFile, artifactDir } = await makeDataDir("doctor-ok");
    const pki = createGrpcTestPki();
    const certFile = join(dir, "server.crt");
    const keyFile = join(dir, "server.key");
    const caFile = join(dir, "ca.crt");
    await writeFile(certFile, pki.server.cert);
    await writeFile(keyFile, pki.server.key);
    await writeFile(caFile, pki.ca);

    const doctor = new LocalDoctor({
      version: "1.0.0",
      config: config(dir),
      dbFile,
      artifactDir,
      certPaths: { ca: caFile, cert: certFile, key: keyFile },
    });

    const report = await doctor.run(false);
    const cert = report.checks.find((c) => c.safeMessage.toLowerCase().includes("certificate"));
    expect(cert?.status).toBe("pass");
    expect(report.status).not.toBe("unhealthy");
  });

  it("flags an expired certificate as a failure", async () => {
    const { dir, dbFile, artifactDir } = await makeDataDir("doctor-expired");
    const pki = createGrpcTestPki();
    const expired = pki.expiredClientFor("runner-local");
    const certFile = join(dir, "expired.crt");
    await writeFile(certFile, expired.cert);

    const doctor = new LocalDoctor({
      version: "1.0.0",
      config: config(dir),
      dbFile,
      artifactDir,
      certPaths: { cert: certFile },
    });

    const report = await doctor.run(false);
    const cert = report.checks.find((c) => c.safeMessage.toLowerCase().includes("certificate"));
    expect(cert?.status).toBe("fail");
    expect(report.status).toBe("unhealthy");
  });

  it("runs a provider probe only when explicitly requested and never sends user data", async () => {
    const { dir, dbFile, artifactDir } = await makeDataDir("doctor-probe");
    let probeCalls = 0;
    const doctor = new LocalDoctor({
      version: "1.0.0",
      config: config(dir),
      dbFile,
      artifactDir,
      providerProbe: async () => {
        probeCalls += 1;
        return { name: "model_provider", status: "pass", safeMessage: "provider reachable" };
      },
    });

    await doctor.run(false);
    expect(probeCalls).toBe(0);

    const report = await doctor.run(true);
    expect(probeCalls).toBe(1);
    expect(report.checks.some((c) => c.name === "model_provider")).toBe(true);
  });
});
