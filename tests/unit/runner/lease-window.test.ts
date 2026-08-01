import { describe, expect, it } from "vitest";
import type { ExecutionJobLease } from "@qualigence/runner-protocol";
import { LeaseWindow } from "../../../apps/runner/src/lease-window.js";

const lease: ExecutionJobLease = {
  jobId: "job-1",
  runId: "run-1",
  leaseToken: "lease-token",
  leaseEpoch: 1,
  expiresAt: "2026-08-01T00:05:00.000Z",
};

function fakeClocks(state: { monotonic: number; wall: number }): {
  clocks: { monotonicNow: () => number; wallNow: () => number };
  state: { monotonic: number; wall: number };
} {
  return {
    clocks: {
      monotonicNow: (): number => state.monotonic,
      wallNow: (): number => state.wall,
    },
    state,
  };
}

describe("LeaseWindow", () => {
  const options = { leaseDurationMs: 60_000, actionDeadlineSafetyMarginMs: 5_000 };

  it("permits actions before the safety-adjusted monotonic deadline", () => {
    const state = { monotonic: 1_000, wall: 100_000 };
    const window = new LeaseWindow(lease, fakeClocks(state).clocks, options);

    expect(window.mayStartAction()).toBe(true);
  });

  it("blocks a new action once the monotonic deadline passes, with no wall-clock reprieve", () => {
    const state = { monotonic: 1_000, wall: 100_000 };
    const window = new LeaseWindow(lease, fakeClocks(state).clocks, options);

    // Deadline = 1_000 + 60_000 - 5_000 = 56_000.
    state.monotonic = 56_000;
    expect(window.mayStartAction()).toBe(false);

    // A later wall-clock reading must never re-open the window.
    state.wall = 1_000_000;
    expect(window.mayStartAction()).toBe(false);
  });

  it("blocks actions when the wall clock jumps backward under a still-valid monotonic clock", () => {
    const state = { monotonic: 1_000, wall: 100_000 };
    const window = new LeaseWindow(lease, fakeClocks(state).clocks, options);

    state.monotonic = 2_000;
    state.wall = 90_000;
    expect(window.mayStartAction()).toBe(false);
  });

  it("re-opens the window from the current monotonic clock after a renew", () => {
    const state = { monotonic: 1_000, wall: 100_000 };
    const window = new LeaseWindow(lease, fakeClocks(state).clocks, options);

    state.monotonic = 56_000;
    expect(window.mayStartAction()).toBe(false);

    window.renew(lease);
    expect(window.mayStartAction()).toBe(true);
  });

  it("stays closed after an explicit close even within the deadline", () => {
    const state = { monotonic: 1_000, wall: 100_000 };
    const window = new LeaseWindow(lease, fakeClocks(state).clocks, options);

    window.close();
    expect(window.mayStartAction()).toBe(false);
  });
});
