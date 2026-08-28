import {
  aggregateHealthStatus,
  type HealthCheck,
  type HealthReport,
} from "@qualigence/local-control";
import { LauncherError } from "./errors.js";
import { fork } from "node:child_process";
import { appendFile, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { captureProcessIdentity, terminateProcess, type ProcessIdentity } from "./child-process-unit.js";
import { claimMatchingStopRequest, clearOwnedTopologyFiles, parseStopRequest, sameTopology } from "./runtime-state.js";

/**
 * One supervised child process (Core or Runner). Concrete implementations spawn
 * and monitor a real OS process; the supervisor only coordinates ordering,
 * rollback, shutdown and status across units.
 */
export interface ProcessUnit {
  readonly name: string;
  /** Spawn and block until the process reports ready, or throw a coded error. */
  start(signal?: AbortSignal): Promise<void>;
  /** Terminate the process gracefully (SIGTERM then SIGKILL after a grace). */
  stop(): Promise<void>;
  /** Deep readiness checks (may touch the database/artifact store/disk). */
  readinessChecks(): Promise<readonly HealthCheck[]>;
  /** Cheap liveness checks that never touch the database or model. */
  livenessChecks(): Promise<readonly HealthCheck[]>;
}

/** Exclusive single-instance guard over the data directory. */
export interface DataDirLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export interface ProcessSupervisorOptions {
  readonly version: string;
  readonly units: readonly ProcessUnit[];
  readonly lock?: DataDirLock;
}


/**
 * Orchestrates the ordered start, reverse-order rollback/shutdown and health
 * aggregation of the Local Launcher's child processes. The supervisor holds a
 * single-instance lock for the lifetime of a started topology so a second
 * `start` fails fast with `AlreadyRunning` rather than double-binding ports.
 */
export class ProcessSupervisor {
  private readonly recorded: string[] = [];
  private readonly running: ProcessUnit[] = [];
  private locked = false;

  constructor(private readonly options: ProcessSupervisorOptions) {}

  /** The ordered lifecycle events observed so far (`name:event`). */
  events(): readonly string[] {
    return [...this.recorded];
  }

  async start(signal?: AbortSignal): Promise<HealthReport> {
    if (this.running.length > 0) {
      throw new LauncherError("AlreadyRunning", "the launcher topology is already running");
    }
    await this.acquireLock();
    try {
      for (const unit of this.options.units) {
        this.record(`${unit.name}:start`);
        await unit.start(signal);
        this.running.push(unit);
        this.record(`${unit.name}:ready`);
      }
    } catch (error) {
      await this.rollback().catch(() => undefined);
      await this.releaseLock();
      throw error;
    }
    return this.status();
  }

  async stop(): Promise<void> {
    try {
      await this.rollback();
    } finally {
      await this.releaseLock();
    }
  }

  async status(): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    for (const unit of this.options.units) {
      checks.push(...(await unit.readinessChecks()));
    }
    return {
      status: aggregateHealthStatus(checks),
      version: this.options.version,
      checks,
    };
  }

  async liveness(): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    for (const unit of this.options.units) {
      checks.push(...(await unit.livenessChecks()));
    }
    return {
      status: aggregateHealthStatus(checks),
      version: this.options.version,
      checks,
    };
  }

  private async rollback(): Promise<void> {
    // Stop already-started units in reverse order so dependants shut down first.
    let failure: unknown;
    const unreaped: ProcessUnit[] = [];
    while (this.running.length > 0) {
      const unit = this.running.pop() as ProcessUnit;
      this.record(`${unit.name}:stop`);
      try { await unit.stop(); } catch (error) { failure ??= error; unreaped.unshift(unit); }
    }
    this.running.push(...unreaped);
    if (failure !== undefined) throw failure;
  }

  private async acquireLock(): Promise<void> {
    if (this.options.lock === undefined) {
      return;
    }
    await this.options.lock.acquire();
    this.locked = true;
  }

  private async releaseLock(): Promise<void> {
    if (this.options.lock === undefined || !this.locked) {
      return;
    }
    await this.options.lock.release();
    this.locked = false;
  }

  private record(event: string): void {
    this.recorded.push(event);
  }

}

export function handoffDetachedSupervisor(input: {
    readonly dataDir: string;
    readonly corePid: number;
    readonly runnerPid: number;
    readonly coreHttpPort: number;
    readonly startedAt: string;
    readonly supervisorCredential: Uint8Array;
    readonly shutdown: { readonly stopRequestPollIntervalMs: number; readonly stopRequestMaximumAgeMs: number; readonly drainTimeoutMs: number };
}): Promise<number> {
    return new Promise((resolve, reject) => {
      const entry = process.argv[1]; if (entry === undefined) { reject(new LauncherError("SupervisorUnavailable", "launcher entrypoint is unavailable")); return; }
      const child = fork(entry, ["__supervise"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let settled = false;
      let timeout: NodeJS.Timeout;
      const fail = (error: LauncherError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const pid = child.pid;
        void (pid === undefined ? Promise.resolve() : terminateProcess(pid, 0)).finally(() => reject(error));
      };
      timeout = setTimeout(() => fail(new LauncherError("SupervisorUnavailable", "detached supervisor did not acknowledge handoff")), 10_000);
      child.once("message", (message) => {
        if (message !== "ready" || child.pid === undefined) return;
        if (settled) return;
        settled = true; clearTimeout(timeout); child.disconnect(); child.unref(); resolve(child.pid);
      });
      child.once("error", (error) => fail(new LauncherError("SupervisorUnavailable", "detached supervisor failed", { cause: error })));
      child.send({ ...input, supervisorCredential: Buffer.from(input.supervisorCredential).toString("base64url") });
    });
  }

export function runDetachedSupervisor(): void {
    process.once("message", (value) => {
      void (async () => {
      const input = parseDetachedInput(value);
      const lifecycleLogFile = join(input.dataDir, "logs", "lifecycle.jsonl");
      const units: ProcessUnit[] = [new PidProcessUnit("core", input.corePid, lifecycleLogFile), new PidProcessUnit("runner", input.runnerPid, lifecycleLogFile)];
      const supervisor = new ProcessSupervisor({ version: "0.1.0", units });
      await supervisor.start();
      process.send?.("ready");
      await pollDetachedStop(supervisor, input);
      process.exit(0);
      })().catch(() => process.exit(1));
    });
}

class PidProcessUnit implements ProcessUnit {
  private identity: ProcessIdentity | undefined;

  constructor(readonly name: string, private readonly processId: number, private readonly lifecycleLogFile: string) {}

  async start(): Promise<void> {
    // The detached supervisor receives only a PID handoff, so bind it to the
    // process creation identity before accepting shutdown responsibility.
    // Failure to read that identity fails closed at stop time.
    this.identity = captureProcessIdentity(this.processId);
  }

  async stop(): Promise<void> {
    const identity = this.identity;
    if (identity !== undefined) {
      await terminateProcess(
        identity.pid,
        5_000,
        true,
        async (event) => recordLifecycle(this.lifecycleLogFile, `${this.name}:${event}`, identity.pid),
        () => identity.isCurrent(),
      );
    }
    await recordLifecycle(this.lifecycleLogFile, `${this.name}:reaped`, this.processId);
  }
  async readinessChecks(): Promise<readonly HealthCheck[]> { return []; }
  async livenessChecks(): Promise<readonly HealthCheck[]> { return []; }
}

async function recordLifecycle(path: string, event: string, pid: number): Promise<void> {
  await appendFile(path, `${JSON.stringify({ event, pid, at: new Date().toISOString() })}\n`, "utf8").catch(() => undefined);
}

interface DetachedInput {
  readonly dataDir: string; readonly corePid: number; readonly runnerPid: number; readonly coreHttpPort: number;
  readonly startedAt: string; readonly supervisorCredential: string;
  readonly shutdown: { readonly stopRequestPollIntervalMs: number; readonly stopRequestMaximumAgeMs: number; readonly drainTimeoutMs: number };
}

function parseDetachedInput(value: unknown): DetachedInput {
  if (typeof value !== "object" || value === null) throw new Error("Invalid detached supervisor handoff.");
  const input = value as Partial<DetachedInput>;
  if (typeof input.dataDir !== "string" || !Number.isSafeInteger(input.corePid) || !Number.isSafeInteger(input.runnerPid) || !Number.isSafeInteger(input.coreHttpPort) || typeof input.startedAt !== "string" || typeof input.supervisorCredential !== "string" || input.shutdown === undefined) throw new Error("Invalid detached supervisor handoff.");
  return input as DetachedInput;
}

async function pollDetachedStop(supervisor: ProcessSupervisor, input: DetachedInput): Promise<void> {
  const canonical = join(input.dataDir, "local-stop-request.json");
  const claim = join(input.dataDir, `local-stop-request.${process.pid}.claim`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, input.shutdown.stopRequestPollIntervalMs));
    const matches = await claimMatchingStopRequest(input.dataDir, {
      supervisorPid: process.pid,
      corePid: input.corePid,
      runnerPid: input.runnerPid,
      startedAt: input.startedAt,
    }, Date.now(), input.shutdown.stopRequestMaximumAgeMs, process.pid);
    if (!matches) continue;
    await quiesce(input).catch(() => undefined);
    await supervisor.stop();
    await removeMatchingReplay(canonical, claim, input);
    await clearOwnedTopologyFiles(input.dataDir, { supervisorPid: process.pid, corePid: input.corePid, runnerPid: input.runnerPid, startedAt: input.startedAt });
    return;
  }
}

async function removeMatchingReplay(canonical: string, claim: string, input: DetachedInput): Promise<void> {
  try { await rename(canonical, claim); } catch { return; }
  try {
    const marker = parseStopRequest(JSON.parse(await readFile(claim, "utf8")));
    if (marker.supervisorPid !== process.pid || marker.corePid !== input.corePid || marker.runnerPid !== input.runnerPid || marker.startedAt !== input.startedAt) {
      await rename(claim, canonical).catch(() => undefined);
      return;
    }
  } catch {
    await rename(claim, canonical).catch(() => undefined);
    return;
  }
  await rm(claim, { force: true });
}

function quiesce(input: DetachedInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port: input.coreHttpPort, path: "/api/v1/local/quiesce", method: "POST", headers: { authorization: `Bearer ${input.supervisorCredential}` }, timeout: input.shutdown.drainTimeoutMs }, (response) => { response.resume(); response.statusCode === 204 ? resolve() : reject(new Error("quiesce refused")); });
    call.once("error", reject); call.once("timeout", () => { call.destroy(); reject(new Error("quiesce timed out")); }); call.end();
  });
}
