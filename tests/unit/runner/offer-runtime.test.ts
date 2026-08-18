import { describe, expect, it, vi } from "vitest";
import { RunnerOfferRuntime } from "../../../apps/runner/src/offer-runtime.js";

describe("RunnerOfferRuntime", () => {
  it("blocks a policyless offer before target construction or browser navigation", async () => {
    const target = {
      start: vi.fn(), // Browser launch and initial page.goto are behind start.
      capture: vi.fn(), // Observation before model decision.
      resolve: vi.fn(),
      execute: vi.fn(), // Receives a constructed permit only on an allowed run.
      close: vi.fn(),
    };
    const createTarget = vi.fn(() => target);
    const session = {
      accept: vi.fn(async () => ({ jobId: "job-1", runId: "run-1", leaseToken: "token", leaseEpoch: 1, expiresAt: "2026-08-18T00:01:00.000Z" })),
      complete: vi.fn(async () => undefined),
    };
    const runtime = new RunnerOfferRuntime({ createTarget: createTarget as never, session, spool: {} as never, config: {} as never });

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
    const runtime = new RunnerOfferRuntime({ createTarget, session, spool: {} as never, config: {} as never });
    await runtime.run({
      offerId: "offer-1",
      job: {
        jobId: "job-1", runId: "run-1", target: { kind: "web", url: "https://evil.test/" }, objective: "must block",
        policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
      }, requiredCapabilities: [], leaseDurationMs: 30_000,
    });
    expect(createTarget).not.toHaveBeenCalled();
    expect(session.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ errorCode: "PolicyDenied" }));
  });
});
