import { describe, expect, it, vi } from "vitest";
import {
  DeterministicRunnerPolicyGate,
  ExecutionRuntime,
  type ActionExecutor,
  type ActionResolver,
  type AgentContext,
  type AnyProposedAction,
  type AnyResolvedAction,
} from "@qualigence/runner-kernel";
import type { AcceptedExecutionJob, ExecutionPolicyRisk } from "@qualigence/runner-protocol";
import { InMemoryTraceRecorder } from "@qualigence/testkit";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";

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
    "enforces ExternalSideEffect policy for Web %s through the public runtime pipeline",
    async (kind) => {
      const now = () => Date.parse("2026-08-18T00:00:30.000Z");
      const currentStep = Object.freeze({
        stepIndex: 0,
        kind,
        target: Object.freeze({ role: kind === "input" ? "textbox" : "combobox", purpose: "customer value" }),
        valueRef: "customer.value",
      });
      const plan = Object.freeze({
        missionId: "mission-1",
        missionRevision: 1,
        testCaseId: `case-${kind}`,
        steps: Object.freeze([currentStep] as const),
        expectedClaimIds: Object.freeze(["claim-1"] as const),
        budget: Object.freeze({ maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 1_000 }),
      });
      const proposedAction = Object.freeze({
        kind,
        target: Object.freeze({ nodeId: "field-1" }),
        valueRef: currentStep.valueRef,
        reason: `execute immutable ${kind} step`,
      }) as AnyProposedAction;
      const resolvedAction = Object.freeze({
        targetKind: "web" as const,
        kind,
        target: Object.freeze({ nodeId: "field-1", selector: "field" }),
        graphId: "graph-1",
        valueRef: currentStep.valueRef,
      }) as AnyResolvedAction;

      const run = async (maximumRisk: ExecutionPolicyRisk) => {
        const scopedPolicy = { ...policy, allowedActionKinds: [kind], maximumRisk };
        const scopedJob = Object.freeze(job({
          jobId: `job-${kind}-${maximumRisk}`,
          runId: `run-${kind}-${maximumRisk}`,
          objective: `${kind} customer value`,
          policy: scopedPolicy,
          plan,
        }));
        const valueProvider = { resolve: vi.fn(async (_valueRef: string) => "resolved-secret") };
        const execute = vi.fn<ActionExecutor["execute"]>(async () => {
          await valueProvider.resolve(currentStep.valueRef);
          return { status: "ok" as const };
        });
        const decide = vi.fn(async (context: AgentContext) => {
          expect(Object.isFrozen(plan)).toBe(true);
          expect(Object.isFrozen(currentStep)).toBe(true);
          expect(context.job.plan).toBe(plan);
          expect(plan.steps[0]).toBe(currentStep);
          return proposedAction as never;
        });
        const resolve = vi.fn(async (action: Parameters<ActionResolver["resolve"]>[0]) => {
          expect(action).toBe(proposedAction);
          return resolvedAction as never;
        });
        const traceRecorder = new InMemoryTraceRecorder();
        const runtime = new ExecutionRuntime({
          observer: { capture: async () => observationGraphV1("graph-1") },
          decisionProvider: { decide },
          resolver: { resolve },
          policyGate: new DeterministicRunnerPolicyGate(scopedPolicy, { now }),
          actionExecutor: { execute },
          verifier: { verify: async () => ({ status: "passed", summary: "passed", claims: [] }) },
          traceRecorder,
        });

        return {
          completion: await runtime.run(scopedJob),
          events: traceRecorder.eventsFor(scopedJob.runId),
          execute,
          valueProvider,
        };
      };

      const denied = await run("Normal");
      expect(denied.completion).toEqual({
        jobId: `job-${kind}-Normal`,
        runId: `run-${kind}-Normal`,
        status: "blocked",
        errorCode: "PolicyDenied",
      });
      expect(denied.valueProvider.resolve).not.toHaveBeenCalled();
      expect(denied.execute).not.toHaveBeenCalled();
      expect(denied.events.map((event) => event.stage)).toEqual([
        "observation",
        "decision",
        "action_resolved",
        "policy_denied",
        "run_completed",
      ]);
      expect(denied.events.at(-2)?.payload).toEqual({ status: "denied", reason: "RiskDenied" });
      expect(denied.events.at(-1)?.payload).toEqual({ status: "blocked", errorCode: "PolicyDenied" });

      const allowed = await run("ExternalSideEffect");
      expect(allowed.completion).toEqual({
        jobId: `job-${kind}-ExternalSideEffect`,
        runId: `run-${kind}-ExternalSideEffect`,
        status: "passed",
      });
      expect(allowed.execute).toHaveBeenCalledOnce();
      expect(allowed.execute.mock.calls[0]?.[0]).toBe(resolvedAction);
      expect(allowed.execute.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
      expect(allowed.valueProvider.resolve).toHaveBeenCalledOnce();
      expect(allowed.valueProvider.resolve).toHaveBeenCalledWith(currentStep.valueRef);
      expect(allowed.events.map((event) => event.stage)).toEqual([
        "observation",
        "decision",
        "action_resolved",
        "policy_authorized",
        "action_executed",
        "observation",
        "verification",
        "run_completed",
      ]);
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
