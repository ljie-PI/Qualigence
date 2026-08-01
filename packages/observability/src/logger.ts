/** The sentinel written in place of any redacted value. */
export const REDACTED = "[redacted]";

/** A single structured log record after redaction. */
export interface LogRecord {
  readonly level: LogLevel;
  readonly service: string;
  readonly time: string;
  readonly msg: string;
  readonly [key: string]: unknown;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface StructuredLoggerOptions {
  readonly service: string;
  /** Where finished records go. Defaults to a JSON line on stderr. */
  readonly sink?: (record: LogRecord) => void;
  readonly now?: () => string;
  /**
   * Extra field names (lower-cased) to redact on top of the built-in set. The
   * built-in set already covers the credential/secret vocabulary used across
   * the deployment (password, token, secret, apiKey, ...).
   */
  readonly redactKeys?: readonly string[];
}

const DEFAULT_REDACT_KEYS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "secretaccesskey",
  "accesskeyid",
  "token",
  "enrollmenttoken",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "privatekey",
  "private_key",
  "rootkey",
  "root_key",
  "keymaterial",
  "csrpem",
  "certificatepem",
  "clientsecret",
  "client_secret",
];

// Matches PEM private-key blocks so a private key accidentally logged as a raw
// string value is redacted even when its field name is innocuous.
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z ]*)PRIVATE KEY-----/;

/**
 * A minimal, dependency-free structured JSON logger with built-in redaction of
 * secret-shaped fields at any nesting depth. Every deployment component (the
 * admin CLI's migrate/doctor/backup/restore commands, and any operator tool)
 * uses it so operational logs never leak DB/S3/KMS credentials, enrollment
 * tokens or PEM private keys. Records are plain objects, which makes assertions
 * in tests trivial and keeps the transport (stderr, a file, an OTLP shipper)
 * a pluggable sink concern.
 */
export class StructuredLogger {
  private readonly service: string;
  private readonly sink: (record: LogRecord) => void;
  private readonly now: () => string;
  private readonly redactKeys: Set<string>;

  constructor(options: StructuredLoggerOptions) {
    this.service = options.service;
    this.sink =
      options.sink ??
      ((record) => {
        process.stderr.write(`${JSON.stringify(record)}\n`);
      });
    this.now = options.now ?? (() => new Date().toISOString());
    this.redactKeys = new Set([
      ...DEFAULT_REDACT_KEYS,
      ...(options.redactKeys ?? []).map((key) => key.toLowerCase()),
    ]);
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.emit("debug", msg, fields);
  }

  info(msg: string, fields: LogFields = {}): void {
    this.emit("info", msg, fields);
  }

  warn(msg: string, fields: LogFields = {}): void {
    this.emit("warn", msg, fields);
  }

  error(msg: string, fields: LogFields = {}): void {
    this.emit("error", msg, fields);
  }

  /** Build a record and return it as a single redacted JSON line. */
  stringify(msg: string, fields: LogFields = {}): string {
    return JSON.stringify(this.build("info", msg, fields));
  }

  private emit(level: LogLevel, msg: string, fields: LogFields): void {
    this.sink(this.build(level, msg, fields));
  }

  private build(level: LogLevel, msg: string, fields: LogFields): LogRecord {
    const redacted = this.redactValue(fields) as LogFields;
    return {
      level,
      service: this.service,
      time: this.now(),
      msg,
      ...redacted,
    };
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === "string") {
      return PEM_PRIVATE_KEY.test(value) ? REDACTED : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item));
    }
    if (value !== null && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        if (this.redactKeys.has(key.toLowerCase())) {
          output[key] = REDACTED;
        } else {
          output[key] = this.redactValue(inner);
        }
      }
      return output;
    }
    return value;
  }
}
