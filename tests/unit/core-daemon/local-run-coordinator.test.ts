import { describe, expect, it, vi } from "vitest";
import { LocalRunCoordinator } from "../../../apps/core-daemon/src/local/local-run-coordinator.js";
import { RunnerControlStoreError } from "@qualigence/runner-control";

describe("LocalRunCoordinator", () => {
  it("quarantines offer uncertainty and never re-offers it", async () => {
    const store = {
      quarantineInterruptedDispatches: vi.fn(async () => 0),
      pendingDispatches: vi.fn(async () => [{ runId: "run-1", expectedAttempt: 0 }]),
      beginOffer: vi.fn(async () => true),
      markOffered: vi.fn(async () => true),
      markOfferOutcomeUnknown: vi.fn(async () => true),
      pendingCompletions: vi.fn(async () => []),
      hasCompletionBlockers: vi.fn(async () => false),
    };
    const offer = vi.fn(async () => { throw new Error("connection lost after write start"); });
    const coordinator = new LocalRunCoordinator({
      store: store as never,
      connection: () => ({ authenticatedRunner: { runnerId: "runner-1", scope: { kind: "local" }, capabilities: ["target:web-playwright"] }, offer, cancel: vi.fn() }),
      configuredRunnerId: "runner-1",
      now: () => "2026-08-19T00:00:00.000Z",
    });
    await coordinator.dispatchPass();
    expect(store.markOfferOutcomeUnknown).toHaveBeenCalledOnce();
    expect(offer).toHaveBeenCalledOnce();
  });

  it("blocks a mismatched authoritative Job hash without applying completion", async () => {
    const store = {
      pendingCompletions: vi.fn(async () => [{ runId: "run-1", jobId: "job-1", jobSha256: "a".repeat(64), expectedAttempt: 0 }]),
      applyCompletion: vi.fn(),
      markIntegrityBlocked: vi.fn(async () => "blocked" as const),
      recordCompletionFailure: vi.fn(),
      hasCompletionBlockers: vi.fn(async () => true),
    };
    const coordinator = new LocalRunCoordinator({
      store: store as never,
      controlStore: { completionRecord: vi.fn(async () => ({ runId: "run-1", jobId: "job-1", jobSha256: "b".repeat(64), completion: { jobId: "job-1", runId: "run-1", status: "passed" }, completedAt: "2026-08-19T00:00:01.000Z" })) } as never,
      connection: () => undefined,
      configuredRunnerId: "runner-1",
      now: () => "2026-08-19T00:00:02.000Z",
    });

    await coordinator.reconciliationPass();

    expect(store.applyCompletion).not.toHaveBeenCalled();
    expect(store.markIntegrityBlocked).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "CompletionIdentityMismatch" }));
    expect(coordinator.isHealthy()).toBe(false);
  });

  it("integrity-blocks an inconsistent persisted completion identity immediately", async () => {
    const store = {
      pendingCompletions: vi.fn(async () => [{ runId: "run-1", jobId: "job-1", jobSha256: "a".repeat(64), expectedAttempt: 0 }]),
      markIntegrityBlocked: vi.fn(async () => "blocked" as const),
      recordCompletionFailure: vi.fn(),
      hasCompletionBlockers: vi.fn(async () => true),
    };
    const coordinator = new LocalRunCoordinator({
      store: store as never,
      controlStore: { completionRecord: vi.fn(async () => { throw new RunnerControlStoreError("persisted completion identity is inconsistent", "CompletionIdentityMismatch"); }) } as never,
      connection: () => undefined,
      configuredRunnerId: "runner-1",
      now: () => "2026-08-19T00:00:00.000Z",
    });

    await coordinator.reconciliationPass();

    expect(store.markIntegrityBlocked).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "CompletionIdentityMismatch" }));
    expect(store.recordCompletionFailure).not.toHaveBeenCalled();
    expect(coordinator.isHealthy()).toBe(false);
  });

  it("keeps the retained loop alive after a recoverable pass error and restores health", async () => {
    let reconciliationCalls = 0;
    const store = {
      pendingDispatches: vi.fn(async () => []),
      pendingCompletions: vi.fn(async () => {
        reconciliationCalls += 1;
        if (reconciliationCalls === 1) throw new Error("sqlite busy");
        return [];
      }),
      hasCompletionBlockers: vi.fn(async () => false),
    };
    const coordinator = new LocalRunCoordinator({
      store: store as never,
      controlStore: {} as never,
      connection: () => undefined,
      configuredRunnerId: "runner-1",
    });

    coordinator.startLive(50);
    await expect.poll(() => reconciliationCalls).toBe(1);
    expect(coordinator.isHealthy()).toBe(false);
    await expect.poll(() => reconciliationCalls).toBeGreaterThanOrEqual(2);
    expect(coordinator.isHealthy()).toBe(true);
    await coordinator.shutdown();
  });

  it("marks a recoverable candidate failure unhealthy until a later successful pass", async () => {
    let attempts = 0;
    const store = {
      pendingCompletions: vi.fn(async () => attempts === 0 ? [{ runId: "run-1", jobId: "job-1", jobSha256: "a".repeat(64), expectedAttempt: 0 }] : []),
      recordCompletionFailure: vi.fn(async () => { attempts += 1; return { status: "scheduled" as const, attempt: 1, nextAttemptAt: "2026-08-19T00:00:01.000Z" }; }),
      hasCompletionBlockers: vi.fn(async () => false),
    };
    const coordinator = new LocalRunCoordinator({ store: store as never, controlStore: { completionRecord: vi.fn(async () => { throw new Error("sqlite busy"); }) } as never, connection: () => undefined, configuredRunnerId: "runner-1", now: () => "2026-08-19T00:00:00.000Z" });

    await coordinator.reconciliationPass();
    expect(coordinator.isHealthy()).toBe(false);
    await coordinator.reconciliationPass();
    expect(coordinator.isHealthy()).toBe(true);
  });

  it("aborts a retained poll delay and awaits loop exit during shutdown", async () => {
    const store = { pendingDispatches: vi.fn(async () => []), pendingCompletions: vi.fn(async () => []), hasCompletionBlockers: vi.fn(async () => false) };
    const coordinator = new LocalRunCoordinator({ store: store as never, controlStore: {} as never, connection: () => undefined, configuredRunnerId: "runner-1" });
    coordinator.startLive(60_000);
    await expect.poll(() => store.pendingCompletions).toHaveBeenCalled();
    await expect(coordinator.shutdown()).resolves.toBeUndefined();
  });

  it("initializes health from durable blockers and never clears it on an empty pass", async () => {
    const store = {
      quarantineInterruptedDispatches: vi.fn(async () => 0),
      pendingCompletions: vi.fn(async () => []),
      hasCompletionBlockers: vi.fn(async () => true),
    };
    const coordinator = new LocalRunCoordinator({ store: store as never, controlStore: {} as never, connection: () => undefined, configuredRunnerId: "runner-1" });

    await coordinator.startup();
    expect(coordinator.isHealthy()).toBe(false);
    await coordinator.reconciliationPass();
    expect(coordinator.isHealthy()).toBe(false);
  });

  it("becomes unhealthy immediately when a pending completion exhausts retries", async () => {
    const store = {
      pendingCompletions: vi.fn(async () => [{ runId: "run-1", jobId: "job-1", jobSha256: "a".repeat(64), expectedAttempt: 7 }]),
      recordCompletionFailure: vi.fn(async () => ({ status: "blocked" as const })),
      hasCompletionBlockers: vi.fn(async () => true),
    };
    const coordinator = new LocalRunCoordinator({ store: store as never, controlStore: { completionRecord: vi.fn(async () => undefined) } as never, connection: () => undefined, configuredRunnerId: "runner-1" });

    await coordinator.reconciliationPass();
    expect(coordinator.isHealthy()).toBe(false);
  });
});
