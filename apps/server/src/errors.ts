import { randomUUID } from "node:crypto";
import type { ErrorEnvelope, PublicApiErrorCode } from "@qualigence/public-api";

/** A domain error mapped to a Public API error envelope + HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: PublicApiErrorCode,
    readonly safeMessage: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(safeMessage);
    this.name = "ApiError";
  }
}

export const unauthorized = (message = "authentication required"): ApiError =>
  new ApiError(401, "Unauthorized", message);
export const forbidden = (message = "insufficient role"): ApiError =>
  new ApiError(403, "Forbidden", message);
export const notFound = (message = "resource not found"): ApiError =>
  new ApiError(404, "NotFound", message);
export const versionConflict = (
  details: Readonly<Record<string, unknown>>,
  message = "resource version conflict",
): ApiError => new ApiError(409, "VersionConflict", message, details);
export const idempotencyKeyRequired = (): ApiError =>
  new ApiError(400, "IdempotencyKeyRequired", "a mutation requires an Idempotency-Key header");
export const validationFailed = (message: string): ApiError =>
  new ApiError(422, "ValidationFailed", message);
export const enrollmentTokenInvalid = (message = "enrollment token is invalid"): ApiError =>
  new ApiError(401, "EnrollmentTokenInvalid", message);
export const runnerUnauthenticated = (message = "runner certificate is not authenticated"): ApiError =>
  new ApiError(401, "RunnerIdentityUnauthenticated", message);

export function toErrorEnvelope(error: ApiError, correlationId: string): ErrorEnvelope {
  return {
    code: error.code,
    safeMessage: error.safeMessage,
    correlationId,
    ...(error.details ? { details: error.details } : {}),
  };
}

export function newCorrelationId(): string {
  return randomUUID();
}
