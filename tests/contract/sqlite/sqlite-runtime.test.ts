import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRuntime } from "@qualigence/sqlite-runtime";

let dir: string;
let filename: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), ".tmp-sqlite-"));
  filename = join(dir, "qualigence.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SqliteRuntime", () => {
  it("opens with required pragmas and reopens schema v1", async () => {
    const first = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    expect(await first.pragma("journal_mode")).toBe("wal");
    expect(await first.pragma("foreign_keys")).toBe(1);
    expect(await first.pragma("busy_timeout")).toBe(5_000);
    expect(await first.schemaVersion()).toBe(1);
    await first.close();

    const second = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    expect(await second.schemaVersion()).toBe(1);
    await second.close();
  });

  it("creates all six schema tables", async () => {
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    const rows = await runtime.db
      .selectFrom("sqlite_master")
      .select("name")
      .where("type", "=", "table")
      .execute();
    const names = new Set(rows.map((row) => row.name));
    for (const table of [
      "schema_migrations",
      "execution_runs",
      "trace_events",
      "findings",
      "artifact_manifests",
      "model_invocations",
    ]) {
      expect(names.has(table)).toBe(true);
    }
    await runtime.close();
  });

  it("is idempotent on repeated close", async () => {
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("rejects a database whose schema version is newer than supported", async () => {
    const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    await runtime.db
      .insertInto("schema_migrations")
      .values({
        version: 2,
        name: "future-migration",
        applied_at: "2026-08-01T00:00:00.000Z",
      })
      .execute();
    await runtime.close();

    await expect(
      SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "DatabaseVersionTooNew" });
  });
});
