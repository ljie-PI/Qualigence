import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import {
  provisionPostgres,
  type PostgresConnectionConfig,
} from "@qualigence/postgres-runtime";
import { provisionAuxSchema, type AuxDatabase } from "./aux-schema.js";

const { Pool } = pg;

export interface ServerBootstrapInput {
  /** Owner/migration connection; used once, offline. */
  readonly admin: PostgresConnectionConfig;
  readonly roles: {
    readonly server: { readonly name: string; readonly password: string };
    readonly worker: { readonly name: string; readonly password: string };
  };
}

/**
 * Provision the full Server database: the frozen tenant-scoped relational
 * schema + forced RLS + least-privilege roles (via {@link provisionPostgres}),
 * then the Server-owned aux tables with the same tenant isolation. Idempotent
 * enough to run once at deploy time by the owner role.
 */
export async function bootstrapServerDatabase(input: ServerBootstrapInput): Promise<void> {
  await provisionPostgres(input);

  const db = new Kysely<AuxDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        host: input.admin.host,
        port: input.admin.port,
        database: input.admin.database,
        user: input.admin.user,
        password: input.admin.password,
        max: 2,
      }),
    }),
  });
  try {
    await provisionAuxSchema(db, input.roles.server.name);
  } finally {
    await db.destroy();
  }
}
