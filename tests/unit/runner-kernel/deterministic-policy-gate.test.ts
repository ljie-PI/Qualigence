import { describe, expect, it } from "vitest";
import { DeterministicRunnerPolicyGate } from "@qualigence/runner-kernel";
import type { AcceptedExecutionJob } from "@qualigence/runner-protocol";

const policy = {
  policyId: "policy-isolated",
  environment: "isolated_test" as const,
  allowedOrigins: ["https://example.test"],
  allowedActionKinds: ["click"] as const,
  maximumRisk: "Normal" as const,
  explorationAllowed: false,
  issuedAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T00:01:00.000Z",
};

describe("DeterministicRunnerPolicyGate", () => {
  const job = (overrides: Partial<AcceptedExecutionJob> = {}): AcceptedExecutionJob => ({
    jobId: "job-1",
    runId: "run-1",
    target: { kind: "web", url: "https://example.test/" },
    objective: "click",
    policy,
    ...overrides,
  });
  const click = { kind: "click" as const, target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" };

  it("denies an expired policy before permit construction", async () => {
    const gate = new DeterministicRunnerPolicyGate(policy, { now: () => Date.parse("2026-08-18T00:02:00.000Z") });
    await expect(
      gate.authorize(click, { job: job(), action: click }),
    ).resolves.toMatchObject({ status: "denied", reason: "PolicyExpired" });
  });

  it("allows an isolated same-origin click and denies a cross-origin target", async () => {
    const gate = new DeterministicRunnerPolicyGate(policy, { now: () => Date.parse("2026-08-18T00:00:30.000Z") });
    await expect(gate.authorize(click, { job: job(), action: click })).resolves.toMatchObject({ status: "allowed" });
    await expect(gate.authorize(click, { job: job({ target: { kind: "web", url: "https://evil.test/" } }), action: click })).resolves.toMatchObject({ status: "denied", reason: "TargetOriginDenied" });
  });

  it("denies action kind, production exploration, and coordinate fallback", async () => {
    const current = () => Date.parse("2026-08-18T00:00:30.000Z");
    const gate = new DeterministicRunnerPolicyGate(policy, { now: current });
    const desktop = { targetKind: "desktop" as const, actionId: "action-1", graphId: "graph-1", nodeId: "node-1", resolution: "coordinate" as const, kind: "click" as const };
    await expect(gate.authorize(desktop, { job: job(), action: desktop })).resolves.toMatchObject({ status: "denied", reason: "FallbackDenied" });
    const production = { ...policy, environment: "production" as const, explorationAllowed: true };
    const productionGate = new DeterministicRunnerPolicyGate(production, { now: current });
    await expect(productionGate.authorize(click, { job: job({ policy: production }), action: click })).resolves.toMatchObject({ status: "denied", reason: "ProductionExplorationDenied" });
  });

  it("admits only a non-expired HTTP(S) target in its explicit policy origins", () => {
    expect(DeterministicRunnerPolicyGate.admitJob(job(), { now: () => Date.parse("2026-08-18T00:00:30.000Z") })).toMatchObject({ status: "allowed" });
    expect(DeterministicRunnerPolicyGate.admitJob({ ...job(), target: { kind: "web", url: "https://evil.test/" } }, { now: () => Date.parse("2026-08-18T00:00:30.000Z") })).toMatchObject({ status: "denied", code: "PolicyDenied" });
  });
});
