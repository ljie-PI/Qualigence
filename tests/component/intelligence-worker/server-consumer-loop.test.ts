import { describe, expect, it } from "vitest";
import type { ConsumeSummary } from "@qualigence/core-application";
import type {
  CompleteIntelligenceResultWakeupDisposition,
  CompleteIntelligenceResultWakeupInput,
  IntelligenceResultWakeupClaim,
  IntelligenceResultWakeupStore,
  RetryIntelligenceResultWakeupDisposition,
  RetryIntelligenceResultWakeupInput,
} from "@qualigence/postgres-runtime";
import { IntelligenceResultConsumerLoop } from "../../../apps/server/src/intelligence-result-consumer-loop.js";

const emptySummary: ConsumeSummary = {
  applied: 0,
  duplicate: 0,
  recompute: 0,
  rejected: 0,
  processed: 0,
  hasMore: false,
  dispositions: [],
};

class FakeWakeups implements IntelligenceResultWakeupStore {
  readonly claimInputs: unknown[] = [];
  readonly completed: CompleteIntelligenceResultWakeupInput[] = [];
  readonly retried: RetryIntelligenceResultWakeupInput[] = [];
  private readonly claims: IntelligenceResultWakeupClaim[];

  constructor(claims: readonly IntelligenceResultWakeupClaim[]) {
    this.claims = [...claims];
  }

  async claimDueTenants(input: {
    readonly consumerId: string;
    readonly leaseDurationMs: number;
    readonly batchSize: number;
  }): Promise<readonly IntelligenceResultWakeupClaim[]> {
    this.claimInputs.push(input);
    return this.claims.splice(0, input.batchSize);
  }

  async complete(
    input: CompleteIntelligenceResultWakeupInput,
  ): Promise<CompleteIntelligenceResultWakeupDisposition> {
    this.completed.push(input);
    return "completed";
  }

  async retry(
    input: RetryIntelligenceResultWakeupInput,
  ): Promise<RetryIntelligenceResultWakeupDisposition> {
    this.retried.push(input);
    return "scheduled";
  }
}

function claim(tenantId: string, generation: number): IntelligenceResultWakeupClaim {
  return {
    tenantId,
    generation,
    consumerId: "consumer-1",
    leaseExpiresAt: "2026-08-01T00:00:30.000Z",
  };
}

describe("IntelligenceResultConsumerLoop", () => {
  it("claims bounded tenant wakeups and schedules immediate retry when the result batch is not drained", async () => {
    const wakeups = new FakeWakeups([claim("tenant-a", 1), claim("tenant-b", 4), claim("tenant-c", 7)]);
    const calls: Array<{ tenantId: string; batchSize: number | undefined }> = [];
    const loop = new IntelligenceResultConsumerLoop({
      consumerId: "consumer-1",
      wakeups,
      consumer: {
        async consumeForTenant(tenantId, options) {
          calls.push({ tenantId, batchSize: options?.batchSize });
          return tenantId === "tenant-a"
            ? { ...emptySummary, applied: 1, processed: 1, hasMore: true, dispositions: ["applied"] }
            : { ...emptySummary, recompute: 1, processed: 1, dispositions: ["recompute"] };
        },
      },
      tenantBatchSize: 2,
      resultBatchSize: 3,
    });

    const summary = await loop.runOnce();

    expect(wakeups.claimInputs).toEqual([
      { consumerId: "consumer-1", leaseDurationMs: 30_000, batchSize: 2 },
    ]);
    expect(calls).toEqual([
      { tenantId: "tenant-a", batchSize: 3 },
      { tenantId: "tenant-b", batchSize: 3 },
    ]);
    expect(wakeups.retried).toMatchObject([
      { tenantId: "tenant-a", generation: 1, retryAfterMs: 0, error: "bounded-batch-remaining" },
    ]);
    expect(wakeups.completed).toEqual([claim("tenant-b", 4)]);
    expect(summary).toMatchObject({ claimed: 2, processed: 2, applied: 1, recompute: 1, retried: 1, completed: 1 });
  });

  it("stops before claiming when aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const wakeups = new FakeWakeups([claim("tenant-a", 1)]);
    const loop = new IntelligenceResultConsumerLoop({
      consumerId: "consumer-1",
      wakeups,
      signal: abort.signal,
      consumer: {
        async consumeForTenant() {
          throw new Error("should not consume");
        },
      },
    });

    await expect(loop.runOnce()).resolves.toEqual({
      claimed: 0,
      processed: 0,
      applied: 0,
      duplicate: 0,
      recompute: 0,
      rejected: 0,
      retried: 0,
      completed: 0,
      stale: 0,
    });
    expect(wakeups.claimInputs).toEqual([]);
  });

  it("releases failed claims through abortable retry backoff instead of clearing the wakeup", async () => {
    const errors: string[] = [];
    const wakeups = new FakeWakeups([claim("tenant-a", 9)]);
    const loop = new IntelligenceResultConsumerLoop({
      consumerId: "consumer-1",
      wakeups,
      consumer: {
        async consumeForTenant() {
          throw new Error("storage unavailable");
        },
      },
      errorBackoffMs: 250,
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    });

    const summary = await loop.runOnce();

    expect(summary).toMatchObject({ claimed: 1, retried: 1, completed: 0 });
    expect(wakeups.completed).toEqual([]);
    expect(wakeups.retried).toMatchObject([
      { tenantId: "tenant-a", generation: 9, consumerId: "consumer-1", retryAfterMs: 250, error: "storage unavailable" },
    ]);
    expect(errors).toEqual(["storage unavailable"]);
  });
});
