import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteLocalReadinessProbe, SqliteRuntime } from "@qualigence/sqlite-runtime";

describe("SqliteLocalReadinessProbe", () => {
  it("proves a rollback-capable write without leaving rows", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-local-ready-"));
    const runtime = await SqliteRuntime.open({ filename: join(directory, "db.sqlite"), busyTimeoutMs: 5_000 });
    try { await expect(new SqliteLocalReadinessProbe(runtime).probe()).resolves.toBeUndefined(); expect(await runtime.db.selectFrom("execution_runs").select("run_id").execute()).toEqual([]); }
    finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
