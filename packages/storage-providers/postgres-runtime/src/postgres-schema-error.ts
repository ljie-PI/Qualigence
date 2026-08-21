export type PostgresSchemaErrorCode =
  | "SchemaMalformed"
  | "SchemaAhead"
  | "SchemaBehind";

export class PostgresSchemaError extends Error {
  constructor(
    readonly code: PostgresSchemaErrorCode,
    message: string,
    readonly appliedVersion?: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "PostgresSchemaError";
  }
}
