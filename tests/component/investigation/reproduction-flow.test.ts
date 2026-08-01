import { describe, expect, it } from "vitest";
import {
  InvestigationCoordinator,
  type InvestigationCoordinatorConfig,
  type InvestigationModelAgentPort,
  type ReproductionPlan,
  type ReproductionRunnerPort,
} from "@qualigence/investigation";
import type {
  IntelligenceJob,
  IntelligenceResult,
} from "@qualigence/intelligence";
import type {
  InvestigationBudget,
  InvestigationBudgetUsage,
  ReproductionAttemptDraft,
  ReproductionOutcome,
} from "@qualigence/investigation";

const config: InvestigationCoordinatorConfig = {
  tenantId: "tenant-1",
  modelProfileId: "model-a",
  dataPolicyId: "policy-1",
  jobBudget: { maximumTokens: 100_000, maximumCostMicros: 1_000_000, timeoutMs: 60_000 },
  maxPlanRevisions: 5,
};

const budget: InvestigationBudget = {
  maximumReproductionAttempts: 3,
  maximumPlanningRevisions: 5,
  maximumEnvironmentRetries: 3,
  maximumWallClockMs: 600_000,
  maximumModelTokens: 500_000,
  maximumEnvironmentResets: 5,
  maximumDestructiveActions: 2,
  confirmationConfidenceThreshold: 0.8,
};

const noUsage: InvestigationBudgetUsage = {
  reproductionAttempts: 0,
  planningRevisions: 0,
  environmentRetries: 0,
  wallClockMs: 0,
  modelTokens: 0,
  environmentResets: 0,
  destructiveActions: 0,
};

function planResult(job: IntelligenceJob): IntelligenceResult {
  return {
    jobId: job.jobId,
    resultSchemaVersion: "intelligence-result/v1",
    proposals: [
      {
        steps: [
          { kind: "navigate", path: "/cart" },
          { kind: "click", target: { purpose: "checkout" } },
        ],
        rationale: "Reproduce the checkout total defect.",
      },
    ],
    evidenceRefs: ["evidence-1"],
    confidence: 0.9,
    provenance: ["model-a"],
    usage: { inputTokens: 100, outputTokens: 100, costMicros: 200 },
    terminalStatus: "succeeded",
    idempotencyKey: job.idempotencyKey,
  };
}

function analysisResult(
  job: IntelligenceJob,
  confirmedAttemptId: string,
  confidence: number,
): IntelligenceResult {
  return {
    jobId: job.jobId,
    resultSchemaVersion: "intelligence-result/v1",
    proposals: [
      {
        episodeId: "episode-1",
        confirmedAttemptIds: [confirmedAttemptId],
        expectedClaims: ["cart.total==0"],
        observedFacts: ["cart.total==5"],
        minimalSteps: [{ kind: "navigate", path: "/cart" }],
        environment: { browser: "chromium" },
      },
    ],
    evidenceRefs: ["evidence-1"],
    confidence,
    provenance: ["model-a"],
    usage: { inputTokens: 80, outputTokens: 120, costMicros: 200 },
    terminalStatus: "succeeded",
    idempotencyKey: job.idempotencyKey,
  };
}

function attemptDraft(
  attemptId: string,
  outcome: ReproductionOutcome,
  overrides: Partial<ReproductionAttemptDraft> = {},
): ReproductionAttemptDraft {
  return {
    attemptId,
    environmentRef: "env-1",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:00:05.000Z",
    outcome,
    evidenceRefs: ["evidence-1"],
    budgetConsumed: { ...noUsage, wallClockMs: 5_000, modelTokens: 300 },
    ...overrides,
  };
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

describe("InvestigationCoordinator reproduction flow", () => {
  it("drives a Finding to a Confirmed BugEpisode", async () => {
    const agent: InvestigationModelAgentPort = {
      async proposeReproductionPlan(job) {
        return planResult(job);
      },
      async analyzeBug(job, context) {
        const reproduced = context.reproducedAttempts[0];
        return analysisResult(job, reproduced?.attemptId ?? "unknown", 0.95);
      },
    };
    const runner: ReproductionRunnerPort = {
      async reproduce(_plan: ReproductionPlan) {
        return attemptDraft("attempt-hit", "reproduced");
      },
    };
    const coordinator = new InvestigationCoordinator(agent, runner, config, newId);

    const outcome = await coordinator.investigate({
      caseId: "case-1",
      findingId: "finding-1",
      projectId: "proj-1",
      budget,
      inputRefs: ["evidence-1"],
    });

    expect(outcome.status).toBe("confirmed");
    expect(outcome.bugEpisode).toMatchObject({
      caseId: "case-1",
      findingId: "finding-1",
      confidence: 0.95,
      confirmedAttemptIds: ["attempt-hit"],
    });
    expect(outcome.attempts).toHaveLength(1);
  });

  it("revises the plan across a divergence and still confirms within budget", async () => {
    const outcomes: ReproductionOutcome[] = ["diverged", "reproduced"];
    let call = 0;
    const runner: ReproductionRunnerPort = {
      async reproduce() {
        const outcome = outcomes[call] ?? "not_reproduced";
        call += 1;
        return attemptDraft(`attempt-${call}`, outcome, {
          ...(outcome === "diverged" ? { divergenceStepId: "step-2" } : {}),
        });
      },
    };
    const agent: InvestigationModelAgentPort = {
      async proposeReproductionPlan(job) {
        return planResult(job);
      },
      async analyzeBug(job, context) {
        const reproduced = context.reproducedAttempts.at(-1);
        return analysisResult(job, reproduced?.attemptId ?? "unknown", 0.9);
      },
    };
    const coordinator = new InvestigationCoordinator(agent, runner, config, newId);

    const outcome = await coordinator.investigate({
      caseId: "case-2",
      findingId: "finding-2",
      projectId: "proj-1",
      budget,
      inputRefs: ["evidence-1"],
    });

    expect(outcome.status).toBe("confirmed");
    // Two attempts: the diverged one, then the reproducing one.
    expect(outcome.attempts.map((a) => a.outcome)).toEqual([
      "diverged",
      "reproduced",
    ]);
    expect(outcome.attempts.map((a) => a.ordinal)).toEqual([1, 2]);
  });

  it("escalates to Needs Human when the reproduction budget exhausts", async () => {
    const smallBudget: InvestigationBudget = {
      ...budget,
      maximumReproductionAttempts: 2,
    };
    const runner: ReproductionRunnerPort = {
      async reproduce() {
        return attemptDraft(`attempt-${newId()}`, "not_reproduced");
      },
    };
    const agent: InvestigationModelAgentPort = {
      async proposeReproductionPlan(job) {
        return planResult(job);
      },
      async analyzeBug(job) {
        return analysisResult(job, "none", 0.9);
      },
    };
    const coordinator = new InvestigationCoordinator(agent, runner, config, newId);

    const outcome = await coordinator.investigate({
      caseId: "case-3",
      findingId: "finding-3",
      projectId: "proj-1",
      budget: smallBudget,
      inputRefs: ["evidence-1"],
    });

    expect(outcome.status).toBe("needs_human");
    expect(outcome.handoff).toMatchObject({ caseId: "case-3" });
    expect(outcome.handoff?.limitationCodes).toContain(
      "budget_exhausted:reproductionAttempts",
    );
  });

  it("escalates to Needs Human when analysis confidence is below threshold", async () => {
    const runner: ReproductionRunnerPort = {
      async reproduce() {
        return attemptDraft("attempt-low", "reproduced");
      },
    };
    const agent: InvestigationModelAgentPort = {
      async proposeReproductionPlan(job) {
        return planResult(job);
      },
      async analyzeBug(job, context) {
        const reproduced = context.reproducedAttempts[0];
        // Below the 0.8 confirmation threshold.
        return analysisResult(job, reproduced?.attemptId ?? "unknown", 0.4);
      },
    };
    const coordinator = new InvestigationCoordinator(agent, runner, config, newId);

    const outcome = await coordinator.investigate({
      caseId: "case-4",
      findingId: "finding-4",
      projectId: "proj-1",
      budget,
      inputRefs: ["evidence-1"],
    });

    expect(outcome.status).toBe("needs_human");
    expect(outcome.handoff?.limitationCodes).toContain("confirmation_rejected");
  });
});
