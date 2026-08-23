import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  RunnerCapabilities,
  TraceEvent,
} from "@qualigence/runner-protocol";
import {
  advertisedCapabilityTokens,
  negotiateCapabilities,
} from "@qualigence/runner-protocol";
import type { RunnerPolicyGate } from "@qualigence/runner-kernel";
import type { RunnerSpool } from "@qualigence/runner-spool";
import { WebTargetError } from "@qualigence/web-playwright";

const executorGates: RunnerPolicyGate[] = [];
const executorCapabilities: RunnerCapabilities[] = [];
const executedOffers: unknown[] = [];
const executionSignals: Array<AbortSignal | undefined> = [];
const executionLifecycles: unknown[] = [];
const executionWindowStates: boolean[] = [];
const modelConstructions: string[] = [];
let executorFailure: unknown;
vi.mock("@qualigence/model-agent", () => ({
  ModelBackedDecisionProvider: class {
    constructor(_gateway: unknown, _model: string) {
      modelConstructions.push("decision");
    }
  },
  ModelBackedVerifier: class {
    constructor() {
      modelConstructions.push("verifier");
    }
  },
}));
vi.mock("@qualigence/model-gateway", () => ({
  ModelGateway: class {
    constructor() {
      modelConstructions.push("gateway");
    }
  },
}));
vi.mock("@qualigence/openai-compatible-model-provider", () => ({
  OpenAICompatibleModelProvider: class {
    constructor() {
      modelConstructions.push("provider");
    }
  },
}));
vi.mock("../../../apps/runner/src/job-executor.js", async () => {
  const actual = await vi.importActual<typeof import("../../../apps/runner/src/job-executor.js")>(
    "../../../apps/runner/src/job-executor.js",
  );
  return {
    ...actual,
    LeasedJobExecutor: class {
    constructor(dependencies: { readonly policyGate: RunnerPolicyGate; readonly capabilities: RunnerCapabilities }) {
      executorGates.push(dependencies.policyGate);
      executorCapabilities.push(dependencies.capabilities);
    }
    async execute(
      offer: unknown,
      _session: unknown,
      signal?: AbortSignal,
      lifecycle?: {
        currentLease(): ExecutionJobLease;
        duringLease<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
        finish(completion?: unknown): Promise<ExecutionJobLease>;
        mayStartAction(): boolean;
      },
      finalize?: (context: {
        readonly completion: { readonly jobId: string; readonly runId: string; readonly status: "passed" };
        readonly signal: AbortSignal;
        currentLease(): ExecutionJobLease;
      }) => Promise<void>,
    ) {
      executedOffers.push(offer);
      executionSignals.push(signal);
      executionLifecycles.push(lifecycle);
      executionWindowStates.push(lifecycle?.mayStartAction() ?? false);
      if (executorFailure !== undefined) throw executorFailure;
      const completion = { jobId: "job-staging", runId: "run-staging", status: "passed" as const };
      if (lifecycle !== undefined && finalize !== undefined) {
        await lifecycle.duringLease((finalizationSignal) => finalize({
          completion,
          signal: finalizationSignal,
          currentLease: () => lifecycle.currentLease(),
        }));
      }
      const lease = lifecycle === undefined
        ? { jobId: "job-staging", runId: "run-staging", leaseToken: "token", leaseEpoch: 1, expiresAt: "2099-08-18T00:01:00.000Z" }
        : await lifecycle.finish(completion);
      return {
        lease,
        completion,
      };
    }
    },
  };
});
import { RunnerOfferRuntime, runnerCapabilities } from "../../../apps/runner/src/offer-runtime.js";

const STARTUP_LEASE: ExecutionJobLease = {
  jobId: "job-startup",
  runId: "run-startup",
  leaseToken: "lease-token",
  leaseEpoch: 1,
  expiresAt: "2099-08-18T00:01:00.000Z",
};

function admittedOffer(): ExecutionJobOffer {
  return {
    offerId: "offer-startup",
    job: {
      jobId: STARTUP_LEASE.jobId,
      runId: STARTUP_LEASE.runId,
      projectId: "project-test",
      target: { kind: "web", url: "https://example.test/" },
      objective: "exercise startup",
      policy: {
        policyId: "policy-startup",
        environment: "isolated_test",
        allowedOrigins: ["https://example.test"],
        allowedActionKinds: ["click"],
        maximumRisk: "Normal",
        explorationAllowed: false,
        issuedAt: "2099-08-18T00:00:00.000Z",
        expiresAt: "2099-08-18T00:01:00.000Z",
      },
    },
    requiredCapabilities: [],
    leaseDurationMs: 30_000,
  };
}

function recordingSpool(options: { readonly appendError?: Error; readonly acknowledgeError?: Error } = {}) {
  const appended: TraceEvent[] = [];
  let nextAcknowledgedSequence = 1;
  const append = vi.fn(async (event: TraceEvent) => {
    if (options.appendError !== undefined) throw options.appendError;
    appended.push(event);
  });
  const pending = vi.fn(async (runId: string, fromSequence: number) =>
    appended.filter((event) =>
      event.runId === runId &&
      event.sequenceNumber >= Math.max(fromSequence, nextAcknowledgedSequence)));
  const acknowledge = vi.fn(async (_runId: string, nextExpectedSequenceNumber: number) => {
    if (options.acknowledgeError !== undefined) throw options.acknowledgeError;
    nextAcknowledgedSequence = nextExpectedSequenceNumber;
  });
  const spool: RunnerSpool = {
    append,
    pending,
    acknowledge,
    usage: async () => ({
      bytes: 0,
      events: appended.filter((event) => event.sequenceNumber >= nextAcknowledgedSequence).length,
    }),
  };
  return { spool, appended, append, pending, acknowledge };
}

class ManualDelay {
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

async function startServer(handler: RequestListener): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}

describe("RunnerOfferRuntime", () => {
  function config() {
    return { headed: false, navigationTimeoutMs: 1_000, actionTimeoutMs: 1_000, model: { baseUrl: "https://models.test", apiKey: "secret", modelName: "test" } } as never;
  }

  beforeEach(() => {
    executorGates.length = 0;
    executorCapabilities.length = 0;
    executedOffers.length = 0;
    executionSignals.length = 0;
    executionLifecycles.length = 0;
    executionWindowStates.length = 0;
    modelConstructions.length = 0;
    executorFailure = undefined;
  });

  it("advertises no value-backed actions without a healthy provider", () => {
    expect(runnerCapabilities().actionKinds).toEqual(["navigate", "click", "scroll"]);
  });

  it("advertises and negotiates every healthy production Web action path", () => {
    const withoutValues = runnerCapabilities();
    const withValues = runnerCapabilities({ resolve: async () => "private-value" });

    expect([...advertisedCapabilityTokens(withoutValues)]).toEqual(expect.arrayContaining([
      "action:navigate",
      "action:click",
      "action:scroll",
    ]));
    expect(negotiateCapabilities(withoutValues, ["action:navigate", "action:scroll"])).toEqual({
      outcome: "accepted",
    });
    expect(negotiateCapabilities(withoutValues, ["action:input", "action:select"])).toMatchObject({
      outcome: "rejected",
    });
    expect(negotiateCapabilities(withValues, [
      "action:navigate",
      "action:click",
      "action:input",
      "action:select",
      "action:scroll",
    ])).toEqual({ outcome: "accepted" });
  });

  it("preserves capability denial before lease acceptance and target startup", async () => {
    const createTarget = vi.fn();
    const session = {
      accept: vi.fn(),
      complete: vi.fn(),
    };
    const runtime = new RunnerOfferRuntime({
      createTarget,
      session: session as never,
      spool: {} as never,
      config: config(),
    });

    await expect(runtime.run({
      ...admittedOffer(),
      requiredCapabilities: ["unsupported:capability"],
    })).rejects.toMatchObject({ code: "CapabilityMismatch" });

    expect(session.accept).not.toHaveBeenCalled();
    expect(session.complete).not.toHaveBeenCalled();
    expect(createTarget).not.toHaveBeenCalled();
    expect(modelConstructions).toEqual([]);
  });

  it.each(["input", "select"] as const)(
    "rejects a forged %s Plan without a value provider before lease acceptance",
    async (kind) => {
      const createTarget = vi.fn();
      const session = {
        accept: vi.fn(),
        complete: vi.fn(),
      };
      const runtime = new RunnerOfferRuntime({
        createTarget,
        session: session as never,
        spool: {} as never,
        config: config(),
      });
      const step = {
        stepIndex: 0,
        kind,
        target: { purpose: `${kind} a value` },
        valueRef: `profile.${kind}`,
      };

      await expect(runtime.run({
        ...admittedOffer(),
        job: {
          ...admittedOffer().job,
          policy: {
            ...admittedOffer().job.policy,
            allowedActionKinds: [kind],
            maximumRisk: "ExternalSideEffect",
          },
          plan: {
            missionId: "mission-forged",
            missionRevision: 1,
            testCaseId: `case-${kind}`,
            steps: [step],
            expectedClaimIds: ["claim-1"],
            budget: {
              maximumStepsPerJob: 1,
              maximumWallClockMs: 1_000,
              maximumModelTokens: 1_000,
            },
          },
        },
        requiredCapabilities: [],
      })).rejects.toMatchObject({ code: "CapabilityMismatch" });

      expect(session.accept).not.toHaveBeenCalled();
      expect(session.complete).not.toHaveBeenCalled();
      expect(createTarget).not.toHaveBeenCalled();
      expect(modelConstructions).toEqual([]);
    },
  );

  it("does not construct or start a target when lease acceptance fails", async () => {
    const failure = new Error("lease unavailable");
    const createTarget = vi.fn();
    const session = {
      accept: vi.fn(async () => { throw failure; }),
      complete: vi.fn(),
    };
    const runtime = new RunnerOfferRuntime({
      createTarget,
      session: session as never,
      spool: {} as never,
      config: config(),
    });

    await expect(runtime.run(admittedOffer())).rejects.toBe(failure);

    expect(session.accept).toHaveBeenCalledOnce();
    expect(createTarget).not.toHaveBeenCalled();
    expect(session.complete).not.toHaveBeenCalled();
    expect(modelConstructions).toEqual([]);
  });

  it("blocks a policyless offer before target construction or browser navigation", async () => {
    const target = {
      start: vi.fn(), // Browser launch and initial page.goto are behind start.
      capture: vi.fn(), // Observation before model decision.
      resolve: vi.fn(),
      execute: vi.fn(), // Receives a constructed permit only on an allowed run.
      close: vi.fn(),
    };
    const createTarget = vi.fn(() => target) as unknown as {
      readonly mock: { readonly calls: Array<readonly [{ readonly allowedOrigins: readonly string[] }]> };
    };
    const session = {
      accept: vi.fn(async () => ({ jobId: "job-1", runId: "run-1", leaseToken: "token", leaseEpoch: 1, expiresAt: "2026-08-18T00:01:00.000Z" })),
      complete: vi.fn(async () => undefined),
    };
    const runtime = new RunnerOfferRuntime({ createTarget: createTarget as never, session: session as never, spool: {} as never, config: {} as never });

    await runtime.run({
      offerId: "offer-1",
      job: {
        jobId: "job-1",
        runId: "run-1",
        target: { kind: "web", url: "https://example.test/" },
        objective: "must block",
      },
      requiredCapabilities: [],
      leaseDurationMs: 30_000,
    } as never);

    expect(session.accept).toHaveBeenCalledOnce();
    expect(session.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "blocked", errorCode: "PolicyMissing" }));
    expect(createTarget).not.toHaveBeenCalled();
    expect(target.start).not.toHaveBeenCalled();
    expect(target.capture).not.toHaveBeenCalled();
    expect(target.resolve).not.toHaveBeenCalled();
    expect(target.execute).not.toHaveBeenCalled();
    expect(target.close).not.toHaveBeenCalled();
  });

  it("blocks a cross-origin offer before target construction", async () => {
    const createTarget = vi.fn();
    const session = {
      accept: vi.fn(async () => ({ jobId: "job-1", runId: "run-1", leaseToken: "token", leaseEpoch: 1, expiresAt: "2026-08-18T00:01:00.000Z" })),
      complete: vi.fn(async () => undefined),
    };
    const runtime = new RunnerOfferRuntime({ createTarget: createTarget as never, session: session as never, spool: {} as never, config: {} as never });
    await runtime.run({
      offerId: "offer-1",
      job: {
        jobId: "job-1", runId: "run-1", projectId: "project-test", target: { kind: "web", url: "https://evil.test/" }, objective: "must block",
        policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2099-08-18T00:00:00.000Z", expiresAt: "2099-08-18T00:01:00.000Z" },
      }, requiredCapabilities: [], leaseDurationMs: 30_000,
    });
    expect(createTarget).not.toHaveBeenCalled();
    expect(session.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ errorCode: "PolicyDenied" }));
  });

  it.each([
    ["malformed", [{ stepIndex: 1, kind: "navigate", path: "/checkout" }]],
    ["policy-incompatible", [{ stepIndex: 0, kind: "navigate", path: "/checkout" }]],
  ])("blocks a %s plan before target construction", async (_name, steps) => {
    const createTarget = vi.fn();
    const session = {
      accept: vi.fn(async () => ({ jobId: "job-1", runId: "run-1", leaseToken: "token", leaseEpoch: 1, expiresAt: "2099-08-18T00:01:00.000Z" })),
      complete: vi.fn(async () => undefined),
    };
    const runtime = new RunnerOfferRuntime({ createTarget, session: session as never, spool: {} as never, config: {} as never });

    await runtime.run({
      offerId: "offer-1",
      job: {
        jobId: "job-1",
        runId: "run-1",
        projectId: "project-test",
        target: { kind: "web", url: "https://example.test/" },
        objective: "must block",
        policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2099-08-18T00:00:00.000Z", expiresAt: "2099-08-18T00:01:00.000Z" },
        plan: { missionId: "mission-1", missionRevision: 1, testCaseId: "case-1", steps, expectedClaimIds: ["claim-1"], budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 1_000 } },
      },
      requiredCapabilities: [],
      leaseDurationMs: 30_000,
    } as never);

    expect(createTarget).not.toHaveBeenCalled();
    expect(session.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "blocked" }));
  });

  it("rejects an unsupported Plan action as a capability mismatch before acceptance", async () => {
    const createTarget = vi.fn();
    const session = { accept: vi.fn(), complete: vi.fn() };
    const runtime = new RunnerOfferRuntime({
      createTarget,
      session: session as never,
      spool: {} as never,
      config: config(),
    });

    await expect(runtime.run({
      ...admittedOffer(),
      job: {
        ...admittedOffer().job,
        plan: {
          missionId: "mission-1",
          missionRevision: 1,
          testCaseId: "case-1",
          steps: [{ stepIndex: 0, kind: "script", source: "alert(1)" }],
          expectedClaimIds: ["claim-1"],
          budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 1_000 },
        },
      },
    } as never)).rejects.toMatchObject({ code: "CapabilityMismatch" });

    expect(session.accept).not.toHaveBeenCalled();
    expect(session.complete).not.toHaveBeenCalled();
    expect(createTarget).not.toHaveBeenCalled();
  });

  it("passes the immutable Job target origin and policy origins to an admitted target", async () => {
    executorGates.length = 0;
    executorCapabilities.length = 0;
    const target = { start: vi.fn(async () => undefined), close: vi.fn(async () => undefined), capture: vi.fn(), resolve: vi.fn(), execute: vi.fn() };
    const createTarget = vi.fn(() => target) as never;
    const session = { accept: vi.fn(async () => ({ ...STARTUP_LEASE, jobId: "job-staging", runId: "run-staging" })), renew: vi.fn(), complete: vi.fn(async () => undefined), submit: vi.fn(), welcome: { traceBatchMaximumEvents: 1, traceBatchMaximumBytes: 9 } };
    const spool = { pending: vi.fn(async () => []), acknowledge: vi.fn() };
    const runtime = new RunnerOfferRuntime({ createTarget, session: session as never, spool: spool as never, config: config() });
    await runtime.run({
      offerId: "offer-staging",
      job: { jobId: "job-staging", runId: "run-staging", projectId: "project-test", target: { kind: "web", url: "HTTPS://STAGING.example.test:443/" }, objective: "click", policy: { policyId: "policy-staging", environment: "staging", allowedOrigins: ["https://staging.example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2099-08-18T00:00:00.000Z", expiresAt: "2099-08-18T00:01:00.000Z" } },
      requiredCapabilities: [], leaseDurationMs: 30_000,
    } as never);
    expect((createTarget as unknown as {
      mock: { calls: Array<readonly [{ readonly allowedOrigins: readonly string[]; readonly expectedOrigin: string }]> };
    }).mock.calls[0]?.[0]).toMatchObject({
      allowedOrigins: ["https://staging.example.test"],
      expectedOrigin: "https://staging.example.test",
    });
    expect(executorGates).toHaveLength(1);
    expect(spool.pending).toHaveBeenCalledWith("run-staging", 1, { maximumEvents: 1, maximumBytes: 9 });
    await expect(executorGates[0]!.authorize({ kind: "click", target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" }, { job: { jobId: "job-staging", runId: "run-staging", projectId: "project-test", target: { kind: "web", url: "https://staging.example.test/" }, objective: "click", policy: { policyId: "policy-staging", environment: "staging", allowedOrigins: ["https://staging.example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2099-08-18T00:00:00.000Z", expiresAt: "2099-08-18T00:01:00.000Z" } }, action: { kind: "click", target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" } })).resolves.toMatchObject({ status: "allowed" });
  });

  it("injects one healthy value provider and advertises input/select capability", async () => {
    executorCapabilities.length = 0;
    const valueProvider = { resolve: vi.fn(async () => "plaintext-secret") };
    const target = { start: vi.fn(async () => undefined), close: vi.fn(async () => undefined), capture: vi.fn(), resolve: vi.fn(), execute: vi.fn() };
    const createTarget = vi.fn(() => target);
    const session = { accept: vi.fn(async () => ({ ...STARTUP_LEASE, jobId: "job-staging", runId: "run-staging" })), renew: vi.fn(), complete: vi.fn(async () => undefined), submit: vi.fn(), welcome: { traceBatchMaximumEvents: 1, traceBatchMaximumBytes: 9 } };
    const spool = { pending: vi.fn(async () => []), acknowledge: vi.fn() };
    const runtime = new RunnerOfferRuntime({
      createTarget: createTarget as never,
      session: session as never,
      spool: spool as never,
      config: config(),
      valueProvider,
    });

    await runtime.run({
      offerId: "offer-input",
      job: { jobId: "job-staging", runId: "run-staging", projectId: "project-test", target: { kind: "web", url: "https://example.test/" }, objective: "input", policy: { policyId: "policy-input", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["input", "select"], maximumRisk: "ExternalSideEffect", explorationAllowed: false, issuedAt: "2099-08-18T00:00:00.000Z", expiresAt: "2099-08-18T00:01:00.000Z" }, plan: { missionId: "mission-1", missionRevision: 1, testCaseId: "case-input", steps: [{ stepIndex: 0, kind: "input", target: { role: "textbox", purpose: "enter email" }, valueRef: "profile.email" }], expectedClaimIds: ["claim-1"], budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 1_000 } } },
      requiredCapabilities: [], leaseDurationMs: 30_000,
    } as never);

    expect(createTarget).toHaveBeenCalledWith(expect.objectContaining({ valueProvider }));
    expect(executorCapabilities[0]?.actionKinds).toEqual(["navigate", "click", "input", "select", "scroll"]);
  });

  it("passes the accepted immutable multi-step Plan unchanged to the executor", async () => {
    executedOffers.length = 0;
    executionSignals.length = 0;
    const target = { start: vi.fn(async () => undefined), close: vi.fn(async () => undefined), capture: vi.fn(), resolve: vi.fn(), execute: vi.fn() };
    const createTarget = vi.fn(() => target);
    const session = {
      accept: vi.fn(async () => ({ ...STARTUP_LEASE, jobId: "job-1", runId: "run-1" })),
      renew: vi.fn(),
      complete: vi.fn(async () => undefined),
      submit: vi.fn(),
      welcome: { traceBatchMaximumEvents: 1, traceBatchMaximumBytes: 9 },
    };
    const spool = { pending: vi.fn(async () => []), acknowledge: vi.fn() };
    const runtime = new RunnerOfferRuntime({ createTarget: createTarget as never, session: session as never, spool: spool as never, config: config(), valueProvider: { resolve: vi.fn() } });
    const plan = { missionId: "mission-1", missionRevision: 1, testCaseId: "case-1", steps: [{ stepIndex: 0, kind: "input" as const, target: { purpose: "email" }, valueRef: "profile.email" }, { stepIndex: 1, kind: "select" as const, target: { purpose: "country" }, valueRef: "profile.country" }] as const, expectedClaimIds: ["claim-1"] as [string], budget: { maximumStepsPerJob: 2, maximumWallClockMs: 1_000, maximumModelTokens: 1_000 } };
    const offeredJob = { jobId: "job-1", runId: "run-1", projectId: "project-test", target: { kind: "web" as const, url: "https://example.test/" }, objective: "execute both steps", policy: { policyId: "policy-1", environment: "isolated_test" as const, allowedOrigins: ["https://example.test"], allowedActionKinds: ["input", "select"] as const, maximumRisk: "ExternalSideEffect" as const, explorationAllowed: false, issuedAt: "2099-08-18T00:00:00.000Z", expiresAt: "2099-08-18T00:01:00.000Z" }, plan };
    const offer = {
      offerId: "offer-1",
      job: offeredJob,
      requiredCapabilities: ["action:input", "action:select"],
      leaseDurationMs: 30_000,
    };

    const abort = new AbortController();
    await runtime.run(offer, abort.signal);

    expect(executedOffers).toHaveLength(1);
    expect((executedOffers[0] as typeof offer).job).toBe(offeredJob);
    expect((executedOffers[0] as typeof offer).job.plan).toBe(plan);
    expect(executionSignals).toEqual([abort.signal]);
  });

  it("renews the authoritative lease window during target startup and completes with the renewed token", async () => {
    const state = { monotonic: 0, wall: 100_000 };
    const delay = new ManualDelay();
    let releaseStartup: (() => void) | undefined;
    const startup = new Promise<void>((resolve) => { releaseStartup = resolve; });
    const target = {
      start: vi.fn(async () => startup),
      capture: vi.fn(),
      resolve: vi.fn(),
      execute: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const renewedLease = { ...STARTUP_LEASE, leaseToken: "renewed-token", leaseEpoch: 2 };
    const session = {
      accept: vi.fn(async () => STARTUP_LEASE),
      renew: vi.fn(async () => renewedLease),
      submit: vi.fn(),
      complete: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
    };
    const { spool } = recordingSpool();
    const runtime = new RunnerOfferRuntime({
      createTarget: vi.fn(() => target) as never,
      session: session as never,
      spool,
      config: config(),
      leaseLifecycle: {
        clocks: { monotonicNow: () => state.monotonic, wallNow: () => state.wall },
        actionDeadlineSafetyMarginMs: 0,
        renewalDelay: delay,
      },
    });

    const running = runtime.run(admittedOffer());
    await waitFor(() => expect(delay.waits).toEqual([10_000]));
    expect(target.start).toHaveBeenCalledOnce();
    state.monotonic = 10_000;
    delay.release();
    await waitFor(() => expect(session.renew).toHaveBeenCalledWith(STARTUP_LEASE));
    state.monotonic = 35_000;
    releaseStartup?.();
    await running;

    expect(executionLifecycles).toHaveLength(1);
    expect(executionWindowStates).toEqual([true]);
    expect(session.complete).toHaveBeenCalledWith(
      renewedLease,
      expect.objectContaining({ status: "passed" }),
    );
    expect(target.close).toHaveBeenCalledOnce();
  });

  it("renews while terminal Trace ACK is delayed beyond the original lease and completes with the latest token", async () => {
    const state = { monotonic: 0, wall: 100_000 };
    const delay = new ManualDelay();
    let releaseAck: ((ack: { readonly batchId: string; readonly runId: string; readonly nextExpectedSequenceNumber: number }) => void) | undefined;
    let submittedBatch: ExecutionEventBatch | undefined;
    const target = {
      start: vi.fn(async () => { throw new WebTargetError("NavigationFailed"); }),
      capture: vi.fn(),
      resolve: vi.fn(),
      execute: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const renewedLease = { ...STARTUP_LEASE, leaseToken: "renewed-during-drain", leaseEpoch: 2 };
    const session = {
      accept: vi.fn(async () => STARTUP_LEASE),
      renew: vi.fn(async () => renewedLease),
      submit: vi.fn((batch: ExecutionEventBatch) => {
        submittedBatch = batch;
        return new Promise((resolve) => { releaseAck = resolve; });
      }),
      complete: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
    };
    const runtime = new RunnerOfferRuntime({
      createTarget: vi.fn(() => target) as never,
      session: session as never,
      spool: recordingSpool().spool,
      config: config(),
      leaseLifecycle: {
        clocks: { monotonicNow: () => state.monotonic, wallNow: () => state.wall },
        actionDeadlineSafetyMarginMs: 0,
        renewalDelay: delay,
      },
    });

    const running = runtime.run(admittedOffer());
    await waitFor(() => expect(session.submit).toHaveBeenCalledOnce());
    state.monotonic = 10_000;
    delay.release();
    await waitFor(() => expect(session.renew).toHaveBeenCalledWith(STARTUP_LEASE));
    state.monotonic = 31_000;
    const batch = submittedBatch!;
    releaseAck?.({
      batchId: batch.batchId,
      runId: batch.runId,
      nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
    });
    await running;

    expect(session.complete).toHaveBeenCalledWith(
      renewedLease,
      expect.objectContaining({ status: "error", errorCode: "NavigationFailed" }),
    );
    delay.release();
    await Promise.resolve();
    expect(session.renew).toHaveBeenCalledOnce();
  });

  it.each(["renewal failure", "expiry"] as const)(
    "aborts a delayed terminal Trace drain and does not complete on %s",
    async (failureMode) => {
      const state = { monotonic: 0, wall: 100_000 };
      const renewalFailure = failureMode === "renewal failure" ? new Error("LeaseLost") : undefined;
      const delay = new ManualDelay();
      let releaseAck: ((ack: { readonly batchId: string; readonly runId: string; readonly nextExpectedSequenceNumber: number }) => void) | undefined;
      let submittedBatch: ExecutionEventBatch | undefined;
      const target = {
        start: vi.fn(async () => { throw new WebTargetError("NavigationFailed"); }),
        capture: vi.fn(),
        resolve: vi.fn(),
        execute: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      const { spool, acknowledge } = recordingSpool();
      const session = {
        accept: vi.fn(async () => STARTUP_LEASE),
        renew: vi.fn(async () => {
          if (renewalFailure !== undefined) throw renewalFailure;
          return STARTUP_LEASE;
        }),
        submit: vi.fn((batch: ExecutionEventBatch) => {
          submittedBatch = batch;
          return new Promise((resolve) => { releaseAck = resolve; });
        }),
        complete: vi.fn(),
        close: vi.fn(async () => undefined),
        welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
      };
      const runtime = new RunnerOfferRuntime({
        createTarget: vi.fn(() => target) as never,
        session: session as never,
        spool,
        config: config(),
        leaseLifecycle: {
          clocks: { monotonicNow: () => state.monotonic, wallNow: () => state.wall },
          actionDeadlineSafetyMarginMs: 0,
          renewalDelay: delay,
        },
      });

      const running = runtime.run(admittedOffer());
      await waitFor(() => expect(session.submit).toHaveBeenCalledOnce());
      if (failureMode === "expiry") state.monotonic = 30_000;
      delay.release();
      if (renewalFailure === undefined) {
        await expect(running).rejects.toMatchObject({ code: "LeaseExpired" });
        expect(session.renew).not.toHaveBeenCalled();
      } else {
        await expect(running).rejects.toBe(renewalFailure);
      }

      expect(session.complete).not.toHaveBeenCalled();
      expect(target.close).toHaveBeenCalledOnce();
      const batch = submittedBatch!;
      releaseAck?.({
        batchId: batch.batchId,
        runId: batch.runId,
        nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
      });
      await Promise.resolve();
      expect(acknowledge).not.toHaveBeenCalled();
    },
  );

  it("aborts target startup without terminal completion when the lease expires", async () => {
    const state = { monotonic: 0, wall: 100_000 };
    const delay = new ManualDelay();
    let startupSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const target = {
      start: vi.fn(async (signal?: AbortSignal) => {
        startupSignal = signal;
        markStarted?.();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
      capture: vi.fn(),
      resolve: vi.fn(),
      execute: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const { spool, appended } = recordingSpool();
    const session = {
      accept: vi.fn(async () => STARTUP_LEASE),
      renew: vi.fn(),
      submit: vi.fn(async (batch: ExecutionEventBatch) => ({
        batchId: batch.batchId,
        runId: batch.runId,
        nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
      })),
      complete: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
    };
    const runtime = new RunnerOfferRuntime({
      createTarget: vi.fn(() => target) as never,
      session: session as never,
      spool,
      config: config(),
      leaseLifecycle: {
        clocks: { monotonicNow: () => state.monotonic, wallNow: () => state.wall },
        actionDeadlineSafetyMarginMs: 0,
        renewalDelay: delay,
      },
    });

    const running = runtime.run(admittedOffer());
    await started;
    state.monotonic = 30_000;
    delay.release();
    await expect(running).rejects.toMatchObject({ code: "LeaseExpired" });

    expect(delay.waits).toEqual([10_000]);
    expect(startupSignal?.aborted).toBe(true);
    expect(session.renew).not.toHaveBeenCalled();
    expect(modelConstructions).toEqual([]);
    expect(executedOffers).toEqual([]);
    expect(target.capture).not.toHaveBeenCalled();
    expect(target.execute).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
    expect(session.complete).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalledOnce();
  });

  it("blocks a cross-origin initial redirect before observation or model construction", async () => {
    const destination = await startServer((_request, response) => {
      response.end("destination");
    });
    const source = await startServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", `${destination.origin}/final`);
      response.end();
    });
    const offer = admittedOffer();
    const redirectedOffer: ExecutionJobOffer = {
      ...offer,
      job: {
        ...offer.job,
        target: { kind: "web", url: `${source.origin}/redirect` },
        policy: {
          ...offer.job.policy,
          allowedOrigins: [source.origin, destination.origin],
        },
      },
    };
    const { spool, appended } = recordingSpool();
    const session = {
      accept: vi.fn(async () => STARTUP_LEASE),
      renew: vi.fn(),
      submit: vi.fn(async (batch: ExecutionEventBatch) => ({
        batchId: batch.batchId,
        runId: batch.runId,
        nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
      })),
      complete: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
    };
    const runtime = new RunnerOfferRuntime({
      session: session as never,
      spool,
      config: config(),
    });

    try {
      await runtime.run(redirectedOffer);
    } finally {
      await source.close();
      await destination.close();
    }

    expect(executedOffers).toEqual([]);
    expect(modelConstructions).toEqual([]);
    expect(appended.at(-1)).toMatchObject({
      stage: "run_completed",
      payload: { status: "blocked", errorCode: "OriginViolation" },
    });
    expect(session.complete).toHaveBeenCalledWith(
      STARTUP_LEASE,
      expect.objectContaining({ status: "blocked", errorCode: "OriginViolation" }),
    );
  });

  it("aborts target startup and does not complete when lease renewal fails", async () => {
    const failure = new Error("LeaseLost");
    const delay = new ManualDelay();
    let startupSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const target = {
      start: vi.fn(async (signal?: AbortSignal) => {
        startupSignal = signal;
        markStarted?.();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
      capture: vi.fn(),
      resolve: vi.fn(),
      execute: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const session = {
      accept: vi.fn(async () => STARTUP_LEASE),
      renew: vi.fn(async () => { throw failure; }),
      submit: vi.fn(),
      complete: vi.fn(),
      close: vi.fn(async () => undefined),
      welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
    };
    const runtime = new RunnerOfferRuntime({
      createTarget: vi.fn(() => target) as never,
      session: session as never,
      spool: recordingSpool().spool,
      config: config(),
      leaseLifecycle: { renewalDelay: delay },
    });

    const running = runtime.run(admittedOffer());
    await started;
    delay.release();

    await expect(running).rejects.toBe(failure);
    expect(startupSignal?.aborted).toBe(true);
    expect(modelConstructions).toEqual([]);
    expect(executedOffers).toEqual([]);
    expect(session.complete).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalledOnce();
  });

  it("does not drain or complete a normal execution disposition when terminal Trace persistence fails", async () => {
    const failure = Object.assign(new Error("terminal Trace append failed"), {
      code: "TerminalTracePersistenceFailed",
      disposition: "terminal_persistence_failed",
    });
    executorFailure = failure;
    const target = {
      start: vi.fn(async () => undefined),
      capture: vi.fn(),
      resolve: vi.fn(),
      execute: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const { spool, pending } = recordingSpool();
    const session = {
      accept: vi.fn(async () => STARTUP_LEASE),
      renew: vi.fn(),
      submit: vi.fn(),
      complete: vi.fn(),
      close: vi.fn(async () => undefined),
      welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
    };
    const runtime = new RunnerOfferRuntime({
      createTarget: vi.fn(() => target) as never,
      session: session as never,
      spool,
      config: config(),
    });

    await expect(runtime.run(admittedOffer())).rejects.toBe(failure);

    expect(pending).not.toHaveBeenCalled();
    expect(session.submit).not.toHaveBeenCalled();
    expect(session.complete).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["StaleObservation", "blocked"],
    ["UnknownObservationNode", "blocked"],
    ["TargetNotFound", "blocked"],
    ["AmbiguousTarget", "blocked"],
    ["OriginViolation", "blocked"],
    ["ActionTimedOut", "blocked"],
    ["TargetNotVisible", "blocked"],
    ["TargetDisabled", "blocked"],
    ["ActionValueUnavailable", "blocked"],
    ["UnsupportedAction", "blocked"],
    ["BrowserLaunchFailed", "error"],
    ["NavigationFailed", "error"],
    ["NavigationTimedOut", "error"],
    ["ActionInfrastructureFailure", "error"],
    ["ConcurrentSessionOperation", "error"],
    ["SessionClosed", "error"],
  ] as const)("terminalizes startup WebTargetError %s as %s after accepting its lease", async (code, status) => {
    const target = {
      start: vi.fn(async () => { throw new WebTargetError(code); }),
      capture: vi.fn(),
      resolve: vi.fn(),
      execute: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const { spool, appended, append, acknowledge } = recordingSpool();
    const session = {
      accept: vi.fn(async () => STARTUP_LEASE),
      submit: vi.fn(async (batch: ExecutionEventBatch) => ({
        batchId: batch.batchId,
        runId: batch.runId,
        nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
      })),
      complete: vi.fn(async () => undefined),
      welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
    };
    const runtime = new RunnerOfferRuntime({
      createTarget: vi.fn(() => target) as never,
      session: session as never,
      spool,
      config: config(),
    });

    await runtime.run(admittedOffer());

    expect(session.accept).toHaveBeenCalledOnce();
    expect(session.accept).toHaveBeenCalledWith("offer-startup");
    expect(session.accept.mock.invocationCallOrder[0]!).toBeLessThan(target.start.mock.invocationCallOrder[0]!);
    expect(append).toHaveBeenCalledOnce();
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      runId: STARTUP_LEASE.runId,
      sequenceNumber: 1,
      stage: "run_completed",
      payload: { status, errorCode: code },
    });
    expect(session.submit).toHaveBeenCalledOnce();
    expect(session.submit.mock.calls[0]?.[0].events).toEqual(appended);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(session.complete).toHaveBeenCalledOnce();
    expect(session.complete).toHaveBeenCalledWith(STARTUP_LEASE, {
      jobId: STARTUP_LEASE.jobId,
      runId: STARTUP_LEASE.runId,
      status,
      errorCode: code,
    });
    expect(acknowledge.mock.invocationCallOrder[0]!).toBeLessThan(session.complete.mock.invocationCallOrder[0]!);
    expect(target.capture).not.toHaveBeenCalled();
    expect(target.resolve).not.toHaveBeenCalled();
    expect(target.execute).not.toHaveBeenCalled();
    expect(modelConstructions).toEqual([]);
    expect(executedOffers).toEqual([]);
    expect(target.close).toHaveBeenCalledOnce();
  });

  it("does not complete when startup terminal Trace append fails", async () => {
    const failure = new Error("spool append unavailable");
    const target = {
      start: vi.fn(async () => { throw new WebTargetError("BrowserLaunchFailed"); }),
      capture: vi.fn(),
      resolve: vi.fn(),
      execute: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const { spool, append, pending } = recordingSpool({ appendError: failure });
    const session = {
      accept: vi.fn(async () => STARTUP_LEASE),
      submit: vi.fn(),
      complete: vi.fn(),
      welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
    };
    const runtime = new RunnerOfferRuntime({
      createTarget: vi.fn(() => target) as never,
      session: session as never,
      spool,
      config: config(),
    });

    await expect(runtime.run(admittedOffer())).rejects.toMatchObject({
      code: "TerminalTracePersistenceFailed",
      disposition: "terminal_persistence_failed",
      cause: failure,
    });

    expect(session.accept).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
    expect(pending).not.toHaveBeenCalled();
    expect(session.submit).not.toHaveBeenCalled();
    expect(session.complete).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalledOnce();
  });

  it.each(["submit", "acknowledge"] as const)("does not retry or complete when startup Trace %s fails", async (failurePoint) => {
    const failure = new Error(`${failurePoint} unavailable`);
    const target = {
      start: vi.fn(async () => { throw new WebTargetError("NavigationFailed"); }),
      capture: vi.fn(),
      resolve: vi.fn(),
      execute: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const { spool, appended, append, pending, acknowledge } = recordingSpool(
      failurePoint === "acknowledge" ? { acknowledgeError: failure } : {},
    );
    const session = {
      accept: vi.fn(async () => STARTUP_LEASE),
      submit: vi.fn(async (batch: ExecutionEventBatch) => {
        if (failurePoint === "submit") throw failure;
        return {
          batchId: batch.batchId,
          runId: batch.runId,
          nextExpectedSequenceNumber: batch.firstSequenceNumber + batch.events.length,
        };
      }),
      complete: vi.fn(),
      welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
    };
    const runtime = new RunnerOfferRuntime({
      createTarget: vi.fn(() => target) as never,
      session: session as never,
      spool,
      config: config(),
    });

    await expect(runtime.run(admittedOffer())).rejects.toBe(failure);

    expect(append).toHaveBeenCalledOnce();
    expect(appended).toHaveLength(1);
    expect(pending).toHaveBeenCalledOnce();
    expect(session.submit).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledTimes(failurePoint === "acknowledge" ? 1 : 0);
    expect(session.complete).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalledOnce();
  });

  it("propagates an unexpected startup error after cleanup without terminalizing it", async () => {
    const failure = new Error("programmer error");
    const target = {
      start: vi.fn(async () => { throw failure; }),
      capture: vi.fn(),
      resolve: vi.fn(),
      execute: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const { spool, append } = recordingSpool();
    const session = {
      accept: vi.fn(async () => STARTUP_LEASE),
      submit: vi.fn(),
      complete: vi.fn(),
      welcome: { traceBatchMaximumEvents: 10, traceBatchMaximumBytes: 10_000 },
    };
    const runtime = new RunnerOfferRuntime({
      createTarget: vi.fn(() => target) as never,
      session: session as never,
      spool,
      config: config(),
    });

    await expect(runtime.run(admittedOffer())).rejects.toBe(failure);

    expect(session.accept).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
    expect(session.submit).not.toHaveBeenCalled();
    expect(session.complete).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["staging exploration", { explorationAllowed: true }],
    ["staging coordinate fallback", { allowedActionKinds: ["coordinate"] }],
    ["staging visual fallback", { allowedActionKinds: ["visual"] }],
  ])("denies %s before target creation", async (_name, override) => {
    const createTarget = vi.fn();
    const session = { accept: vi.fn(async () => ({ jobId: "job-1", runId: "run-1", leaseToken: "token", leaseEpoch: 1, expiresAt: "2099-08-18T00:01:00.000Z" })), complete: vi.fn(async () => undefined) };
    const runtime = new RunnerOfferRuntime({ createTarget, session: session as never, spool: {} as never, config: {} as never });
    await runtime.run({ offerId: "offer-1", job: { jobId: "job-1", runId: "run-1", target: { kind: "web", url: "https://staging.example.test/" }, objective: "blocked", policy: { policyId: "policy-staging", environment: "staging", allowedOrigins: ["https://staging.example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2099-08-18T00:00:00.000Z", expiresAt: "2099-08-18T00:01:00.000Z", ...override } }, requiredCapabilities: [], leaseDurationMs: 30_000 } as never);
    expect(createTarget).not.toHaveBeenCalled();
    expect(session.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ errorCode: "PolicyMissing" }));
  });
});

async function waitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}
