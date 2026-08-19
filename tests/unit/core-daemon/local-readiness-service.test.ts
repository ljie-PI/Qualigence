import { describe, expect, it } from "vitest";
import { LocalReadinessService } from "../../../apps/core-daemon/src/local/local-readiness-service.js";

describe("LocalReadinessService", () => {
  it("separates internal readiness from configured Runner capability readiness", async () => {
    let connection: import("@qualigence/grpc-runner-protocol").RunnerConnectionPort | undefined;
    const service = new LocalReadinessService({
      schemaVersion: async () => 7,
      storageProbe: async () => undefined,
      artifactProbe: async () => undefined,
      listeners: () => ({ http: true, grpc: true }),
      reconciliationHealthy: () => true,
      configuredRunnerId: "runner-1",
      connection: () => connection,
    });
    await expect(service.internalReady()).resolves.toBe(true);
    await expect(service.ready()).resolves.toBe(false);
    connection = { authenticatedRunner: { runnerId: "runner-1", scope: { kind: "local" }, capabilities: ["target:web-playwright"] }, offer: async () => { throw new Error("unused"); }, cancel: async () => undefined };
    await expect(service.ready()).resolves.toBe(true);
    service.quiesce();
    await expect(service.ready()).resolves.toBe(false);
  });
});
