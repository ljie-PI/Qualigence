import { sql } from "kysely";
import type { SqliteRuntime } from "./database.js";
import { isSqliteBusyError, mapBusyError } from "./errors.js";

export async function runInImmediateTransaction<TResult>(
  runtime: SqliteRuntime,
  body: () => Promise<TResult>,
): Promise<TResult> {
  const db = runtime.db;
  try {
    await sql`BEGIN IMMEDIATE`.execute(db);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw mapBusyError(error);
    }
    throw error;
  }

  try {
    const result = await body();
    await sql`COMMIT`.execute(db);
    return result;
  } catch (error) {
    await sql`ROLLBACK`.execute(db).catch(() => undefined);
    if (isSqliteBusyError(error)) {
      throw mapBusyError(error);
    }
    throw error;
  }
}
