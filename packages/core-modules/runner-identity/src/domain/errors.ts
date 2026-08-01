/**
 * Stable, structured error codes for the Self-hosted Runner identity domain.
 * They are matched on {@link RunnerIdentityError.code}, never by message string,
 * so callers (gRPC adapter, enrollment routes, tests) can branch deterministically
 * on enrollment lifecycle, certificate binding and authorization rejections.
 */
export type RunnerIdentityErrorCode =
  | "RunnerEnrollmentNotFound"
  | "RunnerEnrollmentExpired"
  | "RunnerEnrollmentTokenInvalid"
  | "RunnerEnrollmentAlreadyConsumed"
  | "RunnerCsrInvalid"
  | "RunnerKeyTooWeak"
  | "RunnerCertificateUntrusted"
  | "RunnerCertificateExpired"
  | "RunnerCertificateRevoked"
  | "RunnerSuspended"
  | "RunnerPrincipalNotFound"
  | "RunnerIdentityMismatch"
  | "RunnerScopeViolation";

export interface RunnerIdentityErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class RunnerIdentityError extends Error {
  readonly code: RunnerIdentityErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: RunnerIdentityErrorCode, message: string, options: RunnerIdentityErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RunnerIdentityError";
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isRunnerIdentityError(value: unknown): value is RunnerIdentityError {
  return value instanceof RunnerIdentityError;
}
