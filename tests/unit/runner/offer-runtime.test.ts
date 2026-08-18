import { describe, expect, it, vi } from "vitest";
import type { RunnerPolicyGate } from "@qualigence/runner-kernel";

const executorGates: RunnerPolicyGate[] = [];
vi.mock("../../../apps/runner/src/job-executor.js", () => ({
  LeasedJobExecutor: class {
    constructor(dependencies: { readonly policyGate: RunnerPolicyGate }) {
      executorGates.push(dependencies.policyGate);
    }
    async execute() {
      return {
        lease: { jobId: "job-staging", runId: "run-staging", leaseToken: "token", leaseEpoch: 1, expiresAt: "2099-08-18T00:01:00.000Z" },
        completion: { jobId: "job-staging", runId: "run-staging", status: "passed" as const },
      };
    }
  },
}));
import { RunnerOfferRuntime } from "../../../apps/runner/src/offer-runtime.js";

describe("RunnerOfferRuntime", () => {
  function config() {
    return { headed: false, navigationTimeoutMs: 1_000, actionTimeoutMs: 1_000, model: { baseUrl: "https://models.test", apiKey: "secret", modelName: "test" } } as never;
  }

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
        jobId: "job-1", runId: "run-1", target: { kind: "web", url: "https://evil.test/" }, objective: "must block",
        policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2099-08-18T00:00:00.000Z", expiresAt: "2099-08-18T00:01:00.000Z" },
      }, requiredCapabilities: [], leaseDurationMs: 30_000,
    });
    expect(createTarget).not.toHaveBeenCalled();
    expect(session.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ errorCode: "PolicyDenied" }));
  });

  it("passes only staging policy origins to an admitted target", async () => {
    executorGates.length = 0;
    const target = { start: vi.fn(async () => undefined), close: vi.fn(async () => undefined), capture: vi.fn(), resolve: vi.fn(), execute: vi.fn() };
    const createTarget = vi.fn(() => target) as never;
    const session = { accept: vi.fn(), complete: vi.fn(async () => undefined), submit: vi.fn(), welcome: { traceBatchMaximumEvents: 1, traceBatchMaximumBytes: 9 } };
    const spool = { pending: vi.fn(async () => []), acknowledge: vi.fn() };
    const runtime = new RunnerOfferRuntime({ createTarget, session: session as never, spool: spool as never, config: config() });
    await runtime.run({
      offerId: "offer-staging",
      job: { jobId: "job-staging", runId: "run-staging", target: { kind: "web", url: "https://staging.example.test/" }, objective: "click", policy: { policyId: "policy-staging", environment: "staging", allowedOrigins: ["https://staging.example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2099-08-18T00:00:00.000Z", expiresAt: "2099-08-18T00:01:00.000Z" } },
      requiredCapabilities: [], leaseDurationMs: 30_000,
    } as never);
    expect((createTarget as unknown as { mock: { calls: Array<readonly [{ readonly allowedOrigins: readonly string[] }]> } }).mock.calls[0]?.[0]?.allowedOrigins).toEqual(["https://staging.example.test"]);
    expect(executorGates).toHaveLength(1);
    expect(spool.pending).toHaveBeenCalledWith("run-staging", 1, { maximumEvents: 1, maximumBytes: 9 });
    await expect(executorGates[0]!.authorize({ kind: "click", target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" }, { job: { jobId: "job-staging", runId: "run-staging", target: { kind: "web", url: "https://staging.example.test/" }, objective: "click", policy: { policyId: "policy-staging", environment: "staging", allowedOrigins: ["https://staging.example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2099-08-18T00:00:00.000Z", expiresAt: "2099-08-18T00:01:00.000Z" } }, action: { kind: "click", target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" } })).resolves.toMatchObject({ status: "allowed" });
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
