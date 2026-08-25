/**
 * Stable, transport-level error codes surfaced by the gRPC runner adapter. They
 * are deliberately structured (never matched by message string) so callers can
 * branch on protocol rejections, identity failures and transport faults.
 */
export type RunnerProtocolErrorCode =
  | "ProtocolVersionMismatch"
  | "CapabilityMismatch"
  | "RunnerIdentityMismatch"
  | "RunnerAlreadyConnected"
  | "RunnerScopeViolation"
  | "TlsPeerRejected"
  | "RunnerCertificateUntrusted"
  | "RunnerCertificateExpired"
  | "RunnerCertificateRevoked"
  | "RunnerSuspended"
  | "RunnerPrincipalNotFound"
  | "ResumeRejected"
  | "LeaseLost"
  | "RunIdentityMismatch"
  | "UnknownOffer"
  | "UnknownSession"
  | "TraceGap"
  | "TraceIntegrityViolation"
  | "ProtocolViolation"
  | "PolicyMissing"
  | "SessionClosed"
  | "TransportError";

export interface RunnerProtocolErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class RunnerProtocolError extends Error {
  readonly code: RunnerProtocolErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: RunnerProtocolErrorCode, message: string, options: RunnerProtocolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RunnerProtocolError";
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isRunnerProtocolError(value: unknown): value is RunnerProtocolError {
  return value instanceof RunnerProtocolError;
}
