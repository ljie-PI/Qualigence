import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
} from "@qualigence/runner-protocol";
import type {
  HashedResumeTokenRecord,
  PersistedExecutionLease,
  PersistedRunnerSession,
  ResumePresentedIdentity,
  RotateResumeTokenInput,
  RunnerControlStore,
} from "@qualigence/runner-control";

export interface RunnerControlStoreContractHarness {
  runPrimary<T>(operation: (store: RunnerControlStore) => Promise<T>): Promise<T>;
  runConcurrent<T>(operation: (store: RunnerControlStore) => Promise<T>): Promise<T>;
  reopen(): Promise<void>;
  close(): Promise<void>;
}

const CREATED_AT = "2026-08-18T00:00:00.000Z";
const EXPIRES_AT = "2026-08-18T00:01:00.000Z";
const CHECKED_AT = "2026-08-18T00:00:30.000Z";
const AFTER_EXPIRY = "2026-08-18T00:01:00.001Z";

function session(
  sessionId = "session-1",
  runnerId = "runner-1",
): PersistedRunnerSession {
  return {
    sessionId,
    runnerId,
    certificateFingerprint: `fp-${runnerId}`,
    capabilities: ["target:web-playwright"],
    protocolMajor: 1,
    createdAt: CREATED_AT,
  };
}

function job(runId = "run-1", jobId = `job-${runId}`): AcceptedExecutionJob {
  return {
    jobId,
    runId,
    target: { kind: "web", url: "https://example.test/" },
    objective: "persist runner ownership",
    policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: CREATED_AT, expiresAt: EXPIRES_AT },
  };
}

function lease(
  runId = "run-1",
  owner = { runnerId: "runner-1", sessionId: "session-1" },
): PersistedExecutionLease {
  return {
    job: job(runId),
    owner,
    leaseEpoch: 1,
    leaseTokenHash: `hash-lease-${runId}`,
    expiresAt: EXPIRES_AT,
  };
}

function resume(tokenHash = "hash-resume-1"): HashedResumeTokenRecord {
  return {
    tokenHash,
    binding: {
      runnerId: "runner-1",
      certificateFingerprint: "fp-runner-1",
      previousSessionId: "session-1",
      protocolMajor: 1,
    },
    expiresAt: "2026-08-18T00:05:00.000Z",
  };
}

function presented(
  overrides: Partial<ResumePresentedIdentity> = {},
): ResumePresentedIdentity {
  return {
    runnerId: "runner-1",
    certificateFingerprint: "fp-runner-1",
    protocolMajor: 1,
    ...overrides,
  };
}

function passed(runId = "run-1"): ExecutionCompletion {
  return { jobId: `job-${runId}`, runId, status: "passed" };
}

function rotatedInput(overrides: Partial<RotateResumeTokenInput> = {}): RotateResumeTokenInput {
  return {
    presentedTokenHash: "hash-resume-1",
    replacementTokenHash: "hash-resume-1-replacement",
    replacementExpiresAt: "2026-08-18T00:06:00.000Z",
    presented: presented(),
    rotatedAt: CHECKED_AT,
    ...overrides,
  };
}

export function runnerControlStoreContract(
  name: string,
  createHarness: () => Promise<RunnerControlStoreContractHarness>,
): void {
  describe(`RunnerControlStore contract (${name})`, () => {
    let harness: RunnerControlStoreContractHarness | undefined;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness?.close();
    });

    it("round-trips a session, hashed resume token, lease, and completion", async () => {
      const stored = await harness!.runPrimary(async (store) => {
        await store.saveSession(session());
        await store.issueResumeToken(resume());
        expect(await store.grantLease(lease())).toBe("granted");
        expect(
          await store.completeLease({
            runId: "run-1",
            jobId: "job-run-1",
            owner: { runnerId: "runner-1", sessionId: "session-1" },
            leaseEpoch: 1,
            leaseTokenHash: "hash-lease-run-1",
            checkedAt: CHECKED_AT,
            completion: passed(),
          }),
        ).toEqual({ outcome: "completed" });
        return {
          lease: await store.lease("run-1"),
          completion: await store.completion("run-1"),
        };
      });

      expect(stored.lease).toMatchObject({
        job: job(),
        owner: { runnerId: "runner-1", sessionId: "session-1" },
        leaseEpoch: 1,
        leaseTokenHash: "hash-lease-run-1",
        expiresAt: EXPIRES_AT,
        completedAt: CHECKED_AT,
      });
      expect(stored.completion).toEqual(passed());
      expect(canonicalPayloadHash(stored.completion)).toBe(canonicalPayloadHash(passed()));
    });

    it("consumes a resume token once under two concurrent callers", async () => {
      await harness!.runPrimary((store) => store.issueResumeToken(resume()));

      const [first, second] = await Promise.all([
        harness!.runPrimary((store) =>
          store.consumeResumeToken({
            tokenHash: "hash-resume-1",
            presented: presented(),
            consumedAt: CHECKED_AT,
          }),
        ),
        harness!.runConcurrent((store) =>
          store.consumeResumeToken({
            tokenHash: "hash-resume-1",
            presented: presented(),
            consumedAt: CHECKED_AT,
          }),
        ),
      ]);

      const bindings = [first, second].filter((value) => value !== undefined);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toEqual(resume().binding);
    });

    it("rejects a resume token presented by a different runner identity without consuming it", async () => {
      const binding = await harness!.runPrimary(async (store) => {
        await store.issueResumeToken(resume());
        const mismatch = await store.consumeResumeToken({
          tokenHash: "hash-resume-1",
          presented: presented({ runnerId: "runner-2" }),
          consumedAt: CHECKED_AT,
        });
        expect(mismatch).toBeUndefined();
        // A mismatched presentation never destroys the credential: the rightful
        // identity can still consume it exactly once.
        const rightful = await store.consumeResumeToken({
          tokenHash: "hash-resume-1",
          presented: presented(),
          consumedAt: CHECKED_AT,
        });
        expect(rightful).toEqual(resume().binding);
        return store.consumeResumeToken({
          tokenHash: "hash-resume-1",
          presented: presented(),
          consumedAt: CHECKED_AT,
        });
      });
      expect(binding).toBeUndefined();
    });

    it("rotates a resume token once and replays the redemption idempotently", async () => {
      await harness!.runPrimary((store) => store.issueResumeToken(resume()));

      const first = await harness!.runPrimary((store) =>
        store.rotateResumeToken(rotatedInput()),
      );
      const replay = await harness!.runPrimary((store) =>
        store.rotateResumeToken(rotatedInput()),
      );

      expect(first).toEqual({
        outcome: "rotated",
        binding: resume().binding,
      });
      expect(replay).toEqual({
        outcome: "idempotent_retry",
        binding: resume().binding,
      });
      const replacement = await harness!.runPrimary((store) =>
        store.consumeResumeToken({
          tokenHash: "hash-resume-1-replacement",
          presented: presented(),
          consumedAt: "2026-08-18T00:05:30.000Z",
        }),
      );
      expect(replacement?.previousSessionId).toBe("session-1");
    });

    it("rotates a token only once under two concurrent callers", async () => {
      await harness!.runPrimary((store) => store.issueResumeToken(resume()));

      const [first, second] = await Promise.all([
        harness!.runPrimary((store) => store.rotateResumeToken(rotatedInput())),
        harness!.runConcurrent((store) => store.rotateResumeToken(rotatedInput())),
      ]);

      const outcomes = [first?.outcome, second?.outcome].filter((value) => value !== undefined);
      expect(outcomes).toHaveLength(2);
      expect(outcomes.filter((value) => value === "rotated")).toHaveLength(1);
      expect(outcomes.filter((value) => value === "idempotent_retry")).toHaveLength(1);
      expect([first?.binding, second?.binding]).toContainEqual(resume().binding);
    });

    it("rejects a rotation replayed under a different identity or a plainly consumed token", async () => {
      await harness!.runPrimary((store) => store.issueResumeToken(resume()));

      const wrongIdentity = await harness!.runPrimary((store) =>
        store.rotateResumeToken(rotatedInput({ presented: presented({ runnerId: "runner-2" }) })),
      );
      expect(wrongIdentity).toBeUndefined();

      const token = "hash-resume-2";
      await harness!.runPrimary(async (store) => {
        await store.issueResumeToken(resume(token));
        await store.consumeResumeToken({
          tokenHash: token,
          presented: presented(),
          consumedAt: CHECKED_AT,
        });
      });
      const plainConsumed = await harness!.runPrimary((store) =>
        store.rotateResumeToken(
          rotatedInput({
            presentedTokenHash: token,
            replacementTokenHash: "hash-resume-2-replacement",
          }),
        ),
      );
      expect(plainConsumed).toBeUndefined();
    });

    it("refuses renew and complete for the wrong token, session, runner, or epoch", async () => {
      await harness!.runPrimary(async (store) => {
        expect(await store.grantLease(lease())).toBe("granted");
      });

      const denied = await harness!.runPrimary(async (store) => ({
        wrongToken: await store.renewLease({
          runId: "run-1",
          jobId: "job-run-1",
          owner: { runnerId: "runner-1", sessionId: "session-1" },
          leaseEpoch: 1,
          leaseTokenHash: "hash-lease-wrong",
          checkedAt: CHECKED_AT,
          newExpiresAt: "2026-08-18T00:02:00.000Z",
        }),
        wrongSession: await store.renewLease({
          runId: "run-1",
          jobId: "job-run-1",
          owner: { runnerId: "runner-1", sessionId: "session-other" },
          leaseEpoch: 1,
          leaseTokenHash: "hash-lease-run-1",
          checkedAt: CHECKED_AT,
          newExpiresAt: "2026-08-18T00:02:00.000Z",
        }),
        wrongRunner: await store.completeLease({
          runId: "run-1",
          jobId: "job-run-1",
          owner: { runnerId: "runner-2", sessionId: "session-1" },
          leaseEpoch: 1,
          leaseTokenHash: "hash-lease-run-1",
          checkedAt: CHECKED_AT,
          completion: passed(),
        }),
        wrongEpoch: await store.completeLease({
          runId: "run-1",
          jobId: "job-run-1",
          owner: { runnerId: "runner-1", sessionId: "session-1" },
          leaseEpoch: 2,
          leaseTokenHash: "hash-lease-run-1",
          checkedAt: CHECKED_AT,
          completion: passed(),
        }),
      }));

      expect(denied.wrongToken).toBe("rejected");
      expect(denied.wrongSession).toBe("rejected");
      expect(denied.wrongRunner).toEqual({ outcome: "rejected" });
      expect(denied.wrongEpoch).toEqual({ outcome: "rejected" });
    });

    it("marks an expired lease lost and never transfers the old runId", async () => {
      const result = await harness!.runPrimary(async (store) => {
        expect(await store.grantLease(lease())).toBe("granted");
        const renewed = await store.renewLease({
          runId: "run-1",
          jobId: "job-run-1",
          owner: { runnerId: "runner-1", sessionId: "session-1" },
          leaseEpoch: 1,
          leaseTokenHash: "hash-lease-run-1",
          checkedAt: AFTER_EXPIRY,
          newExpiresAt: "2026-08-18T00:02:00.000Z",
        });
        expect(await store.markLeaseLost("run-1", AFTER_EXPIRY)).toBe(true);
        const recovery = lease("run-2", { runnerId: "runner-2", sessionId: "session-2" });
        expect(
          await store.grantLease({ ...recovery, recoveryOfRunId: "run-1" }),
        ).toBe("granted");
        return {
          renewed,
          original: await store.lease("run-1"),
          recovered: await store.lease("run-2"),
        };
      });

      expect(result.renewed).toBe("rejected");
      expect(result.original?.lostAt).toBe(AFTER_EXPIRY);
      expect(result.original?.owner.runnerId).toBe("runner-1");
      expect(result.recovered?.job.runId).toBe("run-2");
      expect(result.recovered?.recoveryOfRunId).toBe("run-1");
      expect(result.recovered?.owner.runnerId).toBe("runner-2");
    });

    it("treats a canonical-equivalent completion as duplicate and rejects a different one", async () => {
      const outcomes = await harness!.runPrimary(async (store) => {
        expect(await store.grantLease(lease())).toBe("granted");
        const first = await store.completeLease({
          runId: "run-1",
          jobId: "job-run-1",
          owner: { runnerId: "runner-1", sessionId: "session-1" },
          leaseEpoch: 1,
          leaseTokenHash: "hash-lease-run-1",
          checkedAt: CHECKED_AT,
          completion: passed(),
        });
        const duplicate = await store.completeLease({
          runId: "run-1",
          jobId: "job-run-1",
          owner: { runnerId: "runner-1", sessionId: "session-1" },
          leaseEpoch: 1,
          leaseTokenHash: "hash-lease-run-1",
          checkedAt: CHECKED_AT,
          completion: passed(),
        });
        const rejected = await store.completeLease({
          runId: "run-1",
          jobId: "job-run-1",
          owner: { runnerId: "runner-1", sessionId: "session-1" },
          leaseEpoch: 1,
          leaseTokenHash: "hash-lease-run-1",
          checkedAt: CHECKED_AT,
          completion: { jobId: "job-run-1", runId: "run-1", status: "error", errorCode: "failed" },
        });
        return { first, duplicate, rejected, stored: await store.completion("run-1") };
      });

      expect(outcomes.first).toEqual({ outcome: "completed" });
      expect(outcomes.duplicate).toEqual({ outcome: "duplicate" });
      expect(outcomes.rejected).toEqual({
        outcome: "completion_conflict",
        storedCompletion: passed(),
      });
      expect(outcomes.stored).toEqual(passed());
    });

    it("allows only one concurrent completion transition and returns the atomic terminal result", async () => {
      await harness!.runPrimary(async (store) => {
        expect(await store.grantLease(lease())).toBe("granted");
      });

      const completion = passed();
      const [first, second] = await Promise.all([
        harness!.runPrimary((store) => complete(store, completion)),
        harness!.runConcurrent((store) => complete(store, completion)),
      ]);

      expect([first, second].filter((result) => result.outcome === "completed")).toHaveLength(1);
      expect([first, second].filter((result) => result.outcome === "duplicate")).toHaveLength(1);
      await expect(harness!.runPrimary((store) => store.completion("run-1"))).resolves.toEqual(completion);
    });

    it("returns the atomically observed winning completion to a competing conflict", async () => {
      await harness!.runPrimary(async (store) => {
        expect(await store.grantLease(lease())).toBe("granted");
      });

      const completions: readonly [ExecutionCompletion, ExecutionCompletion] = [
        passed(),
        { jobId: "job-run-1", runId: "run-1", status: "error", errorCode: "failed" } as const,
      ];
      const [first, second] = await Promise.all([
        harness!.runPrimary((store) => complete(store, completions[0])),
        harness!.runConcurrent((store) => complete(store, completions[1])),
      ]);
      const outcomes = [first, second];
      const winnerIndex = outcomes.findIndex((result) => result.outcome === "completed");
      const conflict = outcomes.find((result) => result.outcome === "completion_conflict");

      expect(winnerIndex).not.toBe(-1);
      expect(conflict).toEqual({
        outcome: "completion_conflict",
        storedCompletion: completions[winnerIndex],
      });
      await expect(harness!.runPrimary((store) => store.completion("run-1"))).resolves.toEqual(
        completions[winnerIndex],
      );
    });

    it("never marks a completed lease lost", async () => {
      const stored = await harness!.runPrimary(async (store) => {
        expect(await store.grantLease(lease())).toBe("granted");
        expect(await complete(store, passed())).toEqual({ outcome: "completed" });
        expect(await store.markLeaseLost("run-1", AFTER_EXPIRY)).toBe(false);
        return store.lease("run-1");
      });

      expect(stored).toMatchObject({ completedAt: CHECKED_AT });
      expect(stored?.lostAt).toBeUndefined();
    });

    it("never classifies a completion from an unbound owner as duplicate", async () => {
      const outcomes = await harness!.runPrimary(async (store) => {
        expect(await store.grantLease(lease())).toBe("granted");
        expect(
          await store.completeLease({
            runId: "run-1",
            jobId: "job-run-1",
            owner: { runnerId: "runner-1", sessionId: "session-1" },
            leaseEpoch: 1,
            leaseTokenHash: "hash-lease-run-1",
            checkedAt: CHECKED_AT,
            completion: passed(),
          }),
        ).toEqual({ outcome: "completed" });
        // A different runner replaying the exact terminal payload is not a
        // duplicate: the static lease binding must be verified first.
        return store.completeLease({
          runId: "run-1",
          jobId: "job-run-1",
          owner: { runnerId: "runner-2", sessionId: "session-2" },
          leaseEpoch: 1,
          leaseTokenHash: "hash-lease-run-1",
          checkedAt: CHECKED_AT,
          completion: passed(),
        });
      });
      expect(outcomes).toEqual({ outcome: "rejected" });
    });

    it("preserves active ownership after a process restart against the same database", async () => {
      await harness!.runPrimary(async (store) => {
        await store.saveSession(session());
        expect(await store.grantLease(lease())).toBe("granted");
      });

      await harness!.reopen();

      const restored = await harness!.runPrimary((store) => store.lease("run-1"));
      expect(restored?.owner).toEqual({ runnerId: "runner-1", sessionId: "session-1" });
      expect(restored?.leaseTokenHash).toBe("hash-lease-run-1");
      expect(restored?.lostAt).toBeUndefined();
      expect(restored?.completedAt).toBeUndefined();
    });

    it("does not re-grant an existing runId", async () => {
      const second = await harness!.runPrimary(async (store) => {
        expect(await store.grantLease(lease())).toBe("granted");
        return store.grantLease({
          ...lease(),
          owner: { runnerId: "runner-2", sessionId: "session-2" },
          leaseTokenHash: "hash-lease-other",
        });
      });
      expect(second).toBe("already_exists");
      const stored = await harness!.runPrimary((store) => store.lease("run-1"));
      expect(stored?.owner.runnerId).toBe("runner-1");
    });
  });
}

function complete(store: RunnerControlStore, completion: ExecutionCompletion) {
  return store.completeLease({
    runId: "run-1",
    jobId: "job-run-1",
    owner: { runnerId: "runner-1", sessionId: "session-1" },
    leaseEpoch: 1,
    leaseTokenHash: "hash-lease-run-1",
    checkedAt: CHECKED_AT,
    completion,
  });
}
