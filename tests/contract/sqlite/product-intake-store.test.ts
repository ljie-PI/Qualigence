import { describe, expect, it } from "vitest";
import { createTargetRevision } from "@qualigence/project-target";
import { SqliteProjectTargetStore, SqliteRuntime, SqliteTestPlanStore } from "@qualigence/sqlite-runtime";
import { createDraftTestPlan } from "@qualigence/mission";
import { sequentialIds, validatedProposal } from "../../unit/core-modules/mission/fixtures.js";

describe("SQLite product intake repositories", () => {
  it("appends immutable Target revisions and preserves old snapshots", async () => {
    const runtime = await SqliteRuntime.open({ filename: ":memory:", busyTimeoutMs: 1000 });
    try {
      const store = new SqliteProjectTargetStore(runtime);
      const first = createTargetRevision({ targetId: "target-1", projectId: "project-1", displayName: "Web", runnerId: "runner-1", expectedVersion: 0, configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } });
      await store.saveRevision({ revision: first, expectedVersion: 0, idempotencyKey: "target-create", createdAt: "2026-08-21T00:00:00.000Z" });
      const second = createTargetRevision({ targetId: "target-1", projectId: "project-1", displayName: "Web v2", runnerId: "runner-1", expectedVersion: 1, configuration: { kind: "web", startUrl: "https://example.test/v2", allowedOrigins: ["https://example.test"], browser: "chromium" } });
      await store.saveRevision({ revision: second, expectedVersion: 1, idempotencyKey: "target-update", createdAt: "2026-08-21T00:01:00.000Z" });
      expect((await store.getRevision("target-1", 1))?.snapshotHash).toBe(first.snapshotHash);
      expect((await store.getRevision("target-1"))?.version).toBe(2);
      await expect(store.saveRevision({ revision: second, expectedVersion: 0, idempotencyKey: "stale", createdAt: "2026-08-21T00:02:00.000Z" })).rejects.toMatchObject({ code: "TargetVersionConflict", currentVersion: 2 });
    } finally { await runtime.close(); }
  });

  it("persists draft and approved Test Plan as distinct versions", async () => {
    const runtime = await SqliteRuntime.open({ filename: ":memory:", busyTimeoutMs: 1000 });
    try {
      const store = new SqliteTestPlanStore(runtime);
      const created = createDraftTestPlan({ projectId: "project-1", prdId: "prd-1", prdRevision: 1, proposal: validatedProposal() }, sequentialIds());
      if (!created.ok) throw new Error(created.error.code);
      await store.saveDraft({ plan: created.value, idempotencyKey: "plan-create", createdAt: "2026-08-21T00:00:00.000Z" });
      const approved = await store.approve({ planId: created.value.planId, expectedVersion: 1, reviewerId: "tester-1", idempotencyKey: "plan-approve", clock: { now: () => "2026-08-21T00:01:00.000Z" } });
      expect(approved).toMatchObject({ status: "approved", version: 2 });
      expect(await store.get(created.value.planId, 1)).toMatchObject({ status: "draft", version: 1 });
      expect(await store.get(created.value.planId)).toMatchObject({ status: "approved", version: 2 });
    } finally { await runtime.close(); }
  });
});
