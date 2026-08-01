import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRuntime, SUPPORTED_SCHEMA_VERSION } from "@qualigence/sqlite-runtime";
import {
  relationalTableNames,
  tenantOwnedTableNames,
  RELATIONAL_TABLES,
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
    expect(SUPPORTED_SCHEMA_VERSION).toBe(5);
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
