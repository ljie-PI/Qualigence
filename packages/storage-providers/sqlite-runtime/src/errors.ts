export type SqliteErrorCode =
  | "DatabaseOpenFailed"
  | "DatabaseVersionTooNew"
  | "StorageBusy"
  | "StorageClosed"
  | "TraceIntegrityViolation"
  | "SequenceGap"
  | "RunTerminalConflict";

export class SqliteRuntimeError extends Error {
  readonly code: SqliteErrorCode;

  constructor(
    code: SqliteErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SqliteRuntimeError";
    this.code = code;
  }
}

const SQLITE_BUSY_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_TIMEOUT"]);

export function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    SQLITE_BUSY_CODES.has((error as { code: string }).code)
  );
}

export function mapBusyError(error: unknown): SqliteRuntimeError {
  return new SqliteRuntimeError(
    "StorageBusy",
    "SQLite reported the database as busy before the busy timeout elapsed",
    { cause: error },
  );
}
