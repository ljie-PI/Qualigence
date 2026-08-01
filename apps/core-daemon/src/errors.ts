/**
 * Stable, structured error codes raised by the Core Daemon session, lease and
 * ownership services. They are matched on {@link CoreDaemonError.code}, never on
 * the human-readable message, so callers can branch on protocol rejections.
 */
export type CoreDaemonErrorCode =
  | "LeaseLost"
  | "CapabilityMismatch"
  | "ProtocolVersionMismatch"
  | "RunnerResumeRejected"
  | "TraceIntegrityViolation"
  | "UnknownSession"
  | "UnknownOffer"
  | "UnknownRun"
  | "RunOwnershipViolation";

export interface CoreDaemonErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class CoreDaemonError extends Error {
  readonly code: CoreDaemonErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: CoreDaemonErrorCode, message: string, options: CoreDaemonErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CoreDaemonError";
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isCoreDaemonError(value: unknown): value is CoreDaemonError {
  return value instanceof CoreDaemonError;
}
