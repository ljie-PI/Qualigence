import { describe, expect, it } from "vitest";
import type { IntelligenceJob, IntelligenceResult } from "../../../packages/core-modules/intelligence/src/contracts.js";
import { WorkerLoop, type Clock } from "../../../apps/intelligence-worker/src/worker-loop.js";
import type {
  IntelligenceJobLease,
  IntelligenceJobStore,
  IntelligenceResultInbox,
} from "../../../packages/core-application/src/intelligence/intelligence-queue-contracts.js";

const job: IntelligenceJob = {
  jobId: "job-renew-1",
  jobType: "investigation.reproduction-planning",
  schemaVersion: "intelligence-job/v1",
  tenantId: "tenant-a",
  projectId: "project-a",
  aggregateRef: { type: "investigation.case", id: "case-renew-1" },
  baseAggregateVersion: 3,
  inputRefs: [],
  modelProfileId: "profile-a",
  dataPolicyId: "policy-a",
  budget: { maximumTokens: 100, maximumCostMicros: 1000, timeoutMs: 60_000 },
  priority: "normal",
  idempotencyKey: "job-key-renew-1",
  causationId: "cause-renew-1",
  expectedResultSchema: "investigation-result/v1",
};

const result: IntelligenceResult = {
  jobId: job.jobId,
  resultSchemaVersion: "intelligence-result/v1",
  proposals: [{ summary: "proposal only" }],
  evidenceRefs: [],
  confidence: 0.8,
  provenance: ["unit-test"],
  usage: { inputTokens: 10, outputTokens: 4, costMicros: 25 },
  terminalStatus: "succeeded",
  idempotencyKey: "result-key-renew-1",
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("WorkerLoop lease renewal", () => {
  it("renews a held lease before one third of the lease window elapses while processing", async () => {
    const initialLease: IntelligenceJobLease = {
      jobId: job.jobId,
      leaseToken: "lease-token-renew-1",
      workerId: "worker-a",
      expiresAt: "2026-08-25T00:01:30.000Z",
      attempt: 2,
    };
    const renewedLease: IntelligenceJobLease = {
      ...initialLease,
      expiresAt: "2026-08-25T00:02:00.000Z",
    };
    const firstRenewalStarted = deferred<void>();
    const allowFirstSleep = deferred<void>();
    const appendCalled = deferred<void>();
    const sleeps: number[] = [];
    const renewals: unknown[] = [];

    const clock: Clock = {
      now: () => "2026-08-25T00:00:30.000Z",
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        firstRenewalStarted.resolve();
        await allowFirstSleep.promise;
        if (signal?.aborted === true) return;
      },
    };

    const store: IntelligenceJobStore = {
      lease: async () => ({ job, lease: initialLease }),
      renew: async (input) => {
        renewals.push(input);
        return renewedLease;
      },
      abandon: async () => {
        throw new Error("abandon should not be called");
      },
    };
    const inbox: IntelligenceResultInbox = {
      append: async (input) => {
        expect(input.leaseToken).toBe(renewedLease.leaseToken);
        expect(input.leaseAttempt).toBe(renewedLease.attempt);
        appendCalled.resolve();
        return { disposition: "accepted" };
      },
    };

    const loop = new WorkerLoop({
      store,
      inbox,
      processor: {
        process: async () => {
          await firstRenewalStarted.promise;
          allowFirstSleep.resolve();
          while (renewals.length === 0) {
            await Promise.resolve();
          }
          return result;
        },
      },
      workerId: "worker-a",
      acceptedTypes: ["investigation.reproduction-planning"],
      leaseDurationMs: 90_000,
      idleBackoffMs: 5,
      clock,
    });

    await expect(loop.runOnce()).resolves.toBe("processed");
    await appendCalled.promise;
    expect(sleeps[0]).toBeLessThanOrEqual(30_000);
    expect(renewals).toEqual([
      {
        jobId: job.jobId,
        leaseToken: initialLease.leaseToken,
        workerId: "worker-a",
        now: "2026-08-25T00:00:30.000Z",
        leaseDurationMs: 90_000,
      },
    ]);
  });

  it("honors abort before model processing and releases the fenced lease without appending", async () => {
    const lease: IntelligenceJobLease = {
      jobId: job.jobId,
      leaseToken: "lease-token-abort-before-model",
      workerId: "worker-a",
      expiresAt: "2026-08-25T00:01:00.000Z",
      attempt: 1,
    };
    const controller = new AbortController();
    const abandoned: unknown[] = [];
    let processed = false;
    let appended = false;

    const store: IntelligenceJobStore = {
      lease: async () => {
        controller.abort();
        return { job, lease };
      },
      renew: async () => lease,
      abandon: async (input) => {
        abandoned.push(input);
        return { disposition: "released" };
      },
    };
    const inbox: IntelligenceResultInbox = {
      append: async () => {
        appended = true;
        return { disposition: "accepted" };
      },
    };

    const loop = new WorkerLoop({
      store,
      inbox,
      processor: {
        process: async () => {
          processed = true;
          return result;
        },
      },
      workerId: "worker-a",
      acceptedTypes: ["investigation.reproduction-planning"],
      leaseDurationMs: 60_000,
      idleBackoffMs: 5,
      clock: { now: () => "2026-08-25T00:00:00.000Z", sleep: async () => {} },
    });

    await expect(loop.runOnce(controller.signal)).resolves.toBe("aborted");
    expect(processed).toBe(false);
    expect(appended).toBe(false);
    expect(abandoned).toEqual([
      {
        tenantId: job.tenantId,
        jobId: job.jobId,
        leaseToken: lease.leaseToken,
        leaseAttempt: lease.attempt,
        workerId: "worker-a",
      },
    ]);
  });

  it("honors abort before append and does not report success", async () => {
    const lease: IntelligenceJobLease = {
      jobId: job.jobId,
      leaseToken: "lease-token-abort-before-append",
      workerId: "worker-a",
      expiresAt: "2026-08-25T00:01:00.000Z",
      attempt: 1,
    };
    const controller = new AbortController();
    let appended = false;
    const abandoned: unknown[] = [];
    const signals: (AbortSignal | undefined)[] = [];

    const store: IntelligenceJobStore = {
      lease: async () => ({ job, lease }),
      renew: async () => lease,
      abandon: async (input) => {
        abandoned.push(input);
        return { disposition: "released" };
      },
    };
    const inbox: IntelligenceResultInbox = {
      append: async () => {
        appended = true;
        return { disposition: "accepted" };
      },
    };

    const loop = new WorkerLoop({
      store,
      inbox,
      processor: {
        process: async (_job, signal) => {
          signals.push(signal);
          controller.abort();
          return result;
        },
      },
      workerId: "worker-a",
      acceptedTypes: ["investigation.reproduction-planning"],
      leaseDurationMs: 60_000,
      idleBackoffMs: 5,
      clock: { now: () => "2026-08-25T00:00:00.000Z", sleep: async () => {} },
    });

    await expect(loop.runOnce(controller.signal)).resolves.toBe("aborted");
    expect(signals).toEqual([controller.signal]);
    expect(appended).toBe(false);
    expect(abandoned).toHaveLength(1);
  });
});
