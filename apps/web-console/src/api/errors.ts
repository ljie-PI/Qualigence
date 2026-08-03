import type { ErrorEnvelope, PublicApiErrorCode } from "@qualigence/public-api";

/**
 * A typed error raised by {@link PublicApiClient} for any non-2xx response.
 * It carries the Public API {@link ErrorEnvelope} `code` so callers (e.g. a
 * TanStack Query `onError`) can branch on `VersionConflict`, `Forbidden`, etc.
 * without ever parsing a raw HTTP status. `details` only ever contains the
 * Server's explicitly-safe conflict fields — never domain internals.
 */
export class ApiClientError extends Error {
  readonly code: PublicApiErrorCode;
  readonly status: number;
  readonly correlationId: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.safeMessage);
    this.name = "ApiClientError";
    this.code = envelope.code;
    this.status = status;
    this.correlationId = envelope.correlationId;
    if (envelope.details !== undefined) {
      this.details = envelope.details;
    }
  }
}

/** Narrowing helper: was this a specific Public API error code? */
export function isApiErrorCode(error: unknown, code: PublicApiErrorCode): boolean {
  return error instanceof ApiClientError && error.code === code;
}
