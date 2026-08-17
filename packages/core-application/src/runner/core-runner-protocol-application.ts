export type CoreApplicationErrorCode =
  | "LeaseLost"
  | "CapabilityMismatch"
  | "ProtocolVersionMismatch"
  | "RunnerResumeRejected"
  | "TraceIntegrityViolation"
  | "UnknownSession"
  | "UnknownOffer"
  | "UnknownRun"
  | "RunOwnershipViolation";

export interface CoreApplicationErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class CoreApplicationError extends Error {
  readonly code: CoreApplicationErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: CoreApplicationErrorCode, message: string, options: CoreApplicationErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CoreApplicationError";
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isCoreApplicationError(value: unknown): value is CoreApplicationError {
  return value instanceof CoreApplicationError;
}
