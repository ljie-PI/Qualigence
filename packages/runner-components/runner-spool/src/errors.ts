export type RunnerSpoolErrorCode =
  | "SpoolOpenFailed"
  | "SpoolCapacityExceeded"
  | "SpoolIntegrityViolation"
  | "SpoolLeaseIntegrityViolation"
  | "SpoolResumeIntegrityViolation"
  | "SpoolKeyUnavailable"
  | "SpoolKeyInvalid";

export class RunnerSpoolError extends Error {
  readonly code: RunnerSpoolErrorCode;

  constructor(
    code: RunnerSpoolErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RunnerSpoolError";
    this.code = code;
  }
}
