import { describe, expect, it } from "vitest";
import { InMemoryTraceStore } from "@qualigence/evidence";
import {
  TenantRunnerApplicationResolver,
} from "@qualigence/core-application";
import type { AuthenticatedRunnerContext } from "@qualigence/runner-control";
import { InMemoryRunnerControlStore } from "../../helpers/in-memory-runner-control-store.js";
import { makeHello, welcomeParameters } from "../../helpers/grpc-harness.js";
import { WEB_GRAPH_V1_REQUIREMENTS, webJob } from "../../helpers/core-runner-harness.js";

function tenantIdentity(tenantId: string, runnerId = "runner-shared", projectIds = ["project-1"]): AuthenticatedRunnerContext {
  return {
    runnerId,
    certificateFingerprint: `fp-${tenantId}-${runnerId}`,
    scope: { kind: "tenant", tenantId, projectIds },
  };
}

describe("TenantRunnerApplicationResolver", () => {
  it("caches one tenant-bound application graph per tenant without sharing runner-control stores", async () => {
    const stores = new Map<string, InMemoryRunnerControlStore>();
    const resolver = new TenantRunnerApplicationResolver({
      welcome: welcomeParameters(),
      runnerControlStore: (tenantId) => {
        const store = new InMemoryRunnerControlStore();
        stores.set(tenantId, store);
        return store;
      },
      traceStore: () => new InMemoryTraceStore(),
      integrityEvents: { emit: () => undefined },
      now: () => Date.parse("2026-08-18T00:00:00.000Z"),
      generateSessionId: () => `session-${stores.size}`,
      generateOfferId: () => `offer-${stores.size}`,
      generateLeaseToken: () => `lease-${stores.size}`,
    });

    const tenantA = resolver.resolve(tenantIdentity("tenant-a"));
    const tenantAAgain = resolver.resolve(tenantIdentity("tenant-a"));
    const tenantB = resolver.resolve(tenantIdentity("tenant-b"));
    expect(tenantAAgain).toBe(tenantA);
    expect(tenantB).not.toBe(tenantA);

    const welcomeA = await tenantA.openSession(makeHello("runner-shared"), tenantIdentity("tenant-a"));
    const welcomeB = await tenantB.openSession(makeHello("runner-shared"), tenantIdentity("tenant-b"));
    const jobA = webJob({ runId: "same-run-id", jobId: "job-a" });
    const jobB = webJob({ runId: "same-run-id", jobId: "job-b" });

    const offerA = await tenantA.createOffer(welcomeA.sessionId, jobA, WEB_GRAPH_V1_REQUIREMENTS);
    const offerB = await tenantB.createOffer(welcomeB.sessionId, jobB, WEB_GRAPH_V1_REQUIREMENTS);
    const leaseA = await tenantA.accept(welcomeA.sessionId, offerA.offerId);
    const leaseB = await tenantB.accept(welcomeB.sessionId, offerB.offerId);

    expect(leaseA.runId).toBe("same-run-id");
    expect(leaseB.runId).toBe("same-run-id");
    await expect(stores.get("tenant-a")?.lease("same-run-id")).resolves.toMatchObject({ job: { jobId: "job-a" } });
    await expect(stores.get("tenant-b")?.lease("same-run-id")).resolves.toMatchObject({ job: { jobId: "job-b" } });
  });

  it("rejects local identities so Self-hosted connections cannot use an implicit tenant", () => {
    const resolver = new TenantRunnerApplicationResolver({
      welcome: welcomeParameters(),
      runnerControlStore: () => new InMemoryRunnerControlStore(),
      traceStore: () => new InMemoryTraceStore(),
      integrityEvents: { emit: () => undefined },
    });

    expect(() => resolver.resolve({
      runnerId: "runner-local",
      certificateFingerprint: "fp-local",
      scope: { kind: "local" },
    })).toThrow(/tenant scope/);
  });
});
