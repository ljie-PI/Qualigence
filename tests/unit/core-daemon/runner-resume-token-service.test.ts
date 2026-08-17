import { describe, expect, it } from "vitest";
import { InMemoryRunnerControlStore } from "@qualigence/runner-control";
import { RunnerResumeTokenService } from "@qualigence/core-application";

function fixedClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

const runner1 = { runnerId: "runner-1", certificateFingerprint: "fp-1", protocolMajor: 1 } as const;
const runner2 = { runnerId: "runner-2", certificateFingerprint: "fp-2", protocolMajor: 1 } as const;

function service(options: { ttlMs?: number; now?: () => number } = {}): RunnerResumeTokenService {
  return new RunnerResumeTokenService({ store: new InMemoryRunnerControlStore(), ...options });
}

describe("RunnerResumeTokenService", () => {
  it("issues a single-use rotating token bound to the runner identity", async () => {
    const tokens = service();
    const token = await tokens.issue({ ...runner1, previousSessionId: "session-1" });

    const binding = await tokens.use(token, runner1);
    expect(binding.previousSessionId).toBe("session-1");
    expect(binding.runnerId).toBe("runner-1");
  });

  it("rejects a replayed token after it has been consumed", async () => {
    const tokens = service();
    const token = await tokens.issue({ ...runner1, previousSessionId: "session-1" });
    await tokens.use(token, runner1);

    await expect(tokens.use(token, runner1)).rejects.toMatchObject({
      code: "RunnerResumeRejected",
    });
  });

  it("rejects a token presented by a different runner identity", async () => {
    const tokens = service();
    const token = await tokens.issue({ ...runner1, previousSessionId: "session-1" });

    await expect(tokens.use(token, runner2)).rejects.toMatchObject({
      code: "RunnerResumeRejected",
    });
  });

  it("rejects a token whose certificate fingerprint no longer matches", async () => {
    const tokens = service();
    const token = await tokens.issue({ ...runner1, previousSessionId: "session-1" });

    await expect(
      tokens.use(token, { ...runner1, certificateFingerprint: "fp-rotated" }),
    ).rejects.toMatchObject({ code: "RunnerResumeRejected" });
  });

  it("expires a token after its TTL and cannot be probed repeatedly", async () => {
    const clock = fixedClock();
    const tokens = service({ ttlMs: 1_000, now: clock.now });
    const token = await tokens.issue({ ...runner1, previousSessionId: "session-1" });

    clock.advance(1_001);
    await expect(tokens.use(token, runner1)).rejects.toMatchObject({
      code: "RunnerResumeRejected",
    });
  });
});
