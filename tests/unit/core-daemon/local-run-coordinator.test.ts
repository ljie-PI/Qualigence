import { describe, expect, it, vi } from "vitest";
import { LocalRunCoordinator } from "../../../apps/core-daemon/src/local/local-run-coordinator.js";

describe("LocalRunCoordinator", () => {
  it("quarantines offer uncertainty and never re-offers it", async () => {
    const store = {
      quarantineInterruptedDispatches: vi.fn(async () => 0),
      pendingDispatches: vi.fn(async () => [{ runId: "run-1", expectedAttempt: 0 }]),
      beginOffer: vi.fn(async () => true),
      markOffered: vi.fn(async () => true),
      markOfferOutcomeUnknown: vi.fn(async () => true),
      pendingCompletions: vi.fn(async () => []),
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
});
