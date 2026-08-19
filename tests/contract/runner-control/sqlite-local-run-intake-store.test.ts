import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteLocalRunIntakeStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import { assertLocalRunIntakeStore, localJob } from "./local-run-intake-store.contract.js";

describe("SqliteLocalRunIntakeStore", () => {
  it("atomically persists intake, retries, and survives reopen", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-local-intake-"));
    const filename = join(directory, "qualigence.db");
    let runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    try {
      await assertLocalRunIntakeStore(new SqliteLocalRunIntakeStore(runtime, { retryBaseMs: 1_000, retryMaximumMs: 60_000, maximumAttempts: 8 }));
      await runtime.close();
      runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000, openMode: "require-current" });
      await expect(new SqliteLocalRunIntakeStore(runtime, { retryBaseMs: 1_000, retryMaximumMs: 60_000, maximumAttempts: 8 }).run(localJob.runId)).resolves.toMatchObject({ completionAttempt: 1 });
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects invalid constructor policy", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-local-intake-policy-"));
    const runtime = await SqliteRuntime.open({ filename: join(directory, "db.sqlite"), busyTimeoutMs: 5_000 });
    try { expect(() => new SqliteLocalRunIntakeStore(runtime, { retryBaseMs: 0, retryMaximumMs: 1, maximumAttempts: 1 })).toThrow(); }
    finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
