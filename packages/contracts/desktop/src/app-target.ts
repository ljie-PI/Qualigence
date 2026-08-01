/**
 * AppTarget contract (LS-13 / M3 Windows Desktop Target).
 *
 * An {@link AppTarget} identifies a desktop application/window a Runner wants to
 * drive, together with the *canonical* launch/reset/shutdown lifecycle the Rust
 * Companion will enforce. It is intentionally a pure data contract: it carries an
 * argv array and canonical absolute paths only — never a shell command string —
 * so the Companion can start the process with `CreateProcessW` argv semantics and
 * a Job Object without ever going through a shell. Executing commands and holding
 * native handles is the Companion's job; this contract never does either.
 */

export type DesktopPlatform = "windows";

export interface AppTargetLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory?: string;
}

export interface AppTargetProcess {
  readonly expectedImageName: string;
  readonly allowedChildImageNames: readonly string[];
}

export interface AppTargetWindow {
  readonly titlePattern?: string;
  readonly automationId?: string;
}

export interface AppTargetReset {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface AppTargetShutdown {
  readonly gracefulTimeoutMs: number;
  readonly forceAfterTimeout: boolean;
}

export interface AppTarget {
  readonly targetId: string;
  readonly platform: DesktopPlatform;
  readonly launch: AppTargetLaunch;
  readonly process: AppTargetProcess;
  readonly window: AppTargetWindow;
  readonly reset: AppTargetReset;
  readonly shutdown: AppTargetShutdown;
}

/**
 * A live desktop process the Companion is brokering. It exposes only an opaque
 * {@link processGroupId} — never a native Job Object handle — so a compromised or
 * buggy TypeScript layer can never terminate an unrelated process by name or by a
 * reused PID. Shutdown/reset always go back through the Companion, which verifies
 * Job membership + PID creation time + image path before acting.
 */
export interface AppSession {
  readonly sessionId: string;
  readonly processId: number;
  readonly processCreationTime: string;
  readonly processGroupId: string;
  readonly rootWindowHandle: string;
  readonly startedAt: string;
}

export interface DesktopEnvironmentProvider {
  launch(target: AppTarget): Promise<AppSession>;
  reset(session: AppSession): Promise<void>;
  shutdown(session: AppSession): Promise<void>;
}

export type AppTargetErrorCode =
  | "InvalidAppTargetShape"
  | "InvalidPlatform"
  | "InvalidTargetId"
  | "InvalidLaunchConfiguration"
  | "InvalidProcessConfiguration"
  | "InvalidWindowConfiguration"
  | "InvalidResetConfiguration"
  | "InvalidShutdownConfiguration";

export class AppTargetError extends Error {
  readonly code: AppTargetErrorCode;

  constructor(code: AppTargetErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AppTargetError";
    this.code = code;
  }
}

/** Fixed bounds so a malformed/oversized configuration fails closed. */
export const APP_TARGET_LIMITS = {
  maxTargetIdLength: 200,
  maxExecutableLength: 4096,
  maxWorkingDirectoryLength: 4096,
  maxArgLength: 8192,
  maxArgs: 128,
  maxImageNameLength: 260,
  maxAllowedChildImages: 64,
  maxTitlePatternLength: 512,
  maxAutomationIdLength: 512,
  minTimeoutMs: 0,
  maxTimeoutMs: 600_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  code: AppTargetErrorCode,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppTargetError(code, `${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new AppTargetError(code, `${field} exceeds ${maxLength} characters`);
  }
  return value;
}

/**
 * A shell command string is rejected: the value must be a bare, canonical,
 * absolute executable path (no spaces / arguments / shell metacharacters), so the
 * only way to pass arguments is the explicit argv array.
 */
function requireCanonicalExecutable(value: unknown): string {
  const executable = requireString(
    value,
    "InvalidLaunchConfiguration",
    "launch.executable",
    APP_TARGET_LIMITS.maxExecutableLength,
  );
  if (!isCanonicalAbsolutePath(executable)) {
    throw new AppTargetError(
      "InvalidLaunchConfiguration",
      "launch.executable must be a canonical absolute path with no shell metacharacters",
    );
  }
  return executable;
}

const SHELL_METACHARACTERS = /[\s"'`;&|<>$(){}*?!~]/;

function isCanonicalAbsolutePath(candidate: string): boolean {
  if (SHELL_METACHARACTERS.test(candidate)) {
    return false;
  }
  if (candidate.includes("..")) {
    return false;
  }
  // Windows drive-absolute (C:\...) or UNC (\\host\share). This contract only
  // targets Windows, so a POSIX-style leading slash is not a valid target path.
  const driveAbsolute = /^[A-Za-z]:[\\/]/.test(candidate);
  const uncAbsolute = candidate.startsWith("\\\\");
  return driveAbsolute || uncAbsolute;
}

function requireArgs(value: unknown, code: AppTargetErrorCode, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new AppTargetError(code, `${field} must be an array`);
  }
  if (value.length > APP_TARGET_LIMITS.maxArgs) {
    throw new AppTargetError(code, `${field} exceeds ${APP_TARGET_LIMITS.maxArgs} entries`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new AppTargetError(code, `${field}[${index}] must be a string`);
    }
    if (entry.length > APP_TARGET_LIMITS.maxArgLength) {
      throw new AppTargetError(code, `${field}[${index}] exceeds ${APP_TARGET_LIMITS.maxArgLength} characters`);
    }
    return entry;
  });
}

function requireImageName(value: unknown, field: string): string {
  const name = requireString(
    value,
    "InvalidProcessConfiguration",
    field,
    APP_TARGET_LIMITS.maxImageNameLength,
  );
  // An image *name*, never a broad path or a wildcard used for name-based kill.
  if (name.includes("/") || name.includes("\\") || name.includes("*") || name.includes("?")) {
    throw new AppTargetError(
      "InvalidProcessConfiguration",
      `${field} must be a bare image name without path separators or wildcards`,
    );
  }
  return name;
}

function requireTimeoutMs(value: unknown, code: AppTargetErrorCode, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AppTargetError(code, `${field} must be an integer number of milliseconds`);
  }
  if (value < APP_TARGET_LIMITS.minTimeoutMs || value > APP_TARGET_LIMITS.maxTimeoutMs) {
    throw new AppTargetError(
      code,
      `${field} must be between ${APP_TARGET_LIMITS.minTimeoutMs} and ${APP_TARGET_LIMITS.maxTimeoutMs} ms`,
    );
  }
  return value;
}

/**
 * Validate an untrusted candidate and return a frozen, canonical {@link AppTarget}.
 * Throws {@link AppTargetError} with a stable code on any violation.
 */
export function validateAppTarget(candidate: unknown): AppTarget {
  if (!isRecord(candidate)) {
    throw new AppTargetError("InvalidAppTargetShape", "AppTarget must be an object");
  }

  const targetId = requireString(
    candidate.targetId,
    "InvalidTargetId",
    "targetId",
    APP_TARGET_LIMITS.maxTargetIdLength,
  );

  if (candidate.platform !== "windows") {
    throw new AppTargetError("InvalidPlatform", "platform must be \"windows\"");
  }

  const launchRaw = candidate.launch;
  if (!isRecord(launchRaw)) {
    throw new AppTargetError("InvalidLaunchConfiguration", "launch must be an object with executable + args");
  }
  if ("command" in launchRaw) {
    throw new AppTargetError(
      "InvalidLaunchConfiguration",
      "launch.command (shell string) is not permitted; use executable + args array",
    );
  }
  const executable = requireCanonicalExecutable(launchRaw.executable);
  const args = requireArgs(launchRaw.args, "InvalidLaunchConfiguration", "launch.args");
  let workingDirectory: string | undefined;
  if (launchRaw.workingDirectory !== undefined) {
    workingDirectory = requireString(
      launchRaw.workingDirectory,
      "InvalidLaunchConfiguration",
      "launch.workingDirectory",
      APP_TARGET_LIMITS.maxWorkingDirectoryLength,
    );
    if (!isCanonicalAbsolutePath(workingDirectory)) {
      throw new AppTargetError(
        "InvalidLaunchConfiguration",
        "launch.workingDirectory must be a canonical absolute path",
      );
    }
  }

  const processRaw = candidate.process;
  if (!isRecord(processRaw)) {
    throw new AppTargetError("InvalidProcessConfiguration", "process must be an object");
  }
  const expectedImageName = requireImageName(processRaw.expectedImageName, "process.expectedImageName");
  if (!Array.isArray(processRaw.allowedChildImageNames)) {
    throw new AppTargetError(
      "InvalidProcessConfiguration",
      "process.allowedChildImageNames must be an array",
    );
  }
  if (processRaw.allowedChildImageNames.length > APP_TARGET_LIMITS.maxAllowedChildImages) {
    throw new AppTargetError(
      "InvalidProcessConfiguration",
      `process.allowedChildImageNames exceeds ${APP_TARGET_LIMITS.maxAllowedChildImages} entries`,
    );
  }
  const allowedChildImageNames = processRaw.allowedChildImageNames.map((entry, index) =>
    requireImageName(entry, `process.allowedChildImageNames[${index}]`),
  );

  const windowRaw = candidate.window;
  if (!isRecord(windowRaw)) {
    throw new AppTargetError("InvalidWindowConfiguration", "window must be an object");
  }
  let titlePattern: string | undefined;
  if (windowRaw.titlePattern !== undefined) {
    titlePattern = requireString(
      windowRaw.titlePattern,
      "InvalidWindowConfiguration",
      "window.titlePattern",
      APP_TARGET_LIMITS.maxTitlePatternLength,
    );
  }
  let automationId: string | undefined;
  if (windowRaw.automationId !== undefined) {
    automationId = requireString(
      windowRaw.automationId,
      "InvalidWindowConfiguration",
      "window.automationId",
      APP_TARGET_LIMITS.maxAutomationIdLength,
    );
  }

  const resetRaw = candidate.reset;
  if (!isRecord(resetRaw)) {
    throw new AppTargetError("InvalidResetConfiguration", "reset must be an object");
  }
  const resetCommand = requireCanonicalExecutable(resetRaw.command);
  const resetArgs = requireArgs(resetRaw.args, "InvalidResetConfiguration", "reset.args");
  if (resetRaw.timeoutMs === undefined) {
    throw new AppTargetError("InvalidResetConfiguration", "reset.timeoutMs is required");
  }
  const resetTimeoutMs = requireTimeoutMs(resetRaw.timeoutMs, "InvalidResetConfiguration", "reset.timeoutMs");

  const shutdownRaw = candidate.shutdown;
  if (!isRecord(shutdownRaw)) {
    throw new AppTargetError("InvalidShutdownConfiguration", "shutdown must be an object");
  }
  const gracefulTimeoutMs = requireTimeoutMs(
    shutdownRaw.gracefulTimeoutMs,
    "InvalidShutdownConfiguration",
    "shutdown.gracefulTimeoutMs",
  );
  if (typeof shutdownRaw.forceAfterTimeout !== "boolean") {
    throw new AppTargetError(
      "InvalidShutdownConfiguration",
      "shutdown.forceAfterTimeout must be a boolean",
    );
  }

  const launch: AppTargetLaunch =
    workingDirectory === undefined ? { executable, args } : { executable, args, workingDirectory };
  const window: AppTargetWindow = {
    ...(titlePattern === undefined ? {} : { titlePattern }),
    ...(automationId === undefined ? {} : { automationId }),
  };

  return Object.freeze({
    targetId,
    platform: "windows",
    launch: Object.freeze(launch),
    process: Object.freeze({
      expectedImageName,
      allowedChildImageNames: Object.freeze([...allowedChildImageNames]),
    }),
    window: Object.freeze(window),
    reset: Object.freeze({ command: resetCommand, args: resetArgs, timeoutMs: resetTimeoutMs }),
    shutdown: Object.freeze({ gracefulTimeoutMs, forceAfterTimeout: shutdownRaw.forceAfterTimeout }),
  });
}

/** Ergonomic constructor used by callers that already hold a candidate object. */
export const AppTarget = {
  create(candidate: unknown): AppTarget {
    return validateAppTarget(candidate);
  },
} as const;
