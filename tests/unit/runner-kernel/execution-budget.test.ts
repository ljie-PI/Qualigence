import { describe, expect, it } from "vitest";
import {
  DeterministicExecutionBudget,
  ExecutionBudgetError,
} from "@qualigence/runner-kernel";

class FakeClock {
  private value = 0;

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

describe("DeterministicExecutionBudget", () => {
  it("derives the output ceiling from remaining model tokens and records an overrun", () => {
    const budget = new DeterministicExecutionBudget();
    budget.begin(job({ maximumModelTokens: 10 }));

    expect(budget.maximumOutputTokens("run-1")).toBe(10);
    budget.consumeModelUsage("run-1", { inputTokens: 2, outputTokens: 3 });
    expect(budget.maximumOutputTokens("run-1")).toBe(5);

    expect(() => budget.consumeModelUsage("run-1", { totalTokens: 6 })).toThrowError(
      expect.objectContaining({ code: "ModelBudgetExceeded", consumedModelTokens: 11 }),
    );
  });

  it("requires finite usage instead of treating missing usage as zero", () => {
    const budget = new DeterministicExecutionBudget();
    budget.begin(job());

    expect(() => budget.consumeModelUsage("run-1", undefined)).toThrowError(
      expect.objectContaining({ code: "ModelUsageUnavailable" }),
    );
    expect(() => budget.consumeModelUsage("run-1", { inputTokens: 1 })).toThrowError(
      expect.objectContaining({ code: "ModelUsageUnavailable" }),
    );
  });

  it("enforces the exact step and wall-clock limits deterministically", () => {
    const clock = new FakeClock();
    const budget = new DeterministicExecutionBudget({ clock });
    budget.begin(job({ maximumStepsPerJob: 1, maximumWallClockMs: 100 }));

    budget.beforeStep("run-1", 0);
    expect(() => budget.beforeStep("run-1", 0)).toThrowError(
      expect.objectContaining({ code: "StepBudgetExceeded" }),
    );

    clock.advance(100);
    expect(() => budget.maximumOutputTokens("run-1")).toThrowError(
      expect.objectContaining({ code: "WallClockBudgetExceeded" }),
    );
  });

  it("records usage before classifying a call that crosses token and wall limits", () => {
    const clock = new FakeClock();
    const budget = new DeterministicExecutionBudget({ clock });
    budget.begin(job({ maximumWallClockMs: 100, maximumModelTokens: 5 }));
    clock.advance(100);

    expect(() => budget.consumeModelUsage("run-1", { totalTokens: 6 })).toThrowError(
      expect.objectContaining({ code: "ModelBudgetExceeded", consumedModelTokens: 6 }),
    );
  });

  it("clears run state on finish", () => {
    const budget = new DeterministicExecutionBudget();
    budget.begin(job());
    budget.finish("run-1");

    expect(() => budget.beforeStep("run-1", 0)).toThrowError(
      expect.objectContaining({ code: "ExecutionBudgetNotActive" }) as ExecutionBudgetError,
    );
  });
});

function job(overrides: {
  readonly maximumStepsPerJob?: number;
  readonly maximumWallClockMs?: number;
  readonly maximumModelTokens?: number;
} = {}) {
  return {
    jobId: "job-1",
    runId: "run-1",
    projectId: "project-1",
    target: { kind: "web" as const, url: "https://example.test" },
    objective: "test",
    policy: {
      policyId: "policy-1",
      environment: "isolated_test" as const,
      allowedOrigins: ["https://example.test"],
      allowedActionKinds: ["click"] as const,
      maximumRisk: "Normal" as const,
      explorationAllowed: false,
      issuedAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-20T00:01:00.000Z",
    },
    plan: {
      missionId: "mission-1",
      missionRevision: 1,
      testCaseId: "case-1",
      steps: [{ stepIndex: 0, kind: "click" as const, target: { purpose: "test" } }] as const,
      expectedClaimIds: ["claim-1"] as const,
      budget: {
        maximumStepsPerJob: overrides.maximumStepsPerJob ?? 1,
        maximumWallClockMs: overrides.maximumWallClockMs ?? 1_000,
        maximumModelTokens: overrides.maximumModelTokens ?? 100,
      },
    },
  };
}
