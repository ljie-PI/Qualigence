import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaimReviewTaskHandler,
  ResolveReviewTaskHandler,
  ReviewTaskVersionConflict,
  openReviewTask,
  type ReviewTask,
  type ReviewTaskRepository,
} from "@qualigence/review";

export interface ReviewRepositoryContractHarness {
  runPrimary<T>(operation: (repository: ReviewTaskRepository) => Promise<T>): Promise<T>;
  runConcurrent<T>(operation: (repository: ReviewTaskRepository) => Promise<T>): Promise<T>;
  readClaimAudit(idempotencyKey: string): Promise<{
    readonly taskId: string;
    readonly reviewerId: string;
    readonly claimedVersion: number;
  } | undefined>;
  readResolutionAudit(idempotencyKey: string): Promise<{
    readonly taskId: string;
    readonly reviewerId: string;
    readonly disposition: string;
    readonly evidenceRefs: readonly string[];
    readonly resolvedVersion: number;
  } | undefined>;
  close(): Promise<void>;
}

function task(taskId: string): ReviewTask {
  return openReviewTask({
    taskId,
    caseId: `${taskId}:case`,
    reason: "needs_human",
    priority: "high",
    evidenceCompleteness: "limited",
  });
}

async function create(repository: ReviewTaskRepository, taskId: string): Promise<ReviewTask> {
  const reviewTask = task(taskId);
  await repository.create(reviewTask);
  return reviewTask;
}

export function reviewTaskRepositoryContract(
  name: string,
  createHarness: () => Promise<ReviewRepositoryContractHarness>,
): void {
  describe(`ReviewTaskRepository contract (${name})`, () => {
    let harness: ReviewRepositoryContractHarness | undefined;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness?.close();
    });

    it("round-trips every aggregate field", async () => {
      const input: ReviewTask = {
        ...task("round-trip"),
        status: "resolved",
        assigneeId: "alice",
        version: 3,
      };

      const found = await harness!.runPrimary(async (repository) => {
        await repository.create(input);
        return repository.find(input.taskId);
      });

      expect(found).toEqual(input);
    });

    it("claims an open task once and writes the matching audit", async () => {
      const claimed = await harness!.runPrimary(async (repository) => {
        await create(repository, "claim-once");
        return new ClaimReviewTaskHandler(repository).handle({
          taskId: "claim-once",
          expectedVersion: 1,
          reviewerId: "alice",
          idempotencyKey: "claim-once-key",
        });
      });

      expect(claimed).toEqual({
        ...task("claim-once"),
        status: "claimed",
        assigneeId: "alice",
        version: 2,
      });
      await expect(harness!.readClaimAudit("claim-once-key")).resolves.toEqual({
        taskId: "claim-once",
        reviewerId: "alice",
        claimedVersion: 2,
      });
    });

    it("replays the same claim idempotency key without another version increment", async () => {
      const result = await harness!.runPrimary(async (repository) => {
        await create(repository, "claim-replay");
        const command = {
          taskId: "claim-replay",
          expectedVersion: 1,
          reviewerId: "alice",
          idempotencyKey: "claim-replay-key",
        };
        const first = await repository.claim(command);
        const replay = await repository.claim(command);
        return { first, replay, persisted: await repository.find(command.taskId) };
      });

      expect(result.first).toEqual(result.replay);
      expect(result.persisted).toMatchObject({ status: "claimed", version: 2 });
    });

    it("does not replay a claim idempotency key onto a different task", async () => {
      const result = await harness!.runPrimary(async (repository) => {
        await create(repository, "claim-first");
        await create(repository, "claim-second");
        await repository.claim({
          taskId: "claim-first",
          expectedVersion: 1,
          reviewerId: "alice",
          idempotencyKey: "shared-claim-key",
        });
        const wrongTaskReplay = await repository.claim({
          taskId: "claim-second",
          expectedVersion: 1,
          reviewerId: "bob",
          idempotencyKey: "shared-claim-key",
        });
        return { wrongTaskReplay, second: await repository.find("claim-second") };
      });

      expect(result.wrongTaskReplay).toBeUndefined();
      expect(result.second).toEqual(task("claim-second"));
    });

    it("resolves only the claimed current assignee and records its audit", async () => {
      const resolved = await harness!.runPrimary(async (repository) => {
        await create(repository, "resolve-once");
        await repository.claim({
          taskId: "resolve-once",
          expectedVersion: 1,
          reviewerId: "alice",
          idempotencyKey: "resolve-once-claim-key",
        });
        return new ResolveReviewTaskHandler(repository).handle({
          taskId: "resolve-once",
          expectedVersion: 2,
          reviewerId: "alice",
          disposition: "accepted",
          evidenceRefs: ["evidence-a", "evidence-b"],
          idempotencyKey: "resolve-once-key",
        });
      });

      expect(resolved).toMatchObject({ status: "resolved", assigneeId: "alice", version: 3 });
      await expect(harness!.readResolutionAudit("resolve-once-key")).resolves.toEqual({
        taskId: "resolve-once",
        reviewerId: "alice",
        disposition: "accepted",
        evidenceRefs: ["evidence-a", "evidence-b"],
        resolvedVersion: 3,
      });
    });

    it("replays the same resolution idempotency key without another version increment", async () => {
      const result = await harness!.runPrimary(async (repository) => {
        await create(repository, "resolve-replay");
        await repository.claim({
          taskId: "resolve-replay",
          expectedVersion: 1,
          reviewerId: "alice",
          idempotencyKey: "resolve-replay-claim-key",
        });
        const command = {
          taskId: "resolve-replay",
          expectedVersion: 2,
          reviewerId: "alice",
          disposition: "accepted",
          evidenceRefs: ["evidence-a"],
          idempotencyKey: "resolve-replay-key",
        };
        const first = await repository.resolve(command);
        const replay = await repository.resolve(command);
        return { first, replay, persisted: await repository.find(command.taskId) };
      });

      expect(result.first).toEqual(result.replay);
      expect(result.persisted).toMatchObject({ status: "resolved", version: 3 });
    });

    it("does not replay a resolution idempotency key onto a different task", async () => {
      const result = await harness!.runPrimary(async (repository) => {
        await create(repository, "resolve-first");
        await create(repository, "resolve-second");
        for (const taskId of ["resolve-first", "resolve-second"]) {
          await repository.claim({
            taskId,
            expectedVersion: 1,
            reviewerId: "alice",
            idempotencyKey: `${taskId}-claim-key`,
          });
        }
        await repository.resolve({
          taskId: "resolve-first",
          expectedVersion: 2,
          reviewerId: "alice",
          disposition: "accepted",
          evidenceRefs: ["evidence-a"],
          idempotencyKey: "shared-resolution-key",
        });
        const wrongTaskReplay = await repository.resolve({
          taskId: "resolve-second",
          expectedVersion: 2,
          reviewerId: "alice",
          disposition: "rejected",
          evidenceRefs: ["evidence-b"],
          idempotencyKey: "shared-resolution-key",
        });
        return { wrongTaskReplay, second: await repository.find("resolve-second") };
      });

      expect(result.wrongTaskReplay).toBeUndefined();
      expect(result.second).toMatchObject({ status: "claimed", version: 2, assigneeId: "alice" });
    });

    it("leaves stale, open-task, and non-assignee resolution attempts unchanged", async () => {
      const result = await harness!.runPrimary(async (repository) => {
        await create(repository, "resolve-guarded");
        const openTaskAttempt = await repository.resolve({
          taskId: "resolve-guarded",
          expectedVersion: 1,
          reviewerId: "alice",
          disposition: "accepted",
          evidenceRefs: [],
          idempotencyKey: "open-resolution-key",
        });
        await repository.claim({
          taskId: "resolve-guarded",
          expectedVersion: 1,
          reviewerId: "alice",
          idempotencyKey: "resolve-guarded-claim-key",
        });
        const staleAttempt = await repository.resolve({
          taskId: "resolve-guarded",
          expectedVersion: 1,
          reviewerId: "alice",
          disposition: "accepted",
          evidenceRefs: [],
          idempotencyKey: "stale-resolution-key",
        });
        const nonAssigneeAttempt = await repository.resolve({
          taskId: "resolve-guarded",
          expectedVersion: 2,
          reviewerId: "bob",
          disposition: "accepted",
          evidenceRefs: [],
          idempotencyKey: "non-assignee-resolution-key",
        });
        return {
          openTaskAttempt,
          staleAttempt,
          nonAssigneeAttempt,
          persisted: await repository.find("resolve-guarded"),
        };
      });

      expect(result.openTaskAttempt).toBeUndefined();
      expect(result.staleAttempt).toBeUndefined();
      expect(result.nonAssigneeAttempt).toBeUndefined();
      expect(result.persisted).toMatchObject({ status: "claimed", version: 2, assigneeId: "alice" });
      await expect(harness!.readResolutionAudit("open-resolution-key")).resolves.toBeUndefined();
      await expect(harness!.readResolutionAudit("stale-resolution-key")).resolves.toBeUndefined();
      await expect(harness!.readResolutionAudit("non-assignee-resolution-key")).resolves.toBeUndefined();
    });

    it("allows exactly one same-version claimant across independent runners", async () => {
      await harness!.runPrimary((repository) => create(repository, "concurrent-claim"));
      const outcomes = await Promise.allSettled([
        harness!.runPrimary((repository) =>
          new ClaimReviewTaskHandler(repository).handle({
            taskId: "concurrent-claim",
            expectedVersion: 1,
            reviewerId: "alice",
            idempotencyKey: "concurrent-alice-key",
          }),
        ),
        harness!.runConcurrent((repository) =>
          new ClaimReviewTaskHandler(repository).handle({
            taskId: "concurrent-claim",
            expectedVersion: 1,
            reviewerId: "bob",
            idempotencyKey: "concurrent-bob-key",
          }),
        ),
      ]);

      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<ReviewTask> => outcome.status === "fulfilled",
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ReviewTaskVersionConflict);

      const persisted = await harness!.runPrimary((repository) => repository.find("concurrent-claim"));
      expect(persisted).toMatchObject({
        status: "claimed",
        version: 2,
        assigneeId: fulfilled[0]?.value.assigneeId,
      });
    });
  });
}
