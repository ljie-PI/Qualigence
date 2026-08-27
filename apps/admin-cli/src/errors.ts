export type AdminCliErrorCode =
  | "ConfigInvalid"
  | "SecretUnreadable"
  | "SecretPermissionsUnsafe"
  | "MigrationBlocked"
  | "BackupFailed"
  | "BackupIncomplete"
  | "RestoreFailed"
  | "RestoreTargetMismatch"
  | "RestoreTargetNotEmpty"
  | "IntegrityViolation"
  | "PgToolFailed";

/** A typed, operator-safe failure raised by the Self-hosted admin CLI. */
export class AdminCliError extends Error {
  readonly code: AdminCliErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AdminCliErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options);
    this.name = "AdminCliError";
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}
