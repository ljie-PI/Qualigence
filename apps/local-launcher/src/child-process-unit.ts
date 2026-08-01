import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { HealthCheck } from "@qualigence/local-control";
import { LauncherError } from "./errors.js";

const DEFAULT_POLL_INTERVAL_MS = 50;
const REAP_TIMEOUT_MS = 3_000;

export interface RestartPolicy {
  readonly maxRestarts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface ChildProcessUnitOptions {
  readonly name: string;
  readonly unhealthyCode: "CoreUnhealthy" | "RunnerUnhealthy";
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** File the child's stdout/stderr are redirected to (also used for readiness). */
  readonly logFile: string;
  /** JSON `event` string the child prints once it is ready. */
  readonly readyEvent?: string;
  /** Additional readiness gate, e.g. a TCP port probe. */
  readonly readyProbe?: () => Promise<boolean>;
  readonly startupTimeoutMs: number;
  readonly shutdownGraceMs: number;
  /** Spawn in its own process group so the whole tree can be terminated. */
  readonly detached?: boolean;
  /** Bounded restart-backoff policy applied after the child becomes ready. */
  readonly restart?: RestartPolicy;
  readonly readinessChecksFn?: () => Promise<readonly HealthCheck[]>;
  readonly livenessChecksFn?: () => Promise<readonly HealthCheck[]>;
  readonly pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** True while the OS still has a live process for `pid`. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killPid(pid: number, signal: NodeJS.Signals, group: boolean): void {
  const targets = group ? [-pid, pid] : [pid];
  for (const target of targets) {
    try {
      process.kill(target, signal);
      return;
    } catch {
      // Try the next target, or give up if the process is already gone.
    }
  }
}

/**
 * Terminate a process by pid: SIGTERM, wait up to `graceMs`, then SIGKILL, and
 * wait for the OS to reap it. Safe to call for an already-dead pid.
 */
export async function terminateProcess(
  pid: number,
  graceMs: number,
  group = false,
): Promise<void> {
  if (!isPidAlive(pid)) {
    return;
  }
  killPid(pid, "SIGTERM", group);
  const softDeadline = Date.now() + graceMs;
  while (Date.now() < softDeadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await sleep(20);
  }
  killPid(pid, "SIGKILL", group);
  const hardDeadline = Date.now() + REAP_TIMEOUT_MS;
  while (Date.now() < hardDeadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await sleep(20);
  }
}

/**
 * One supervised child process. It spawns a real OS process, detects readiness
 * from a stdout event and/or an external probe within a deadline, terminates it
 * gracefully (SIGTERM then SIGKILL), and — when a {@link RestartPolicy} is set —
 * restarts it after an unexpected exit with bounded exponential backoff so a
 * crash-looping child never becomes a tight restart storm.
 */
export class ChildProcessUnit {
  readonly name: string;
  private child: ChildProcess | undefined;
  private currentPid: number | undefined;
  private childExited = false;
  private stopping = false;
  private supervising = false;
  private restarts = 0;
  private exhausted = false;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: ChildProcessUnitOptions) {
    this.name = options.name;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  pid(): number | undefined {
    return this.currentPid;
  }

  restartCount(): number {
    return this.restarts;
  }

  isSupervising(): boolean {
    return this.supervising;
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.stopping = false;
    this.exhausted = false;
    this.restarts = 0;
    await this.spawnOnce(signal);
    if (this.options.restart !== undefined) {
      this.supervising = true;
      // The child may have already exited during/just after readiness; if so,
      // kick the restart path now so the exit is never silently missed.
      if (this.childExited) {
        void this.handleUnexpectedExit(this.child);
      }
    }
  }

  private async spawnOnce(signal?: AbortSignal): Promise<void> {
    const fd = openSync(this.options.logFile, "a");
    let child: ChildProcess;
    try {
      child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: ["ignore", fd, fd],
        detached: this.options.detached ?? false,
      });
    } finally {
      // The child has its own dup of the log fd; release ours immediately.
      closeSync(fd);
    }
    this.child = child;
    this.currentPid = child.pid;
    this.childExited = false;

    child.once("exit", () => {
      this.childExited = true;
      void this.handleUnexpectedExit(child);
    });

    try {
      await this.waitUntilReady(() => this.childExited, signal);
    } catch (error) {
      if (this.currentPid !== undefined) {
        await terminateProcess(
          this.currentPid,
          this.options.shutdownGraceMs,
          this.options.detached ?? false,
        );
      }
      throw error;
    }
  }

  private async waitUntilReady(hasExited: () => boolean, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    for (;;) {
      if (signal?.aborted === true) {
        throw new LauncherError(this.options.unhealthyCode, `${this.name} start aborted`);
      }
      if (await this.isReady()) {
        return;
      }
      if (hasExited()) {
        throw new LauncherError(
          this.options.unhealthyCode,
          `${this.name} exited before it became ready`,
        );
      }
      if (Date.now() >= deadline) {
        throw new LauncherError(
          "StartupTimedOut",
          `${this.name} did not become ready within ${this.options.startupTimeoutMs}ms`,
        );
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async isReady(): Promise<boolean> {
    if (this.options.readyEvent !== undefined && !(await this.logHasEvent(this.options.readyEvent))) {
      return false;
    }
    if (this.options.readyProbe !== undefined && !(await this.options.readyProbe())) {
      return false;
    }
    return true;
  }

  private async logHasEvent(event: string): Promise<boolean> {
    let content: string;
    try {
      content = await readFile(this.options.logFile, "utf8");
    } catch {
      return false;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as { event?: unknown };
        if (parsed.event === event) {
          return true;
        }
      } catch {
        // Non-JSON log line; ignore.
      }
    }
    return false;
  }

  private attaching = false;

  private async handleUnexpectedExit(child: ChildProcess | undefined): Promise<void> {
    // Ignore exits for a superseded child, during shutdown, or before the
    // restart policy is engaged, and serialize concurrent restart attempts.
    if (child !== this.child || this.stopping || !this.supervising || this.attaching) {
      return;
    }
    const policy = this.options.restart;
    if (policy === undefined || this.restarts >= policy.maxRestarts) {
      this.supervising = false;
      this.exhausted = true;
      return;
    }
    this.attaching = true;
    this.restarts += 1;
    const delay = Math.min(
      policy.maxDelayMs,
      policy.baseDelayMs * 2 ** (this.restarts - 1),
    );
    await sleep(delay);
    if (this.stopping || !this.supervising) {
      this.attaching = false;
      return;
    }
    try {
      await this.spawnOnce();
      this.attaching = false;
      if (this.childExited) {
        void this.handleUnexpectedExit(this.child);
      }
    } catch {
      this.attaching = false;
      this.supervising = false;
      this.exhausted = true;
    }
  }

  /** Resolve once the restart policy has been exhausted (test/observability aid). */
  async waitUntilExhausted(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exhausted) {
        return;
      }
      await sleep(this.pollIntervalMs);
    }
    throw new LauncherError(
      this.options.unhealthyCode,
      `${this.name} did not exhaust its restart policy within ${timeoutMs}ms`,
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.supervising = false;
    const pid = this.currentPid;
    if (pid !== undefined) {
      await terminateProcess(pid, this.options.shutdownGraceMs, this.options.detached ?? false);
    }
    this.child = undefined;
    this.currentPid = undefined;
  }

  /** Detach the child so it survives the launcher process exiting. */
  detach(): void {
    this.supervising = false;
    this.child?.unref();
  }

  async readinessChecks(): Promise<readonly HealthCheck[]> {
    if (this.options.readinessChecksFn !== undefined) {
      return this.options.readinessChecksFn();
    }
    return [this.selfCheck("readiness")];
  }

  async livenessChecks(): Promise<readonly HealthCheck[]> {
    if (this.options.livenessChecksFn !== undefined) {
      return this.options.livenessChecksFn();
    }
    return [this.selfCheck("liveness")];
  }

  private selfCheck(kind: string): HealthCheck {
    const alive = this.currentPid !== undefined && isPidAlive(this.currentPid);
    return {
      name: this.name === "core" ? "database" : "runner",
      status: alive ? "pass" : "fail",
      safeMessage: `${this.name} ${kind}: process ${alive ? "alive" : "not running"}`,
    };
  }
}
