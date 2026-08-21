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
    projectId: "project-test",
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

  it("denies action-kind mismatch, risk above ceiling, and ProductionForbidden before a permit exists", async () => {
    const now = () => Date.parse("2026-08-18T00:00:30.000Z");
    const actionKindGate = new DeterministicRunnerPolicyGate({ ...policy, allowedActionKinds: ["navigate"] }, { now });
    await expect(actionKindGate.authorize(click, { job: job(), action: click })).resolves.toMatchObject({ status: "denied", reason: "ActionKindDenied" });
    const destructive = { targetKind: "desktop" as const, actionId: "close", graphId: "graph-1", nodeId: "node-1", resolution: "semantic" as const, kind: "window" as const, windowOperation: "close" as const };
    const normalGate = new DeterministicRunnerPolicyGate(policy, { now });
    await expect(normalGate.authorize(destructive, { job: job(), action: destructive })).resolves.toMatchObject({ status: "denied", reason: "ActionKindDenied" });
    const riskGate = new DeterministicRunnerPolicyGate({ ...policy, allowedActionKinds: ["window"], maximumRisk: "ProductionForbidden" }, { now });
    await expect(riskGate.authorize(destructive, { job: job(), action: destructive })).resolves.toMatchObject({ status: "denied", reason: "RiskDenied" });
  });

  it.each(["input", "select"] as const)(
    "classifies Web %s as ExternalSideEffect before value-provider or executor effects",
    async (kind) => {
      const now = () => Date.parse("2026-08-18T00:00:30.000Z");
      const actionBase = {
        targetKind: "web" as const,
        target: { nodeId: "field-1", selector: "field" },
        graphId: "graph-1",
        valueRef: "customer.value",
      };
      const action = kind === "input"
        ? { ...actionBase, kind: "input" as const }
        : { ...actionBase, kind: "select" as const };
      let valueProviderCalls = 0;
      let executorCalls = 0;
      const attemptEffects = async (maximumRisk: "Normal" | "ExternalSideEffect") => {
        const scopedPolicy = { ...policy, allowedActionKinds: [kind], maximumRisk };
        const gate = new DeterministicRunnerPolicyGate(scopedPolicy, { now });
        const decision = await gate.authorize(action as never, { job: job({ policy: scopedPolicy }), action: action as never });
        if (decision.status === "allowed") {
          valueProviderCalls += 1;
          executorCalls += 1;
        }
        return decision;
      };

      await expect(attemptEffects("Normal")).resolves.toMatchObject({ status: "denied", reason: "RiskDenied" });
      expect(valueProviderCalls).toBe(0);
      expect(executorCalls).toBe(0);

      await expect(attemptEffects("ExternalSideEffect")).resolves.toMatchObject({ status: "allowed" });
      expect(valueProviderCalls).toBe(1);
      expect(executorCalls).toBe(1);
    },
  );

  it("admits only a non-expired HTTP(S) target in its explicit policy origins", () => {
    expect(DeterministicRunnerPolicyGate.admitJob(job(), { now: () => Date.parse("2026-08-18T00:00:30.000Z") })).toMatchObject({ status: "allowed" });
    expect(DeterministicRunnerPolicyGate.admitJob({ ...job(), target: { kind: "web", url: "https://evil.test/" } }, { now: () => Date.parse("2026-08-18T00:00:30.000Z") })).toMatchObject({ status: "denied", code: "PolicyDenied" });
    const { projectId: _projectId, ...projectless } = job();
    expect(DeterministicRunnerPolicyGate.admitJob(projectless, { now: () => Date.parse("2026-08-18T00:00:30.000Z") })).toMatchObject({ status: "denied", code: "PolicyMissing" });
  });

  it.each([
    ["unsupported action", [{ stepIndex: 0, kind: "script", source: "alert(1)" }]],
    ["non-contiguous indices", [
      { stepIndex: 0, kind: "navigate", path: "/checkout" },
      { stepIndex: 2, kind: "verify", claimIds: ["claim-1"] },
    ]],
    ["unbounded scroll", [{ stepIndex: 0, kind: "scroll", direction: "down", amount: "pixels" }]],
  ])("rejects a malformed plan with %s before runtime admission", (_name, steps) => {
    expect(DeterministicRunnerPolicyGate.admitJob(job({
      plan: {
        missionId: "mission-1",
        missionRevision: 1,
        testCaseId: "case-1",
        steps,
        expectedClaimIds: ["claim-1"],
        budget: { maximumStepsPerJob: 5, maximumWallClockMs: 30_000, maximumModelTokens: 1_000 },
      } as never,
    }), { now: () => Date.parse("2026-08-18T00:00:30.000Z") })).toMatchObject({
      status: "denied",
      code: "PolicyMissing",
    });
  });

  it("rejects an indexed plan whose immutable action kind is unsupported by policy", () => {
    expect(DeterministicRunnerPolicyGate.admitJob(job({
      plan: {
        missionId: "mission-1",
        missionRevision: 1,
        testCaseId: "case-1",
        steps: [
          { stepIndex: 0, kind: "select", target: { purpose: "choose country" }, valueRef: "customer.country" },
          { stepIndex: 1, kind: "verify", claimIds: ["claim-1"] },
        ],
        expectedClaimIds: ["claim-1"],
        budget: { maximumStepsPerJob: 2, maximumWallClockMs: 30_000, maximumModelTokens: 1_000 },
      },
    }), { now: () => Date.parse("2026-08-18T00:00:30.000Z") })).toMatchObject({
      status: "denied",
      code: "PolicyDenied",
      message: "PlanActionDenied",
    });
  });

  it("admits the preserved unindexed plan without applying indexed action compatibility", () => {
    expect(DeterministicRunnerPolicyGate.admitJob(job({
      plan: {
        missionId: "mission-1",
        missionRevision: 1,
        testCaseId: "case-1",
        steps: [
          { kind: "navigate", path: "/checkout" },
          { kind: "verify", claimIds: ["claim-1"] },
        ],
        expectedClaimIds: ["claim-1"],
        budget: { maximumStepsPerJob: 2, maximumWallClockMs: 30_000, maximumModelTokens: 1_000 },
      },
    }), { now: () => Date.parse("2026-08-18T00:00:30.000Z") })).toMatchObject({ status: "allowed" });
  });

  it("allows the exact bounded staging click and denies staging exploration and fallbacks", async () => {
    const staging = { ...policy, environment: "staging" as const };
    const now = () => Date.parse("2026-08-18T00:00:30.000Z");
    const gate = new DeterministicRunnerPolicyGate(staging, { now });
    await expect(gate.authorize(click, { job: job({ policy: staging }), action: click })).resolves.toMatchObject({ status: "allowed" });
    const coordinate = { targetKind: "desktop" as const, actionId: "action-coordinate", graphId: "graph-1", nodeId: "node-1", resolution: "coordinate" as const, kind: "click" as const };
    const visual = { ...coordinate, actionId: "action-visual", resolution: "visual" as const };
    await expect(gate.authorize(coordinate, { job: job({ policy: staging }), action: coordinate })).resolves.toMatchObject({ status: "denied", reason: "FallbackDenied" });
    await expect(gate.authorize(visual, { job: job({ policy: staging }), action: visual })).resolves.toMatchObject({ status: "denied", reason: "FallbackDenied" });
    expect(DeterministicRunnerPolicyGate.admitJob(job({ policy: { ...staging, explorationAllowed: true } }), { now })).toMatchObject({ status: "denied", code: "PolicyMissing" });
  });

  it("fails closed when a malformed in-memory policy has an invalid expiry", async () => {
    const malformed = { ...policy, expiresAt: "not-an-instant" } as never;
    const gate = new DeterministicRunnerPolicyGate(malformed, { now: () => 0 });
    await expect(gate.authorize(click, { job: job({ policy: malformed }), action: click })).resolves.toMatchObject({ status: "denied" });
    expect(DeterministicRunnerPolicyGate.admitJob(job({ policy: malformed }), { now: () => 0 })).toMatchObject({ status: "denied", code: "PolicyMissing" });
  });
});
