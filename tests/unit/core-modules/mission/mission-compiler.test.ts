import { describe, expect, it } from "vitest";
import {
  approveTestPlan,
  capabilityForStep,
  canonicalJson,
  createDraftTestPlan,
  MissionCompiler,
} from "@qualigence/mission";
import type {
  TargetCapabilitySummary,
  TestMission,
  TestPlanRevision,
} from "@qualigence/mission";
import type { Clock } from "@qualigence/shared-kernel";
import { sha256Hex } from "@qualigence/context-intake";
import {
  WEB_OBSERVATION_V1_CAPABILITY_TOKENS,
  capabilities,
  negotiateCapabilities,
} from "@qualigence/runner-protocol";
import { sequentialIds, validatedProposal } from "./fixtures.js";

const fixedClock: Clock = { now: () => "2026-08-01T00:00:00.000Z" };

const webTarget: TargetCapabilitySummary = {
  targetId: "target-web",
  targetVersion: 1,
  targetSnapshotHash: "target-hash",
  supportedStepKinds: ["navigate", "click", "verify"],
  capabilities: ["target:web-playwright"],
};

function mission(overrides: Partial<TestMission> = {}): TestMission {
  return {
    missionId: "mission-1",
    projectId: "p",
    revision: 1,
    targetId: "target-web",
    testCaseIds: ["tc-1"],
    executionBudget: {
      maximumJobs: 10,
      maximumStepsPerJob: 20,
      maximumWallClockMs: 60000,
      maximumModelTokens: 100000,
      stopOnBlockedTestCase: true,
    },
    executionPolicy: {
      policyId: "policy-mission",
      environment: "staging",
      allowedOrigins: ["https://example.test"],
      allowedActionKinds: ["click"],
      maximumRisk: "Normal",
      explorationAllowed: false,
      issuedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:01:00.000Z",
    },
    status: "approved",
    ...overrides,
  };
}

function draft(options: { withInput?: boolean; projectId?: string } = {}): TestPlanRevision {
  const result = createDraftTestPlan(
    {
      projectId: options.projectId ?? "p",
      prdId: "prd-1",
      prdRevision: 1,
      proposal: validatedProposal(options),
    },
    sequentialIds(),
  );
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function approved(options: { withInput?: boolean; projectId?: string } = {}): TestPlanRevision {
  const result = approveTestPlan(
    draft(options),
    { expectedVersion: 1, reviewerId: "r", idempotencyKey: "k" },
    fixedClock,
  );
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const compiler = new MissionCompiler();

describe("MissionCompiler", () => {
  it("refuses to compile a plan that is not approved (PlanNotApproved)", () => {
    const result = compiler.compile(draft(), mission(), webTarget);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PlanNotApproved" },
    });
  });

  it("refuses a Mission whose project provenance differs from the approved Plan", () => {
    const result = compiler.compile(approved(), mission({ projectId: "other-project" }), webTarget);
    expect(result).toMatchObject({ ok: false, error: { code: "MissionProjectMismatch" } });
  });

  it("compiles an approved plan into frozen, source-grounded jobs", () => {
    const plan = approved();
    const result = compiler.compile(plan, mission(), webTarget);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const job = result.value.jobs[0];
    expect(job).toBeDefined();
    if (job === undefined) return;
    expect(job.testCaseId).toBe(plan.testCases[0]?.id);
    expect(job.testCaseSnapshot.sourceRefs[0]?.revision).toBe(plan.prdRevision);
    expect(job.status).toBe("queued");
    expect(job.requiredCapabilities).toEqual([
      "action:click",
      "action:navigate",
      "model:structured-output",
      ...WEB_OBSERVATION_V1_CAPABILITY_TOKENS,
      "target:web-playwright",
    ]);
    expect(negotiateCapabilities(capabilities({
      targetAdapters: ["web-playwright"],
      observationExtensions: ["observation-graph/v1", "web/v1"],
      actionKinds: ["click"],
    }), job.requiredCapabilities)).toEqual({
      outcome: "rejected",
      rejection: { code: "CapabilityMismatch", missingCapabilities: ["action:navigate"] },
    });
    expect(negotiateCapabilities(capabilities({
      targetAdapters: ["web-playwright"],
      observationExtensions: ["observation-graph/v1", "web/v1"],
      actionKinds: ["navigate", "click", "input", "select", "scroll"],
    }), job.requiredCapabilities)).toEqual({ outcome: "accepted" });
    expect(result.value.projectId).toBe("p");
    expect(Object.isFrozen(job.testCaseSnapshot)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each([
    ["navigate", "action:navigate"],
    ["click", "action:click"],
    ["input", "action:input"],
    ["select", "action:select"],
    ["scroll", "action:scroll"],
    ["verify", "model:structured-output"],
  ] as const)("maps %s to the capability consumed by Runner negotiation", async (kind, capability) => {
    expect(capabilityForStep(kind)).toBe(capability);
  });

  it("produces a byte-identical snapshot for identical inputs", () => {
    const plan = approved();
    const a = compiler.compile(plan, mission(), webTarget);
    const b = compiler.compile(plan, mission(), webTarget);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.compiledHash).toBe(b.value.compiledHash);
    expect(canonicalJson(a.value)).toBe(canonicalJson(b.value));
    expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
  });

  it("changes the canonical compiled hash when immutable project provenance changes", () => {
    const first = compiler.compile(approved({ projectId: "project-a" }), mission({ projectId: "project-a" }), webTarget);
    const second = compiler.compile(approved({ projectId: "project-b" }), mission({ projectId: "project-b" }), webTarget);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.compiledHash).not.toBe(second.value.compiledHash);
  });

  it("includes the approved immutable policy timestamps in the compiled snapshot", () => {
    const plan = approved();
    const result = compiler.compile(plan, mission(), webTarget);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executionPolicy.issuedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("keeps the compiled snapshot immutable if the plan later changes", () => {
    const plan = approved();
    const result = compiler.compile(plan, mission(), webTarget);
    if (!result.ok) throw new Error(result.error.code);
    const job = result.value.jobs[0];
    if (job === undefined) throw new Error("expected a job");

    expect(() => {
      (job.testCaseSnapshot as { title: string }).title = "mutated";
    }).toThrow();
    expect(job.testCaseSnapshot.title).toBe(plan.testCases[0]?.title);
  });

  it("rejects an unsupported action before dispatch (TargetCapabilityMismatch)", () => {
    const result = compiler.compile(
      approved({ withInput: true }),
      mission(),
      webTarget,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TargetCapabilityMismatch" },
    });
  });

  it("rejects a target that has no Runner protocol target token", () => {
    const result = compiler.compile(approved(), mission(), {
      ...webTarget,
      capabilities: ["web.click"],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TargetCapabilityMismatch" },
    });
  });

  it("rejects a plan that exceeds the mission job budget", () => {
    const result = compiler.compile(
      approved(),
      mission({
        executionBudget: {
          maximumJobs: 0,
          maximumStepsPerJob: 20,
          maximumWallClockMs: 60000,
          maximumModelTokens: 100000,
          stopOnBlockedTestCase: true,
        },
      }),
      webTarget,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "MissionBudgetExceeded" },
    });
  });

  it("rejects malformed Mission policy before any execution can be compiled", () => {
    const result = compiler.compile(
      approved(),
      mission({ executionPolicy: { ...mission().executionPolicy, allowedOrigins: ["https://example.test", "https://example.test"], allowedActionKinds: ["teleport"] as never } }),
      webTarget,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "MissionBudgetExceeded" } });
  });
});
