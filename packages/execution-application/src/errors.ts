export type ExecutionApplicationErrorCode =
  | "InvalidConfiguration"
  | "InvalidTargetUrl"
  | "ModelAuthenticationFailed"
  | "ModelUnavailable"
  | "BrowserUnavailable"
  | "PersistenceUnavailable"
  | "ArtifactUnavailable"
  | "MissionNotFound"
  | "CleanupFailed";

/**
 * A user-safe application error carrying a stable {@link ExecutionApplicationErrorCode}.
 * Underlying causes are attached for controlled debug logging only; they must
 * never be surfaced to the user or serialized into the CLI result.
 */
export class ExecutionApplicationError extends Error {
  readonly code: ExecutionApplicationErrorCode;

  constructor(
    code: ExecutionApplicationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExecutionApplicationError";
    this.code = code;
  }
}
