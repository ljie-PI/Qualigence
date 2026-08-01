import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Clock } from "@qualigence/shared-kernel";
import { SystemClock } from "@qualigence/shared-kernel";
import { SqliteRuntimeError } from "./errors.js";
import { MIGRATIONS, SUPPORTED_SCHEMA_VERSION } from "./migrations.js";
import type { Database } from "./schema.js";

export interface SqliteRuntimeOptions {
  readonly filename: string;
  readonly busyTimeoutMs: number;
  readonly clock?: Clock;
}

export type PragmaValue = string | number;

export class SqliteRuntime {
  private closed = false;

  private constructor(
    private readonly connection: BetterSqlite3.Database,
    private readonly database: Kysely<Database>,
    private readonly clock: Clock,
  ) {}

  static async open(options: SqliteRuntimeOptions): Promise<SqliteRuntime> {
    let connection: BetterSqlite3.Database;
    try {
      connection = new BetterSqlite3(options.filename);
    } catch (cause) {
      throw new SqliteRuntimeError(
        "DatabaseOpenFailed",
        `Failed to open SQLite database at ${options.filename}`,
        { cause },
      );
    }

    try {
      connection.pragma("journal_mode = WAL");
      connection.pragma("foreign_keys = ON");
      connection.pragma(`busy_timeout = ${Math.trunc(options.busyTimeoutMs)}`);
    } catch (cause) {
      connection.close();
      throw new SqliteRuntimeError(
        "DatabaseOpenFailed",
        "Failed to configure required SQLite pragmas",
        { cause },
      );
    }

    const database = new Kysely<Database>({
      dialect: new SqliteDialect({ database: connection }),
    });

    const runtime = new SqliteRuntime(
      connection,
      database,
      options.clock ?? new SystemClock(),
    );

    try {
      await runtime.migrate();
    } catch (cause) {
      await runtime.close();
      throw cause;
    }

    return runtime;
  }

  get db(): Kysely<Database> {
    this.assertOpen();
    return this.database;
  }

  async pragma(name: string): Promise<PragmaValue> {
    this.assertOpen();
    const value = this.connection.pragma(name, { simple: true });
    return value as PragmaValue;
  }

  async schemaVersion(): Promise<number> {
    this.assertOpen();
    return this.readSchemaVersion();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.database.destroy();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SqliteRuntimeError(
        "StorageClosed",
        "The SQLite runtime has been closed",
      );
    }
  }

  private async migrate(): Promise<void> {
    const currentVersion = await this.readSchemaVersion();

    if (currentVersion > SUPPORTED_SCHEMA_VERSION) {
      throw new SqliteRuntimeError(
        "DatabaseVersionTooNew",
        `Database schema version ${currentVersion} is newer than the supported version ${SUPPORTED_SCHEMA_VERSION}`,
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) {
        continue;
      }
      await this.database.transaction().execute(async (trx) => {
        await migration.up(trx);
        await trx
          .insertInto("schema_migrations")
          .values({
            version: migration.version,
            name: migration.name,
            applied_at: this.clock.now(),
          })
          .execute();
      });
    }
  }

  private async readSchemaVersion(): Promise<number> {
    if (!this.tableExists("schema_migrations")) {
      return 0;
    }
    const row = await this.database
      .selectFrom("schema_migrations")
      .select((builder) => builder.fn.max("version").as("version"))
      .executeTakeFirst();
    return Number(row?.version ?? 0);
  }

  private tableExists(name: string): boolean {
    const row = this.connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name);
    return row !== undefined;
  }
}
