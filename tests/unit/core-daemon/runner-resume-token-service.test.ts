import { describe, expect, it } from "vitest";
import { RunnerResumeTokenService } from "@qualigence/core-application";
import { InMemoryRunnerControlStore } from "../../helpers/in-memory-runner-control-store.js";

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
const binding1 = { ...runner1, previousSessionId: "session-1" } as const;

function service(options: { ttlMs?: number; now?: () => number } = {}): RunnerResumeTokenService {
  return new RunnerResumeTokenService({ store: new InMemoryRunnerControlStore(), ...options });
}

describe("RunnerResumeTokenService", () => {
  it("issues a single-use rotating token bound to the runner identity", async () => {
    const tokens = service();
    const token = await tokens.issue(binding1);

    const redeemed = await tokens.redeem(token, runner1);
    expect(redeemed.binding.previousSessionId).toBe("session-1");
    expect(redeemed.binding.runnerId).toBe("runner-1");
    expect(redeemed.resumeToken).toBeTruthy();
  });

  it("replays a crashed redemption idempotently with the same replacement credential", async () => {
    const tokens = service();
    const token = await tokens.issue(binding1);

    const first = await tokens.redeem(token, runner1);
    // The Welcome never arrived: the Runner replays the same credential.
    const replay = await tokens.redeem(token, runner1);

    expect(replay.binding).toEqual(first.binding);
    expect(replay.resumeToken).toBe(first.resumeToken);
    // The replacement itself is single-use and bound to the same session.
    const chained = await tokens.redeem(replay.resumeToken, runner1);
    expect(chained.binding.previousSessionId).toBe("session-1");
  });

  it("rejects a replayed token once the crash-replay window has closed", async () => {
    const clock = fixedClock();
    const tokens = service({ ttlMs: 1_000, now: clock.now });
    const token = await tokens.issue(binding1);
    const first = await tokens.redeem(token, runner1);
    expect(first.resumeToken).toBeTruthy();

    // A replay inside the TTL window is the legal idempotent retry...
    clock.advance(500);
    await expect(tokens.redeem(token, runner1)).resolves.toMatchObject({
      binding: binding1,
    });
    // ...and a replay after expiry is burned.
    clock.advance(501);
    await expect(tokens.redeem(token, runner1)).rejects.toMatchObject({
      code: "RunnerResumeRejected",
    });
  });

  it("rejects a token presented by a different runner identity", async () => {
    const tokens = service();
    const token = await tokens.issue(binding1);

    await expect(tokens.redeem(token, runner2)).rejects.toMatchObject({
      code: "RunnerResumeRejected",
    });
  });

  it("rejects a token whose certificate fingerprint no longer matches", async () => {
    const tokens = service();
    const token = await tokens.issue(binding1);

    await expect(
      tokens.redeem(token, { ...runner1, certificateFingerprint: "fp-rotated" }),
    ).rejects.toMatchObject({ code: "RunnerResumeRejected" });
  });

  it("expires a token after its TTL and cannot be probed repeatedly", async () => {
    const clock = fixedClock();
    const tokens = service({ ttlMs: 1_000, now: clock.now });
    const token = await tokens.issue(binding1);

    clock.advance(1_001);
    await expect(tokens.redeem(token, runner1)).rejects.toMatchObject({
      code: "RunnerResumeRejected",
    });
  });
});