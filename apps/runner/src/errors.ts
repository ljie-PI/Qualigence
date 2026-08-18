/**
 * Stable, structured error codes raised by the Runner client and job executor.
 * They are matched on {@link RunnerAppError.code}, never on message text.
 */
export type RunnerAppErrorCode =
  | "CapabilityMismatch"
  | "LeaseExpired"
  | "LeaseWindowUnsafe"
  | "SpoolUnavailable"
  | "PolicyMissing"
  | "PolicyDenied"
  | "TransportError";

export interface RunnerAppErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class RunnerAppError extends Error {
  readonly code: RunnerAppErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: RunnerAppErrorCode, message: string, options: RunnerAppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RunnerAppError";
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isRunnerAppError(value: unknown): value is RunnerAppError {
  return value instanceof RunnerAppError;
}
