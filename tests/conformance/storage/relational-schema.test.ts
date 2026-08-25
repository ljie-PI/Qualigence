import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { SqliteRuntime, SUPPORTED_SCHEMA_VERSION } from "@qualigence/sqlite-runtime";
import {
  relationalTableNames,
  tenantOwnedTableNames,
  tenantOwnedTableNamesThroughVersion,
  RELATIONAL_TABLES,
  RELATIONAL_SCHEMA_VERSIONS,
} from "@qualigence/relational-kysely";

let dir: string;
let filename: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), ".tmp-relschema-"));
  filename = join(dir, "qualigence.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("shared relational schema catalog", () => {
  it("matches the tables the SQLite migrations physically create", async () => {
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    const rows = await runtime.db
      .selectFrom("sqlite_master")
      .select("name")
      .where("type", "=", "table")
      .execute();
    await runtime.close();

    const sqliteTables = new Set(
      rows
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_")),
    );
    const catalogTables = new Set(relationalTableNames());

    expect(sqliteTables).toEqual(catalogTables);
  });

  it("agrees with the SQLite runtime on the logical schema version", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(13);
  });

  it("assigns every relational table to one sequential released schema version", () => {
    expect(RELATIONAL_SCHEMA_VERSIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(RELATIONAL_SCHEMA_VERSIONS.flatMap((migration) => migration.tables)).toEqual(
      relationalTableNames(),
    );
  });

  it("assigns the exact Mission scheduling tables to migration 009", () => {
    expect(RELATIONAL_SCHEMA_VERSIONS.find(({ version }) => version === 9)?.tables).toEqual([
      "mission_scheduling_heads",
      "mission_start_commands",
      "mission_job_attempts",
      "runner_execution_jobs",
      "mission_execution_provenance",
      "mission_dispatch_outbox",
      "mission_dispatch_wakeups",
    ]);
  });

  it("assigns Skill lifecycle command idempotency and audit tables to migration 010", async () => {
    expect(RELATIONAL_SCHEMA_VERSIONS.find(({ version }) => version === 10)).toEqual({
      version: 10,
      name: "skill-lifecycle-commands",
      tables: ["skill_lifecycle_commands", "skill_lifecycle_audit_events"],
    });
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    try {
      expect(await runtime.schemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(await tableColumns(runtime, "skill_lifecycle_commands")).toEqual([
        "idempotency_key", "command_hash", "command_type", "skill_id",
        "expected_version", "result_version", "result_json", "created_at",
      ]);
      expect(await tableColumns(runtime, "skill_lifecycle_audit_events")).toEqual([
        "audit_id", "skill_id", "skill_version", "operation", "decision",
        "actor_id", "actor_tenant_id", "actor_roles_json", "reason", "metadata_json", "created_at",
      ]);
    } finally { await runtime.close(); }
  });

  it("assigns exploration live progress tables to migration 011", async () => {
    expect(RELATIONAL_SCHEMA_VERSIONS.find(({ version }) => version === 11)).toEqual({
      version: 11,
      name: "exploration-attempt-progress",
      tables: ["exploration_attempt_progress", "exploration_live_checkpoints"],
    });
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    try {
      expect(await runtime.schemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(await tableColumns(runtime, "exploration_attempt_progress")).toEqual([
        "attempt_id", "run_id", "source_binding_hash", "policy_binding_hash",
        "seed_binding_hash", "phase", "seed_cursor_json", "last_safe_step",
        "last_safe_graph_fingerprint", "remaining_json", "in_flight_action_json",
        "terminal_reason", "version", "created_at", "updated_at",
      ]);
      expect(await tableColumns(runtime, "exploration_live_checkpoints")).toEqual([
        "attempt_id", "step", "graph_fingerprint", "remaining_json", "terminal_reason", "created_at",
      ]);
    } finally { await runtime.close(); }
  });

  it("assigns Intelligence lease, inbox, wakeup, and disposition tables to migrations 012-013", async () => {
    expect(RELATIONAL_SCHEMA_VERSIONS.find(({ version }) => version === 12)).toEqual({
      version: 12,
      name: "intelligence-leases-results",
      tables: ["intelligence_leases", "intelligence_result_inbox"],
    });
    expect(RELATIONAL_SCHEMA_VERSIONS.find(({ version }) => version === 13)).toEqual({
      version: 13,
      name: "intelligence-result-wakeups-dispositions",
      tables: ["intelligence_result_wakeups", "intelligence_result_dispositions"],
    });
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    try {
      expect(await runtime.schemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(await tableColumns(runtime, "intelligence_result_wakeups")).toEqual([
        "tenant_id", "generation", "status", "available_at", "lease_owner",
        "lease_generation", "lease_expires_at", "last_claimed_at", "last_completed_at",
        "failure_count", "last_error", "created_at", "updated_at",
      ]);
      expect(await tableColumns(runtime, "intelligence_result_dispositions")).toEqual([
        "tenant_id", "idempotency_key", "job_id", "result_hash", "status",
        "code", "reason", "aggregate_type", "aggregate_id", "new_version",
        "summary", "created_at",
      ]);
    } finally { await runtime.close(); }
  });

  it("gives the Mission dispatch outbox durable CAS and acceptance columns", async () => {
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    try {
      expect(await tableColumns(runtime, "mission_dispatch_outbox")).toEqual([
        "attempt_id", "mission_id", "runner_id", "runner_job_id", "run_id",
        "idempotency_key", "required_capabilities_json", "accepted_job_json",
        "status", "version", "accepted_at", "acceptance_receipt_json", "created_at",
      ]);
      expect(await indexColumns(runtime, "mission_dispatch_outbox_command_job_unique")).toEqual([
        "idempotency_key", "runner_job_id",
      ]);
      expect(await indexIsUnique(runtime, "mission_dispatch_outbox_command_job_unique")).toBe(true);
      expect(await indexColumns(runtime, "mission_dispatch_outbox_pending")).toEqual([
        "status", "created_at", "attempt_id",
      ]);
      expect(normalizeSql(await indexSql(runtime, "mission_dispatch_outbox_pending"))).toBe(
        'create index "mission_dispatch_outbox_pending" on "mission_dispatch_outbox" ("status", "created_at", "attempt_id") where status = \'pending\'',
      );
    } finally { await runtime.close(); }
  });

  it("adds the migration-007 Local intake authority", async () => {
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    try {
      expect(await runtime.schemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(await tableColumns(runtime, "local_run_intakes")).toEqual([
        "run_id", "job_id", "job_json", "job_sha256", "dispatch_state", "dispatch_attempt",
        "dispatch_last_attempt_at", "dispatch_error_code", "completion_state", "completion_attempt",
        "completion_last_attempt_at", "completion_next_attempt_at", "completion_error_code",
        "completion_sha256", "completion_applied_at", "completion_blocked_at", "created_at", "updated_at",
      ]);
    } finally { await runtime.close(); }
  });

  it("freezes migration-006 runner-control tables, hashed-only tokens, and active indexes", async () => {
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    try {
      expect(await runtime.schemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(await tableColumns(runtime, "runner_sessions")).toEqual([
        "session_id",
        "runner_id",
        "certificate_fingerprint",
        "capabilities_json",
        "protocol_major",
        "created_at",
        "closed_at",
      ]);
      expect(await tableColumns(runtime, "runner_resume_tokens")).toEqual([
        "token_hash",
        "runner_id",
        "certificate_fingerprint",
        "previous_session_id",
        "protocol_major",
        "expires_at",
        "consumed_at",
      ]);
      expect(await tableColumns(runtime, "execution_leases")).toEqual([
        "run_id",
        "job_id",
        "runner_id",
        "session_id",
        "lease_epoch",
        "job_json",
        "lease_token_hash",
        "expires_at",
        "lost_at",
        "completed_at",
        "recovery_of_run_id",
      ]);
      expect(await tableColumns(runtime, "execution_completions")).toEqual([
        "run_id",
        "job_id",
        "completion_json",
        "completed_at",
      ]);
      expect(await columnNames(runtime)).not.toEqual(
        expect.arrayContaining(["lease_token", "resume_token", "token"]),
      );
      expect(await indexSql(runtime, "runner_sessions_active_runner_id")).toMatch(
        /runner_sessions"?\s*\(\s*"?runner_id"?\s*\).*closed_at IS NULL/is,
      );
      expect(await indexSql(runtime, "runner_resume_tokens_unconsumed_expiry")).toMatch(
        /runner_resume_tokens"?\s*\(\s*"?expires_at"?\s*\).*consumed_at IS NULL/is,
      );
    } finally {
      await runtime.close();
    }
  });

  it("marks every table except schema_migrations as tenant-owned", () => {
    const tenantOwned = new Set(tenantOwnedTableNames());
    for (const table of RELATIONAL_TABLES) {
      if (table.name === "schema_migrations") {
        expect(tenantOwned.has(table.name)).toBe(false);
      } else {
        expect(tenantOwned.has(table.name)).toBe(true);
      }
    }
  });

  it("selects the exact tenant tables present at an older persisted version", () => {
    expect(tenantOwnedTableNamesThroughVersion(1)).toEqual([
      "execution_runs",
      "trace_events",
      "findings",
      "artifact_manifests",
      "model_invocations",
    ]);
  });

  it("only references intra-tenant parents by tenant-owned foreign keys", () => {
    const byName = new Map(RELATIONAL_TABLES.map((table) => [table.name, table]));
    for (const table of RELATIONAL_TABLES) {
      for (const fk of table.foreignKeys) {
        const parent = byName.get(fk.references.table);
        expect(parent, `parent ${fk.references.table}`).toBeDefined();
        expect(table.tenantOwned).toBe(true);
        expect(parent?.tenantOwned).toBe(true);
      }
    }
  });
});

interface SqliteColumnInfo {
  readonly name: string;
}

interface SqliteIndexInfo {
  readonly name: string;
}

interface SqliteIndexList {
  readonly name: string;
  readonly unique: number;
}

async function tableColumns(
  runtime: SqliteRuntime,
  table: string,
): Promise<readonly string[]> {
  const result = await sql<SqliteColumnInfo>`PRAGMA table_info(${sql.raw(table)})`.execute(
    runtime.db,
  );
  return result.rows.map((row) => row.name);
}

async function columnNames(runtime: SqliteRuntime): Promise<readonly string[]> {
  const names: string[] = [];
  for (const table of [
    "runner_sessions",
    "runner_resume_tokens",
    "execution_leases",
    "execution_completions",
  ]) {
    names.push(...(await tableColumns(runtime, table)));
  }
  return names;
}

async function indexSql(runtime: SqliteRuntime, name: string): Promise<string> {
  const row = await runtime.db
    .selectFrom("sqlite_master")
    .select("sql")
    .where("type", "=", "index")
    .where("name", "=", name)
    .executeTakeFirst();
  expect(row?.sql, `index ${name}`).toEqual(expect.any(String));
  return row?.sql ?? "";
}

async function indexColumns(runtime: SqliteRuntime, name: string): Promise<readonly string[]> {
  const result = await sql<SqliteIndexInfo>`PRAGMA index_info(${sql.raw(name)})`.execute(runtime.db);
  return result.rows.map((row) => row.name);
}

async function indexIsUnique(runtime: SqliteRuntime, name: string): Promise<boolean> {
  const result = await sql<SqliteIndexList>`PRAGMA index_list(mission_dispatch_outbox)`.execute(runtime.db);
  return result.rows.find((row) => row.name === name)?.unique === 1;
}

function normalizeSql(statement: string): string {
  return statement.replace(/\s+/g, " ").trim().toLowerCase();
}
