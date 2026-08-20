import { type Kysely, sql } from "kysely";
import {
  RELATIONAL_TABLES,
  TENANT_OWNED_TABLES,
  WORKER_ACCESSIBLE_TABLES,
} from "@qualigence/relational-kysely";

/** Names of the least-privilege runtime roles the RLS layer provisions. */
export interface PostgresRuntimeRoles {
  /** Application role: non-owner, no BYPASSRLS, tenant-isolated. */
  readonly server: string;
  /** Worker role: may only lease/append the Intelligence Job tables. */
  readonly worker: string;
}

const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(value: string, label: string): void {
  if (!SIMPLE_IDENTIFIER.test(value)) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
}

/**
 * Enforce tenant isolation at the database level. Every tenant-owned table has
 * RLS enabled AND forced, with a policy that only exposes rows whose
 * `tenant_id` matches the request-scoped `app.tenant_id` GUC. A missing tenant
 * context resolves to NULL and therefore returns zero rows / rejects writes —
 * it can never be caught and bypassed in application code.
 *
 * The Worker role is granted exclusively on the Intelligence Job tables so it
 * can lease jobs across tenants without ever reading or writing aggregate,
 * evidence or review data.
 */
export async function applyRowLevelSecurity(
  db: Kysely<any>,
  roles: PostgresRuntimeRoles,
  tableNames?: readonly string[],
): Promise<void> {
  assertIdentifier(roles.server, "server role");
  assertIdentifier(roles.worker, "worker role");
  const serverRole = sql.ref(roles.server);
  const workerRole = sql.ref(roles.worker);

  await sql`grant usage on schema public to ${serverRole}, ${workerRole}`.execute(
    db,
  );
  await sql`grant select on table ${sql.table("schema_migrations")} to ${serverRole}, ${workerRole}`.execute(
    db,
  );

  const selected = tableNames === undefined ? undefined : new Set(tableNames);
  for (const table of TENANT_OWNED_TABLES) {
    if (selected !== undefined && !selected.has(table.name)) continue;
    const ref = sql.table(table.name);
    await sql`alter table ${ref} enable row level security`.execute(db);
    await sql`alter table ${ref} force row level security`.execute(db);

    await sql`drop policy if exists tenant_isolation on ${ref}`.execute(db);
    await sql`
      create policy tenant_isolation on ${ref}
        to ${serverRole}
        using (tenant_id = current_setting('app.tenant_id', true))
        with check (tenant_id = current_setting('app.tenant_id', true))
    `.execute(db);

    await sql`grant select, insert, update, delete on table ${ref} to ${serverRole}`.execute(
      db,
    );
  }

  for (const table of WORKER_ACCESSIBLE_TABLES) {
    if (selected !== undefined && !selected.has(table.name)) continue;
    const ref = sql.table(table.name);
    await sql`drop policy if exists worker_access on ${ref}`.execute(db);
    await sql`
      create policy worker_access on ${ref}
        to ${workerRole}
        using (true)
        with check (true)
    `.execute(db);
  }

  // The Worker may lease jobs (select/update) and append results (select/insert)
  // — and nothing else. Every other tenant table has no grant, so a worker read
  // fails closed with SQLSTATE 42501 before RLS is even consulted.
  if (selected === undefined || selected.has("intelligence_jobs")) {
    await sql`grant select, update on table ${sql.table("intelligence_jobs")} to ${workerRole}`.execute(db);
  }
  if (selected === undefined || selected.has("intelligence_results")) {
    await sql`grant select, insert on table ${sql.table("intelligence_results")} to ${workerRole}`.execute(db);
  }

  await sql`revoke create on schema public from ${serverRole}, ${workerRole}`.execute(db);
  await sql`revoke create on schema public from public`.execute(db);
}

/** Provision the least-privilege runtime roles. */
export async function createRuntimeRoles(
  db: Kysely<any>,
  input: {
    readonly database: string;
    readonly server: { readonly name: string; readonly password: string };
    readonly worker: { readonly name: string; readonly password: string };
  },
): Promise<void> {
  for (const role of [input.server, input.worker]) {
    assertIdentifier(role.name, "role name");
    if (role.password.includes("'")) {
      throw new Error("Role password must not contain a single quote.");
    }
    const ref = sql.ref(role.name);
    const password = sql.lit(role.password);
    await sql`
      do $role$
      begin
        create role ${ref} login password ${password}
          nosuperuser nobypassrls nocreatedb nocreaterole inherit;
      exception when duplicate_object then
        alter role ${ref} login password ${password}
          nosuperuser nobypassrls nocreatedb nocreaterole inherit;
      end
      $role$
    `.execute(db);
  }
  const dbRef = sql.ref(input.database);
  await sql`grant connect on database ${dbRef} to ${sql.ref(input.server.name)}, ${sql.ref(input.worker.name)}`.execute(
    db,
  );
}

/** The list of tables the RLS layer governs, for conformance assertions. */
export function governedTableNames(): readonly string[] {
  return RELATIONAL_TABLES.map((table) => table.name);
}
