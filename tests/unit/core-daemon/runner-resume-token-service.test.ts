import { describe, expect, it } from "vitest";
import { RunnerResumeTokenService } from "../../../apps/core-daemon/src/runner/runner-resume-token-service.js";

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

describe("RunnerResumeTokenService", () => {
  it("issues a single-use rotating token bound to the runner identity", () => {
    const service = new RunnerResumeTokenService();
    const token = service.issue({ ...runner1, previousSessionId: "session-1" });

    const binding = service.use(token, runner1);
    expect(binding.previousSessionId).toBe("session-1");
    expect(binding.runnerId).toBe("runner-1");
  });

  it("rejects a replayed token after it has been consumed", () => {
    const service = new RunnerResumeTokenService();
    const token = service.issue({ ...runner1, previousSessionId: "session-1" });
    service.use(token, runner1);

    expect(() => service.use(token, runner1)).toThrowError(
      expect.objectContaining({ code: "RunnerResumeRejected" }),
    );
  });

  it("rejects a token presented by a different runner identity", () => {
    const service = new RunnerResumeTokenService();
    const token = service.issue({ ...runner1, previousSessionId: "session-1" });

    expect(() => service.use(token, runner2)).toThrowError(
      expect.objectContaining({ code: "RunnerResumeRejected" }),
    );
  });

  it("rejects a token whose certificate fingerprint no longer matches", () => {
    const service = new RunnerResumeTokenService();
    const token = service.issue({ ...runner1, previousSessionId: "session-1" });

    expect(() =>
      service.use(token, { ...runner1, certificateFingerprint: "fp-rotated" }),
    ).toThrowError(expect.objectContaining({ code: "RunnerResumeRejected" }));
  });

  it("expires a token after its TTL and cannot be probed repeatedly", () => {
    const clock = fixedClock();
    const service = new RunnerResumeTokenService({ ttlMs: 1_000, now: clock.now });
    const token = service.issue({ ...runner1, previousSessionId: "session-1" });

    clock.advance(1_001);
    expect(() => service.use(token, runner1)).toThrowError(
      expect.objectContaining({ code: "RunnerResumeRejected" }),
    );
  });
});
