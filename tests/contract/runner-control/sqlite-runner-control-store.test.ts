import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteRunnerControlStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import {
  runnerControlStoreContract,
  type RunnerControlStoreContractHarness,
} from "./runner-control-store.contract.js";

async function createHarness(): Promise<RunnerControlStoreContractHarness> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-runner-control-sqlite-"));
  const filename = join(directory, "qualigence.db");
  let primary = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
  let concurrent = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });

  return {
    runPrimary: (operation) => operation(new SqliteRunnerControlStore(primary)),
    runConcurrent: (operation) => operation(new SqliteRunnerControlStore(concurrent)),
    async reopen() {
      await concurrent.close();
      await primary.close();
      primary = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
      concurrent = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    },
    async close() {
      await concurrent.close();
      await primary.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

runnerControlStoreContract("SQLite", createHarness);

describe("SqliteRunnerControlStore persisted policy migration", () => {
  it("rejects a policyless persisted Job on read and renewal without changing expiry", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-policyless-sqlite-"));
    const runtime = await SqliteRuntime.open({ filename: join(directory, "qualigence.db"), busyTimeoutMs: 5_000 });
    const expiresAt = "2026-08-18T00:01:00.000Z";
    try {
      await runtime.db.insertInto("execution_leases").values({
        run_id: "run-policyless", job_id: "job-policyless", runner_id: "runner-1", session_id: "session-1",
        lease_epoch: 1, lease_token_hash: "token-hash", expires_at: expiresAt, lost_at: null, completed_at: null,
        recovery_of_run_id: null,
        job_json: JSON.stringify({ jobId: "job-policyless", runId: "run-policyless", target: { kind: "web", url: "https://example.test/" }, objective: "legacy" }),
      }).execute();
      const store = new SqliteRunnerControlStore(runtime);
      await expect(store.lease("run-policyless")).rejects.toMatchObject({ code: "PolicyMissing" });
      await expect(store.renewLease({ runId: "run-policyless", jobId: "job-policyless", owner: { runnerId: "runner-1", sessionId: "session-1" }, leaseEpoch: 1, leaseTokenHash: "token-hash", checkedAt: "2026-08-18T00:00:30.000Z", newExpiresAt: "2026-08-18T00:02:00.000Z" })).rejects.toMatchObject({ code: "PolicyMissing" });
      const row = await runtime.db.selectFrom("execution_leases").select("expires_at").where("run_id", "=", "run-policyless").executeTakeFirstOrThrow();
      expect(row.expires_at).toBe(expiresAt);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
