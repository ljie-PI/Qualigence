import { expect } from "vitest";
import type { LocalRunIntakeStore } from "@qualigence/runner-control";

export const localJob = {
  jobId: "job-local-1", runId: "run-local-1", projectId: "local",
  target: { kind: "web" as const, url: "https://example.test/" }, objective: "verify local intake",
  policy: { policyId: "a".repeat(64), environment: "isolated_test" as const, allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"] as const, maximumRisk: "Normal" as const, explorationAllowed: false, issuedAt: "2026-08-19T00:00:00.000Z", expiresAt: "2026-08-19T00:01:00.000Z" },
};

export async function assertLocalRunIntakeStore(store: LocalRunIntakeStore): Promise<void> {
  const createdAt = "2026-08-19T00:00:00.000Z";
  await store.create({ job: localJob, createdAt });
  await expect(store.run(localJob.runId)).resolves.toMatchObject({ dispatchState: "pending_runner", completionState: "awaiting", completionAttempt: 0 });
  const [pending] = await store.pendingDispatches(1);
  expect(pending?.job).toEqual(localJob);
  expect(await store.beginOffer({ runId: localJob.runId, expectedAttempt: 0, startedAt: createdAt })).toBe(true);
  expect(await store.markOffered({ runId: localJob.runId, expectedAttempt: 0, offeredAt: createdAt })).toBe(true);
  const [completion] = await store.pendingCompletions({ now: createdAt, limit: 1 });
  expect(completion).toMatchObject({ runId: localJob.runId, expectedAttempt: 0 });
  expect(await store.recordCompletionFailure({ runId: localJob.runId, expectedAttempt: 0, errorCode: "CompletionPending", failedAt: createdAt })).toEqual({ status: "scheduled", attempt: 1, nextAttemptAt: "2026-08-19T00:00:01.000Z" });
  expect(await store.recordCompletionFailure({ runId: localJob.runId, expectedAttempt: 0, errorCode: "CompletionPending", failedAt: createdAt })).toEqual({ status: "stale" });
}
