import { spawn } from "node:child_process";

export interface CliProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface RunCliOptions {
  /** Invoked with each stdout chunk, e.g. to capture a child's own PIDs. */
  readonly onStdout?: (chunk: string) => void;
}

/**
 * Raised when a spawned CLI exceeds its deadline. The stable {@link code} lets a
 * test distinguish a hang from a normal non-zero exit, and the captured output
 * is preserved for diagnostics.
 */
export class CliProcessTimeoutError extends Error {
  readonly code = "CliProcessTimedOut" as const;
  constructor(
    readonly deadlineMs: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`CLI process exceeded its ${deadlineMs}ms deadline`);
    this.name = "CliProcessTimeoutError";
  }
}

/**
 * Spawns Node with `args` as a real child process, captures stdout/stderr and
 * resolves with the exit code once it closes. It never sleeps: it waits on the
 * `close` event with a single deadline timer. On timeout it terminates the whole
 * spawned process group (POSIX) or the process (Windows) so no browser or CLI
 * child leaks, then rejects with {@link CliProcessTimeoutError}.
 */
export function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deadlineMs: number,
  options: RunCliOptions = {},
): Promise<CliProcessResult> {
  return new Promise<CliProcessResult>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateGroup(child.pid);
    }, deadlineMs);
    timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new CliProcessTimeoutError(deadlineMs, stdout, stderr));
        return;
      }
      const exitCode = code ?? (signal !== null ? 1 : 0);
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

function terminateGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGKILL");
    } else {
      // Negative pid targets the whole detached process group, killing the CLI
      // and any browser it spawned.
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // The process already exited; nothing to terminate.
  }
}
