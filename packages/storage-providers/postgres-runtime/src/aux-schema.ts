import { sql, type Kysely } from "kysely";
import { PostgresSchemaError } from "./postgres-schema-error.js";

interface AuxColumnSpec {
  readonly name: string;
  readonly type: "text" | "integer";
  readonly nullable: boolean;
}

interface AuxTableSpec {
  readonly name: string;
  readonly columns: readonly AuxColumnSpec[];
  readonly primaryKey: readonly string[];
}

const text = (name: string, nullable = false): AuxColumnSpec => ({
  name,
  type: "text",
  nullable,
});
const integer = (name: string): AuxColumnSpec => ({ name, type: "integer", nullable: false });

const AUX_TABLES: readonly AuxTableSpec[] = [
  {
    name: "projects",
    columns: [
      text("tenant_id"), text("project_id"), text("name"), integer("version"),
      text("created_at"), text("updated_at"),
    ],
    primaryKey: ["tenant_id", "project_id"],
  },
  {
    name: "targets",
    columns: [
      text("tenant_id"), text("target_id"), text("project_id"), text("kind"),
      text("display_name"), integer("version"), text("created_at"),
    ],
    primaryKey: ["tenant_id", "target_id"],
  },
  {
    name: "prd_revisions",
    columns: [
      text("tenant_id"), text("prd_id"), text("project_id"), integer("revision"),
      text("title"), text("content_sha256"), text("ingested_at"),
    ],
    primaryKey: ["tenant_id", "prd_id"],
  },
  {
    name: "runner_enrollments",
    columns: [
      text("tenant_id"), text("enrollment_id"), text("runner_id"),
      text("project_ids_json"), text("token_hash"), text("expires_at"),
      text("consumed_at", true),
    ],
    primaryKey: ["tenant_id", "enrollment_id"],
  },
  {
    name: "runner_principals",
    columns: [
      text("tenant_id"), text("fingerprint_sha256"), text("runner_id"),
      text("project_ids_json"), text("certificate_uri_san"), text("enrollment_id"),
      text("status"), text("certificate_not_after"),
    ],
    primaryKey: ["tenant_id", "fingerprint_sha256"],
  },
];

const REQUIRED_POLICY_EXPRESSION =
  "(tenant_id = current_setting('app.tenant_id'::text, true))";
const REQUIRED_PRIVILEGES = ["DELETE", "INSERT", "SELECT", "UPDATE"];

export async function assertPostgresAuxSchema(
  db: Kysely<any>,
  expectedServerRole?: string,
): Promise<void> {
  for (const table of AUX_TABLES) {
    await assertTable(db, table);
    const role = await assertPolicy(db, table.name, expectedServerRole);
    await assertGrants(db, table.name, role);
  }
}

export async function markPostgresAuxSchemaCurrent(
  db: Kysely<any>,
  serverRole: string,
): Promise<void> {
  await assertPostgresAuxSchema(db, serverRole);
  await sql`
    insert into schema_components (component, version, completed_at)
    values ('server_aux', 1, ${new Date().toISOString()})
    on conflict (component) do update
      set version = excluded.version, completed_at = excluded.completed_at
  `.execute(db);
}

async function assertTable(db: Kysely<any>, table: AuxTableSpec): Promise<void> {
  const relation = await sql<{ relkind: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
    select c.relkind, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
     where c.oid = to_regclass(${`public.${table.name}`})
  `.execute(db);
  const rel = relation.rows[0];
  if (rel?.relkind !== "r") {
    malformed(`required auxiliary table ${table.name} is missing or is not a table`);
  }
  if (rel.relrowsecurity !== true || rel.relforcerowsecurity !== true) {
    malformed(`auxiliary table ${table.name} must enable and force row-level security`);
  }

  const columns = await sql<{
    column_name: string;
    data_type: string;
    is_nullable: boolean;
  }>`
    select a.attname as column_name, format_type(a.atttypid, a.atttypmod) as data_type,
           not a.attnotnull as is_nullable
      from pg_attribute a
     where a.attrelid = to_regclass(${`public.${table.name}`})
       and a.attnum > 0 and not a.attisdropped
     order by a.attnum
  `.execute(db);
  const actualColumns = columns.rows.map((column) => ({
    name: column.column_name,
    type: column.data_type,
    nullable: column.is_nullable,
  }));
  if (JSON.stringify(actualColumns) !== JSON.stringify(table.columns)) {
    malformed(`auxiliary table ${table.name} columns do not match the required schema`);
  }

  const primaryKey = await sql<{ column_name: string }>`
    select a.attname as column_name
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = to_regclass(${`public.${table.name}`}) and i.indisprimary
     order by array_position(i.indkey, a.attnum)
  `.execute(db);
  if (JSON.stringify(primaryKey.rows.map((row) => row.column_name)) !== JSON.stringify(table.primaryKey)) {
    malformed(`auxiliary table ${table.name} primary key does not match the required schema`);
  }
}

async function assertPolicy(
  db: Kysely<any>,
  table: string,
  expectedServerRole?: string,
): Promise<string> {
  const policies = await sql<{
    policyname: string;
    permissive: boolean;
    role_count: number;
    role_name: string;
    cmd: string;
    qual_matches: boolean;
    check_matches: boolean;
  }>`
    select p.polname as policyname, p.polpermissive as permissive,
           cardinality(p.polroles)::int as role_count,
           pg_get_userbyid(p.polroles[1]) as role_name,
           p.polcmd as cmd,
           regexp_replace(replace(pg_get_expr(p.polqual, p.polrelid), '::text', ''), '\s+', '', 'g') =
             regexp_replace(replace(${REQUIRED_POLICY_EXPRESSION}, '::text', ''), '\s+', '', 'g') as qual_matches,
           regexp_replace(replace(pg_get_expr(p.polwithcheck, p.polrelid), '::text', ''), '\s+', '', 'g') =
             regexp_replace(replace(${REQUIRED_POLICY_EXPRESSION}, '::text', ''), '\s+', '', 'g') as check_matches
      from pg_policy p
     where p.polrelid = to_regclass(${`public.${table}`})
  `.execute(db);
  const policy = policies.rows[0];
  if (
    policies.rows.length !== 1 ||
    policy?.policyname !== "tenant_isolation" ||
    policy.permissive !== true ||
    policy.cmd !== "*" ||
    policy.qual_matches !== true ||
    policy.check_matches !== true ||
    policy.role_count !== 1 ||
    policy.role_name === "public" ||
    (expectedServerRole !== undefined && policy.role_name !== expectedServerRole)
  ) {
    malformed(`auxiliary table ${table} tenant isolation policy is malformed`);
  }
  return policy.role_name;
}

async function assertGrants(db: Kysely<any>, table: string, serverRole: string): Promise<void> {
  const grants = await sql<{ grantee: string | null; privilege_type: string; is_owner: boolean }>`
    select grantee.rolname as grantee, acl.privilege_type,
           acl.grantee = c.relowner as is_owner
      from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      left join pg_roles grantee on grantee.oid = acl.grantee
     where c.oid = to_regclass(${`public.${table}`})
  `.execute(db);
  const runtimeGrants = grants.rows
    .filter((grant) => !grant.is_owner)
    .map((grant) => `${grant.grantee ?? "PUBLIC"}:${grant.privilege_type}`)
    .sort();
  const expected = REQUIRED_PRIVILEGES.map((privilege) => `${serverRole}:${privilege}`).sort();
  if (JSON.stringify(runtimeGrants) !== JSON.stringify(expected)) {
    malformed(`auxiliary table ${table} runtime grants do not match the required schema`);
  }
}

function malformed(message: string): never {
  throw new PostgresSchemaError("SchemaMalformed", message);
}
