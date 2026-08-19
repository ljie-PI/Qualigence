/**
 * Stable, structured error codes raised by the Local Launcher. They are matched
 * on {@link LauncherError.code}, never on message text, and every message is a
 * user-safe string that must not carry a secret or credential value.
 */
export type LauncherErrorCode =
  | "AlreadyRunning"
  | "NotRunning"
  | "StartupTimedOut"
  | "CoreUnhealthy"
  | "RunnerUnhealthy"
  | "BackupFailed"
  | "BackupIntegrityFailed"
  | "MigrationBlocked"
  | "InvalidConfiguration"
  | "StopTopologyChanged"
  | "SupervisorUnavailable"
  | "StopRequestInvalid"
  | "StopTimedOut"
  | "ProcessReapTimedOut";

export interface LauncherErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class LauncherError extends Error {
  readonly code: LauncherErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: LauncherErrorCode, message: string, options: LauncherErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LauncherError";
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isLauncherError(value: unknown): value is LauncherError {
  return value instanceof LauncherError;
}
