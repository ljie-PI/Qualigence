import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import type { HealthCheck } from "@qualigence/local-control";
import { LauncherError } from "./errors.js";

const DEFAULT_POLL_INTERVAL_MS = 50;
export const REAP_TIMEOUT_MS = 3_000;

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
  readonly fd3Frame?: Buffer;
  readonly lifecycleLogFile?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Like {@link sleep} but keeps the event loop alive. Used where an awaited
 * operation must run to completion in a short-lived CLI process (e.g. process
 * termination), rather than background polling that must never keep tests or
 * the launcher alive on its own.
 */
function sleepKeepAlive(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

/**
 * A creation-bound process identity. It deliberately probes one known PID;
 * it never searches by process name or scans the process table.
 */
export interface ProcessIdentity {
  readonly pid: number;
  isCurrent(): boolean;
}

/**
 * Capture the OS creation identity for a process which the caller already
 * owns. An unsupported or unreadable platform fails closed: callers must not
 * signal a PID that they cannot still bind to the original process.
 */
export function captureProcessIdentity(pid: number): ProcessIdentity | undefined {
  const marker = processCreationMarker(pid);
  if (marker === undefined) return undefined;
  return { pid, isCurrent: () => processCreationMarker(pid) === marker };
}

function processCreationMarker(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      // Field 22 (index 19 after the state field) is the process start time in
      // clock ticks. Split after the command's final ')' because comm may hold
      // spaces or parentheses.
      const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
      const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const startTime = afterCommand[19];
      return startTime === undefined ? undefined : `linux:${startTime}`;
    }
    if (process.platform === "win32") {
      const output = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
      ], { encoding: "utf8", windowsHide: true }).trim();
      return /^\d+$/.test(output) ? `win32:${output}` : undefined;
    }
  } catch {
    // The process exited or its identity could not be read.
  }
  return undefined;
}

function killPid(pid: number, signal: NodeJS.Signals, group: boolean): void {
  const targets = group && process.platform !== "win32" ? [-pid, pid] : [pid];
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
export type ProcessTerminationEvent =
  | "graceful_stop_requested"
  | "grace_expired"
  | "force_stop_requested";

/**
 * Terminate a process by a graceful request, wait up to `graceMs`, then force
 * termination and wait for the OS to reap it. The optional observer records
 * semantic lifecycle boundaries rather than requiring callers to infer them
 * from elapsed wall-clock time. Safe to call for an already-dead pid.
 */
export async function terminateProcess(
  pid: number,
  graceMs: number,
  group = false,
  onEvent?: (event: ProcessTerminationEvent) => Promise<void>,
  isOwned?: () => boolean,
): Promise<void> {
  const ownedAndAlive = (): boolean => (isOwned?.() ?? true) && isPidAlive(pid);
  if (!ownedAndAlive()) {
    return;
  }
  await onEvent?.("graceful_stop_requested");
  if (!ownedAndAlive()) {
    return;
  }
  if (process.platform === "win32") {
    await taskkill(pid, false);
    const softDeadline = Date.now() + graceMs;
    while (Date.now() < softDeadline) {
      if (!isPidAlive(pid)) return;
      await sleepKeepAlive(20);
    }
    if (!ownedAndAlive()) return;
    await onEvent?.("grace_expired");
    if (!ownedAndAlive()) return;
    await onEvent?.("force_stop_requested");
    if (!ownedAndAlive()) return;
    await taskkill(pid, true);
    const hardDeadline = Date.now() + REAP_TIMEOUT_MS;
    while (Date.now() < hardDeadline) {
      if (!isPidAlive(pid)) return;
      await sleepKeepAlive(20);
    }
    throw new LauncherError("ProcessReapTimedOut", `process ${String(pid)} remained alive after forced termination`);
  }
  killPid(pid, "SIGTERM", group);
  const softDeadline = Date.now() + graceMs;
  while (Date.now() < softDeadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await sleepKeepAlive(20);
  }
  if (!ownedAndAlive()) return;
  await onEvent?.("grace_expired");
  if (!ownedAndAlive()) return;
  await onEvent?.("force_stop_requested");
  if (!ownedAndAlive()) return;
  killPid(pid, "SIGKILL", group);
  const hardDeadline = Date.now() + REAP_TIMEOUT_MS;
  while (Date.now() < hardDeadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await sleepKeepAlive(20);
  }
  throw new LauncherError("ProcessReapTimedOut", `process ${pid} remained alive after forced termination`);
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
  private readyLogOffset = 0;

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
    signal?.throwIfAborted();
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
    this.readyLogOffset = await readFile(this.options.logFile).then((content) => content.byteLength, () => 0);
    const fd = openSync(this.options.logFile, "a");
    let child: ChildProcess;
    try {
      child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: this.options.fd3Frame === undefined ? ["ignore", fd, fd] : ["ignore", fd, fd, "pipe"],
        detached: this.options.detached ?? false,
      });
    } finally {
      // The child has its own dup of the log fd; release ours immediately.
      closeSync(fd);
    }
    this.child = child;
    this.currentPid = child.pid;
    if (child.pid !== undefined) await this.recordLifecycle("started", child.pid);
    this.childExited = false;
    const fd3 = child.stdio[3];
    if (this.options.fd3Frame !== undefined && fd3 !== undefined && fd3 !== null && "end" in fd3) {
      const frame = this.options.fd3Frame;
      fd3.end(frame, () => frame.fill(0));
    }

    child.once("exit", () => {
      if (child === this.child) {
        this.childExited = true;
      }
      void this.handleUnexpectedExit(child);
    });

    try {
      await this.waitUntilReady(() => this.childExited, signal);
    } catch (error) {
      await this.terminateChild(child);
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
    for (const line of content.slice(this.readyLogOffset).split("\n")) {
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
    const child = this.child;
    const pid = this.currentPid;
    if (child !== undefined && pid !== undefined) {
      await this.terminateChild(child, async (event) => this.recordLifecycle(event, pid));
      await this.recordLifecycle("reaped", pid);
    }
    this.child = undefined;
    this.currentPid = undefined;
  }

  private async terminateChild(
    child: ChildProcess,
    onEvent?: (event: ProcessTerminationEvent) => Promise<void>,
  ): Promise<void> {
    const pid = child.pid;
    if (pid === undefined) return;
    await terminateProcess(
      pid,
      this.options.shutdownGraceMs,
      this.options.detached ?? false,
      onEvent,
      () => this.child === child && child.pid === pid && child.exitCode === null && !this.childExited,
    );
  }

  private async recordLifecycle(event: "started" | ProcessTerminationEvent | "reaped", pid: number): Promise<void> {
    if (this.options.lifecycleLogFile === undefined) return;
    await appendFile(this.options.lifecycleLogFile, `${JSON.stringify({ event: `${this.name}:${event}`, pid, at: new Date().toISOString() })}\n`, "utf8").catch(() => undefined);
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

function taskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const child = spawn("taskkill.exe", args, { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}
