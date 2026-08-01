import { type Kysely, sql } from "kysely";

/**
 * Aux tables owned by the Server, provisioned ALONGSIDE the frozen relational
 * schema. These carry the Public API resources that have no domain aggregate
 * table yet (Projects, Targets, PRD revisions) and the Server-side persistence
 * for Runner identity (enrollments, certificate bindings). Every aux table is
 * tenant-scoped with forced RLS and a `tenant_isolation` policy granted only to
 * the Server role — identical to the frozen tables — so a query can never cross
 * tenants.
 */
export interface ProjectsTable {
  tenant_id: string;
  project_id: string;
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TargetsTable {
  tenant_id: string;
  target_id: string;
  project_id: string;
  kind: string;
  display_name: string;
  version: number;
  created_at: string;
}

export interface PrdRevisionsTable {
  tenant_id: string;
  prd_id: string;
  project_id: string;
  revision: number;
  title: string;
  content_sha256: string;
  ingested_at: string;
}

export interface RunnerEnrollmentsTable {
  tenant_id: string;
  enrollment_id: string;
  runner_id: string;
  project_ids_json: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface RunnerPrincipalsTable {
  tenant_id: string;
  fingerprint_sha256: string;
  runner_id: string;
  project_ids_json: string;
  certificate_uri_san: string;
  enrollment_id: string;
  status: string;
  certificate_not_after: string;
}

/** Aux database surface, queried via a tenant-scoped transaction. */
export interface AuxDatabase {
  projects: ProjectsTable;
  targets: TargetsTable;
  prd_revisions: PrdRevisionsTable;
  runner_enrollments: RunnerEnrollmentsTable;
  runner_principals: RunnerPrincipalsTable;
}

const AUX_TABLES = [
  "projects",
  "targets",
  "prd_revisions",
  "runner_enrollments",
  "runner_principals",
] as const;

const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Create the aux tables and apply the same forced-RLS tenant isolation the
 * frozen schema uses, granting only the Server role. Runs offline as the
 * owner/admin role, composing the frozen provisioning — it never modifies a
 * frozen package.
 */
export async function provisionAuxSchema(
  db: Kysely<AuxDatabase>,
  serverRole: string,
): Promise<void> {
  if (!SIMPLE_IDENTIFIER.test(serverRole)) {
    throw new Error(`Unsafe server role: ${JSON.stringify(serverRole)}`);
  }
  const role = sql.ref(serverRole);

  await sql`
    create table if not exists projects (
      tenant_id text not null,
      project_id text not null,
      name text not null,
      version integer not null,
      created_at text not null,
      updated_at text not null,
      primary key (tenant_id, project_id)
    )
  `.execute(db);

  await sql`
    create table if not exists targets (
      tenant_id text not null,
      target_id text not null,
      project_id text not null,
      kind text not null,
      display_name text not null,
      version integer not null,
      created_at text not null,
      primary key (tenant_id, target_id)
    )
  `.execute(db);

  await sql`
    create table if not exists prd_revisions (
      tenant_id text not null,
      prd_id text not null,
      project_id text not null,
      revision integer not null,
      title text not null,
      content_sha256 text not null,
      ingested_at text not null,
      primary key (tenant_id, prd_id)
    )
  `.execute(db);

  await sql`
    create table if not exists runner_enrollments (
      tenant_id text not null,
      enrollment_id text not null,
      runner_id text not null,
      project_ids_json text not null,
      token_hash text not null,
      expires_at text not null,
      consumed_at text,
      primary key (tenant_id, enrollment_id)
    )
  `.execute(db);

  await sql`
    create table if not exists runner_principals (
      tenant_id text not null,
      fingerprint_sha256 text not null,
      runner_id text not null,
      project_ids_json text not null,
      certificate_uri_san text not null,
      enrollment_id text not null,
      status text not null,
      certificate_not_after text not null,
      primary key (tenant_id, fingerprint_sha256)
    )
  `.execute(db);

  for (const table of AUX_TABLES) {
    const ref = sql.table(table);
    await sql`alter table ${ref} enable row level security`.execute(db);
    await sql`alter table ${ref} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${ref}
        to ${role}
        using (tenant_id = current_setting('app.tenant_id', true))
        with check (tenant_id = current_setting('app.tenant_id', true))
    `.execute(db);
    await sql`grant select, insert, update, delete on table ${ref} to ${role}`.execute(db);
  }
}
