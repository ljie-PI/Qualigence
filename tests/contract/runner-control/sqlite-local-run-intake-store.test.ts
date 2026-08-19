import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteLocalRunIntakeStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
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

  it("persists the public completion integrity error without terminalizing the Run", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-local-intake-blocked-"));
    const runtime = await SqliteRuntime.open({ filename: join(directory, "db.sqlite"), busyTimeoutMs: 5_000 });
    try {
      const store = new SqliteLocalRunIntakeStore(runtime, { retryBaseMs: 1_000, retryMaximumMs: 60_000, maximumAttempts: 8 });
      await store.create({ job: localJob, createdAt: "2026-08-19T00:00:00.000Z" });
      await store.beginOffer({ runId: localJob.runId, expectedAttempt: 0, startedAt: "2026-08-19T00:00:00.000Z" });
      await store.markOffered({ runId: localJob.runId, expectedAttempt: 0, offeredAt: "2026-08-19T00:00:00.000Z" });
      expect(await store.applyCompletion({ runId: localJob.runId, expectedAttempt: 0, jobId: localJob.jobId, jobSha256: canonicalPayloadHash({ ...localJob, objective: "altered" }), completion: { jobId: localJob.jobId, runId: localJob.runId, status: "passed" }, completedAt: "2026-08-19T00:00:01.000Z" })).toBe("identity_mismatch");
      await store.markIntegrityBlocked({ runId: localJob.runId, expectedAttempt: 0, errorCode: "CompletionIdentityMismatch", blockedAt: "2026-08-19T00:00:01.000Z" });
      await expect(store.run(localJob.runId)).resolves.toMatchObject({ completionState: "integrity_blocked", completionErrorCode: "CompletionIdentityMismatch", runStatus: "running" });
      await expect(store.hasCompletionBlockers()).resolves.toBe(true);
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("reports retry exhaustion as a blocker after close and reopen", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-local-intake-restart-blocked-"));
    const filename = join(directory, "db.sqlite");
    let runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
    try {
      let store = new SqliteLocalRunIntakeStore(runtime, { retryBaseMs: 1, retryMaximumMs: 1, maximumAttempts: 1 });
      await store.create({ job: localJob, createdAt: "2026-08-19T00:00:00.000Z" });
      await store.beginOffer({ runId: localJob.runId, expectedAttempt: 0, startedAt: "2026-08-19T00:00:00.000Z" });
      await store.markOffered({ runId: localJob.runId, expectedAttempt: 0, offeredAt: "2026-08-19T00:00:00.000Z" });
      await expect(store.recordCompletionFailure({ runId: localJob.runId, expectedAttempt: 0, errorCode: "CompletionPending", failedAt: "2026-08-19T00:00:01.000Z" })).resolves.toEqual({ status: "blocked" });
      await runtime.close();
      runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000, openMode: "require-current" });
      store = new SqliteLocalRunIntakeStore(runtime, { retryBaseMs: 1, retryMaximumMs: 1, maximumAttempts: 1 });
      await expect(store.hasCompletionBlockers()).resolves.toBe(true);
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
