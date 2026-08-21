import { afterEach, describe, expect, it } from "vitest";
import {
  capabilities,
  type ExecutionCompletion,
  type ExecutionEventAck,
  type ExecutionEventBatch,
  type ExecutionJobLease,
  type ExecutionJobOffer,
} from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import { SqliteRunnerSpool, type RunnerSpool } from "@qualigence/runner-spool";
import {
  AllowAllRunnerPolicyGate,
  ScriptedDecisionProvider,
} from "@qualigence/testkit";
import {
  LeasedJobExecutor,
  type LeasedJobExecutorDependencies,
} from "../../../apps/runner/src/job-executor.js";
import { RunnerAppError } from "../../../apps/runner/src/errors.js";

const LEASE: ExecutionJobLease = {
  jobId: "job-1",
  runId: "run-1",
  leaseToken: "lease-token",
  leaseEpoch: 1,
  expiresAt: "2026-08-01T00:05:00.000Z",
};

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

  accepted = false;
  completed: ExecutionCompletion | undefined;
  renewCalls = 0;
  renewedLease: ExecutionJobLease = LEASE;

  async nextOffer(): Promise<ExecutionJobOffer> {
    throw new Error("not used");
  }
  async accept(): Promise<ExecutionJobLease> {
    this.accepted = true;
    return LEASE;
  }
  async renew(lease: ExecutionJobLease): Promise<ExecutionJobLease> {
    this.renewCalls += 1;
    return this.renewedLease;
  }
  async submit(batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    return {
      batchId: batch.batchId,
      runId: batch.runId,
      nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
    };
  }
  async complete(_lease: ExecutionJobLease, result: ExecutionCompletion): Promise<void> {
    this.completed = result;
  }
  async close(): Promise<void> {}
}

class ManualDelay {
  readonly waits: number[] = [];
  private releaseWait: (() => void) | undefined;

  wait(ms: number, signal: AbortSignal): Promise<void> {
    this.waits.push(ms);
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener("abort", finish);
        this.releaseWait = undefined;
        resolve();
      };
      this.releaseWait = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  release(): void {
    this.releaseWait?.();
  }
}

function offer(requiredCapabilities: readonly string[]): ExecutionJobOffer {
  return {
    offerId: "offer-1",
    job: {
      jobId: "job-1",
      runId: "run-1",
      projectId: "project-test",
      target: { kind: "web", url: "https://example.test" },
      objective: "Click login",
      policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
    },
    requiredCapabilities,
    leaseDurationMs: 60_000,
  };
}

let openSpools: SqliteRunnerSpool[] = [];

async function newSpool(): Promise<RunnerSpool> {
  const spool = await SqliteRunnerSpool.open({ databaseFile: ":memory:" });
  openSpools.push(spool);
  return spool;
}

function baseDependencies(
  spool: RunnerSpool,
  state: { monotonic: number; wall: number },
  overrides: Partial<LeasedJobExecutorDependencies> = {},
): LeasedJobExecutorDependencies {
  const observations = [
    { graphId: "graph-before", nodes: [{ id: "node-a", role: "button", name: "Login", confidence: 1 }] },
    { graphId: "graph-after", nodes: [{ id: "node-b", role: "button", name: "Logout", confidence: 1 }] },
  ];
  return {
    observer: { capture: async () => observations.shift()! },
    decisionProvider: new ScriptedDecisionProvider({
      kind: "click",
      target: { nodeId: "node-a" },
      reason: "exercise action",
    }),
    resolver: {
      resolve: async (action, graph) => ({
        kind: "click",
        target: { nodeId: action.target.nodeId, selector: "text=Login" },
        graphId: graph.graphId,
      }),
    },
    policyGate: new AllowAllRunnerPolicyGate(),
    actionExecutor: { execute: async () => ({ status: "ok" }) },
    verifier: {
      verify: async ({ before, after }) => ({
        status: "passed",
        summary: `${before.graphId} -> ${after.graphId}`,
        claims: [],
      }),
    },
    spool,
    capabilities: capabilities(),
    clocks: {
      monotonicNow: (): number => state.monotonic,
      wallNow: (): number => state.wall,
    },
    actionDeadlineSafetyMarginMs: 5_000,
    objectiveOnlyMaximumWallClockMs: 15_000,
    objectiveOnlyMaximumModelTokens: 4_096,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(openSpools.map((spool) => spool.close()));
  openSpools = [];
});

describe("LeasedJobExecutor", () => {
  it("rejects an offer whose required capability is unmet without accepting the lease", async () => {
    const spool = await newSpool();
    const state = { monotonic: 1_000, wall: 100_000 };
    const executor = new LeasedJobExecutor(baseDependencies(spool, state));
    const session = new FakeSession();

    await expect(
      executor.execute(offer(["capability.that.is.unsupported"]), session),
    ).rejects.toMatchObject({ code: "CapabilityMismatch" });
    expect(session.accepted).toBe(false);
    expect((await spool.usage()).events).toBe(0);
  });

  it("runs a leased job to completion and spools its trace", async () => {
    const spool = await newSpool();
    const state = { monotonic: 1_000, wall: 100_000 };
    const executor = new LeasedJobExecutor(baseDependencies(spool, state));
    const session = new FakeSession();

    const result = await executor.execute(offer([]), session);

    expect(result.completion.status).toBe("passed");
    expect(session.accepted).toBe(true);
    expect((await spool.usage()).events).toBeGreaterThan(0);
    expect(executor.mayStartNextAction()).toBe(true);
  });

  it("passes explicit objective-only limits into the public model budget seam", async () => {
    const spool = await newSpool();
    const state = { monotonic: 1_000, wall: 100_000 };
    let outputCeiling: number | undefined;
    const executor = new LeasedJobExecutor(baseDependencies(spool, state, {
      objectiveOnlyMaximumWallClockMs: 12_345,
      objectiveOnlyMaximumModelTokens: 37,
      decisionProvider: {
        decide: async (context) => {
          outputCeiling = context.budget?.maximumOutputTokens(context.job.runId);
          return { kind: "click", target: { nodeId: "node-a" }, reason: "test" };
        },
      },
    }));

    await executor.execute(offer([]), new FakeSession());

    expect(outputCeiling).toBe(37);
  });

  it("renews concurrently with execution and returns the newest lease", async () => {
    const spool = await newSpool();
    const state = { monotonic: 1_000, wall: 100_000 };
    const delay = new ManualDelay();
    let releaseObservation: (() => void) | undefined;
    const observationReady = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    const observations = [
      { graphId: "graph-before", nodes: [{ id: "node-a", role: "button", name: "Login", confidence: 1 }] },
      { graphId: "graph-after", nodes: [{ id: "node-b", role: "button", name: "Logout", confidence: 1 }] },
    ];
    const executor = new LeasedJobExecutor(
      baseDependencies(spool, state, {
        renewalDelay: delay,
        observer: {
          capture: async () => {
            await observationReady;
            return observations.shift()!;
          },
        },
      }),
    );
    const session = new FakeSession();
    session.renewedLease = { ...LEASE, leaseToken: "renewed-token" };

    const execution = executor.execute(offer([]), session);
    await waitFor(() => expect(delay.waits).toEqual([20_000]));
    expect(delay.waits).toEqual([20_000]);
    expect(session.renewCalls).toBe(0);

    delay.release();
    await waitFor(() => expect(session.renewCalls).toBe(1));
    releaseObservation?.();
    const result = await execution;

    expect(result.lease.leaseToken).toBe("renewed-token");
    expect(session.renewCalls).toBe(1);
  });

  it("blocks every new action and preserves the renew error after renewal fails", async () => {
    const spool = await newSpool();
    const state = { monotonic: 1_000, wall: 100_000 };
    const delay = new ManualDelay();
    let releaseObservation: (() => void) | undefined;
    const observationReady = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    let executed = 0;
    const observations = [
      { graphId: "graph-before", nodes: [{ id: "node-a", role: "button", name: "Login", confidence: 1 }] },
      { graphId: "graph-after", nodes: [{ id: "node-b", role: "button", name: "Logout", confidence: 1 }] },
    ];
    const executor = new LeasedJobExecutor(
      baseDependencies(spool, state, {
        renewalDelay: delay,
        observer: {
          capture: async () => {
            await observationReady;
            return observations.shift()!;
          },
        },
        actionExecutor: {
          execute: async () => {
            executed += 1;
            return { status: "ok" };
          },
        },
      }),
    );
    const session = new FakeSession();
    session.renew = async () => {
      session.renewCalls += 1;
      throw new Error("LeaseLost");
    };

    const execution = executor.execute(offer([]), session);
    await waitFor(() => expect(delay.waits).toEqual([20_000]));
    delay.release();
    await waitFor(() => expect(session.renewCalls).toBe(1));
    releaseObservation?.();

    await expect(execution).rejects.toThrow("LeaseLost");
    expect(executed).toBe(0);
    expect(executor.mayStartNextAction()).toBe(false);
  });

  it("propagates an undefined renewal rejection", async () => {
    const spool = await newSpool();
    const state = { monotonic: 1_000, wall: 100_000 };
    const delay = new ManualDelay();
    let releaseObservation: (() => void) | undefined;
    const observationReady = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    const observations = [
      { graphId: "graph-before", nodes: [{ id: "node-a", role: "button", name: "Login", confidence: 1 }] },
      { graphId: "graph-after", nodes: [{ id: "node-b", role: "button", name: "Logout", confidence: 1 }] },
    ];
    const executor = new LeasedJobExecutor(
      baseDependencies(spool, state, {
        renewalDelay: delay,
        observer: {
          capture: async () => {
            await observationReady;
            return observations.shift()!;
          },
        },
      }),
    );
    const session = new FakeSession();
    session.renew = async () => {
      session.renewCalls += 1;
      return Promise.reject(undefined);
    };

    const execution = executor.execute(offer([]), session);
    await waitFor(() => expect(delay.waits).toEqual([20_000]));
    delay.release();
    await waitFor(() => expect(session.renewCalls).toBe(1));
    releaseObservation?.();

    await expect(execution).rejects.toBeUndefined();
    expect(executor.mayStartNextAction()).toBe(false);
  });

  it("blocks a new action locally once the lease window has closed", async () => {
    const spool = await newSpool();
    const state = { monotonic: 1_000, wall: 100_000 };
    let executed = 0;
    const observations = [
      { graphId: "graph-before", nodes: [{ id: "node-a", role: "button", name: "Login", confidence: 1 }] },
      { graphId: "graph-after", nodes: [{ id: "node-b", role: "button", name: "Logout", confidence: 1 }] },
    ];
    const executor = new LeasedJobExecutor(
      baseDependencies(spool, state, {
        observer: {
          // Advance the monotonic clock past the safety-adjusted deadline
          // (1_000 + 60_000 - 5_000 = 56_000) before the execute stage.
          capture: async () => {
            state.monotonic = 60_000;
            return observations.shift()!;
          },
        },
        actionExecutor: {
          execute: async () => {
            executed += 1;
            return { status: "ok" };
          },
        },
      }),
    );
    const session = new FakeSession();

    const result = await executor.execute(offer([]), session);

    expect(result.completion.status).toBe("blocked");
    expect(result.completion).toMatchObject({ errorCode: "LeaseExpired" });
    expect(executed).toBe(0);
    expect(executor.mayStartNextAction()).toBe(false);
  });
});

async function waitFor(assertion: () => void): Promise<void> {
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
