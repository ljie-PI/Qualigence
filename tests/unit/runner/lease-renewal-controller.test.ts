import { describe, expect, it } from "vitest";
import type {
  ExecutionCompletion,
  ExecutionEventAck,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
} from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import {
  LeaseRenewalController,
  type RenewalDelay,
} from "../../../apps/runner/src/lease-renewal-controller.js";
import { LeaseWindow } from "../../../apps/runner/src/lease-window.js";

const INITIAL_LEASE: ExecutionJobLease = {
  jobId: "job-1",
  runId: "run-1",
  leaseToken: "lease-token-1",
  leaseEpoch: 1,
  expiresAt: "2026-08-01T00:01:00.000Z",
};

const RENEWED_LEASE: ExecutionJobLease = {
  ...INITIAL_LEASE,
  leaseToken: "lease-token-2",
  expiresAt: "2026-08-01T00:02:00.000Z",
};

class ManualDelay implements RenewalDelay {
  readonly waits: number[] = [];
  private readonly pending: Array<() => void> = [];

  wait(ms: number, signal: AbortSignal): Promise<void> {
    this.waits.push(ms);
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener("abort", finish);
        resolve();
      };
      this.pending.push(finish);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  release(): void {
    this.pending.shift()?.();
  }
}

class FakeSession implements RunnerSession {
  readonly welcome = {
    sessionId: "session-1",
    resumeToken: "resume-token",
    selectedProtocolMajor: 1 as const,
    serverVersion: "test",
    heartbeatIntervalMs: 1_000,
    leaseDurationMs: 60_000,
    traceBatchMaximumEvents: 100,
    traceBatchMaximumBytes: 1_000_000,
    maximumInFlightBatches: 4,
    maximumPendingWriteBytes: 1_000_000,
  };
  renewCalls: ExecutionJobLease[] = [];
  renewError: Error | undefined;
  closeCalls = 0;

  async nextOffer(): Promise<ExecutionJobOffer> {
    throw new Error("not used");
  }
  async accept(): Promise<ExecutionJobLease> {
    throw new Error("not used");
  }
  async renew(lease: ExecutionJobLease): Promise<ExecutionJobLease> {
    this.renewCalls.push(lease);
    if (this.renewError !== undefined) throw this.renewError;
    return RENEWED_LEASE;
  }
  async submit(_batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    throw new Error("not used");
  }
  async complete(_lease: ExecutionJobLease, _result: ExecutionCompletion): Promise<void> {}
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function makeWindow(state = { monotonic: 1_000, wall: 100_000 }): LeaseWindow {
  return new LeaseWindow(
    INITIAL_LEASE,
    { monotonicNow: () => state.monotonic, wallNow: () => state.wall },
    { leaseDurationMs: 60_000, actionDeadlineSafetyMarginMs: 5_000 },
  );
}

describe("LeaseRenewalController", () => {
  it("renews after one third of the lease duration and keeps the newest lease", async () => {
    const session = new FakeSession();
    const delay = new ManualDelay();
    const executionAbort = new AbortController();
    const state = { monotonic: 1_000, wall: 100_000 };
    const window = makeWindow(state);
    const controller = new LeaseRenewalController({
      session,
      initialLease: INITIAL_LEASE,
      window,
      leaseDurationMs: 60_000,
      executionAbort,
      delay,
    });

    const running = controller.run(new AbortController().signal);
    expect(delay.waits).toEqual([20_000]);
    expect(session.renewCalls).toHaveLength(0);

    state.monotonic = 56_000;
    expect(window.mayStartAction()).toBe(false);
    delay.release();
    await viWaitFor(() => expect(controller.currentLease()).toEqual(RENEWED_LEASE));
    expect(session.renewCalls[0]).toEqual(INITIAL_LEASE);
    expect(controller.currentLease()).toEqual(RENEWED_LEASE);
    expect(window.mayStartAction()).toBe(true);

    controller.stop();
    await expect(running).resolves.toBeUndefined();
    expect(executionAbort.signal.aborted).toBe(false);
  });

  it("permanently closes the action window and aborts execution when renew fails", async () => {
    const session = new FakeSession();
    session.renewError = new Error("LeaseLost");
    const delay = new ManualDelay();
    const executionAbort = new AbortController();
    const window = makeWindow();
    const controller = new LeaseRenewalController({
      session,
      initialLease: INITIAL_LEASE,
      window,
      leaseDurationMs: 60_000,
      executionAbort,
      delay,
    });

    const running = controller.run(new AbortController().signal);
    delay.release();

    await expect(running).rejects.toThrow("LeaseLost");
    expect(window.mayStartAction()).toBe(false);
    expect(executionAbort.signal.aborted).toBe(true);
    expect(controller.currentLease()).toEqual(INITIAL_LEASE);
  });

  it("rejects a lease that expired before a delayed renewal attempt", async () => {
    const session = new FakeSession();
    const delay = new ManualDelay();
    const executionAbort = new AbortController();
    const state = { monotonic: 1_000, wall: 100_000 };
    const window = makeWindow(state);
    const controller = new LeaseRenewalController({
      session,
      initialLease: INITIAL_LEASE,
      window,
      leaseDurationMs: 60_000,
      executionAbort,
      delay,
    });

    const running = controller.run(new AbortController().signal);
    const rejected = expect(running).rejects.toMatchObject({ code: "LeaseExpired" });
    state.monotonic = 61_000;
    delay.release();

    await rejected;
    expect(session.renewCalls).toHaveLength(0);
    expect(executionAbort.signal.aborted).toBe(true);
    expect(window.mayStartAction()).toBe(false);
  });

  it("treats stop as normal completion and never renews afterward", async () => {
    const session = new FakeSession();
    const delay = new ManualDelay();
    const executionAbort = new AbortController();
    const window = makeWindow();
    const controller = new LeaseRenewalController({
      session,
      initialLease: INITIAL_LEASE,
      window,
      leaseDurationMs: 60_000,
      executionAbort,
      delay,
    });

    const running = controller.run(new AbortController().signal);
    controller.stop();

    await expect(running).resolves.toBeUndefined();
    expect(session.renewCalls).toHaveLength(0);
    expect(window.mayStartAction()).toBe(true);
    expect(executionAbort.signal.aborted).toBe(false);
  });

  it("waits for an in-flight renew after stop and keeps its latest lease", async () => {
    const session = new FakeSession();
    let finishRenew: ((lease: ExecutionJobLease) => void) | undefined;
    session.renew = async (lease) => {
      session.renewCalls.push(lease);
      return new Promise<ExecutionJobLease>((resolve) => {
        finishRenew = resolve;
      });
    };
    const delay = new ManualDelay();
    const executionAbort = new AbortController();
    const state = { monotonic: 1_000, wall: 100_000 };
    const window = makeWindow(state);
    const controller = new LeaseRenewalController({
      session,
      initialLease: INITIAL_LEASE,
      window,
      leaseDurationMs: 60_000,
      executionAbort,
      delay,
    });

    const running = controller.run(new AbortController().signal);
    delay.release();
    await viWaitFor(() => expect(session.renewCalls).toHaveLength(1));
    controller.stop();
    state.monotonic = 56_000;
    expect(window.mayStartAction()).toBe(false);

    let settled = false;
    running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishRenew?.(RENEWED_LEASE);
    await expect(running).resolves.toBeUndefined();
    expect(controller.currentLease()).toEqual(RENEWED_LEASE);
    expect(window.mayStartAction()).toBe(true);
    expect(executionAbort.signal.aborted).toBe(false);
  });

  it("fails closed when an in-flight renew exceeds its deadline", async () => {
    const session = new FakeSession();
    session.renew = async (lease) => {
      session.renewCalls.push(lease);
      return new Promise<ExecutionJobLease>(() => {});
    };
    const delay = new ManualDelay();
    const executionAbort = new AbortController();
    const window = makeWindow();
    session.close = async () => {
      session.closeCalls += 1;
      return new Promise<void>(() => {});
    };
    const controller = new LeaseRenewalController({
      session,
      initialLease: INITIAL_LEASE,
      window,
      leaseDurationMs: 60_000,
      executionAbort,
      delay,
    });

    const running = controller.run(new AbortController().signal);
    delay.release();
    await viWaitFor(() => expect(delay.waits).toEqual([20_000, 20_000]));
    delay.release();

    let outcome: { readonly status: "rejected"; readonly error: unknown } | undefined;
    running.catch((error: unknown) => {
      outcome = { status: "rejected", error };
    });
    await viWaitFor(() => expect(outcome).toBeDefined());

    expect(outcome?.error).toMatchObject({
      name: "LeaseRenewalTimeoutError",
      code: "LeaseRenewalTimeout",
      message: "lease renewal timed out after 20000ms",
    });
    expect(window.mayStartAction()).toBe(false);
    expect(executionAbort.signal.aborted).toBe(true);
    expect(executionAbort.signal.reason).toMatchObject({
      name: "LeaseRenewalTimeoutError",
    });
    expect(session.closeCalls).toBe(1);
    expect(controller.currentLease()).toEqual(INITIAL_LEASE);
  });
});

async function viWaitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}
