import { describe, expect, it } from "vitest";
import {
  InvestigationCase,
  InvestigationError,
  type BudgetDimension,
  type InvestigationBudget,
  type InvestigationBudgetUsage,
  type ReproductionAttemptDraft,
} from "@qualigence/investigation";
import type { IntentStep } from "@qualigence/mission";

const budget: InvestigationBudget = {
  maximumReproductionAttempts: 3,
  maximumPlanningRevisions: 3,
  maximumEnvironmentRetries: 2,
  maximumWallClockMs: 600_000,
  maximumModelTokens: 100_000,
  maximumEnvironmentResets: 3,
  maximumDestructiveActions: 1,
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

function draft(
  overrides: Partial<ReproductionAttemptDraft> = {},
): ReproductionAttemptDraft {
  return {
    attemptId: `attempt-${Math.random().toString(36).slice(2)}`,
    environmentRef: "env-1",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:00:10.000Z",
    outcome: "not_reproduced",
    evidenceRefs: ["evidence-1"],
    budgetConsumed: { ...noUsage, wallClockMs: 10_000, modelTokens: 500 },
    ...overrides,
  };
}

function openCase(): InvestigationCase {
  return InvestigationCase.open({
    caseId: "case-1",
    findingId: "finding-1",
    projectId: "proj-1",
    budget,
  });
}

const minimalSteps: readonly IntentStep[] = [
  { kind: "navigate", path: "/cart" },
  { kind: "click", target: { purpose: "checkout" } },
];

describe("InvestigationCase lifecycle", () => {
  it("advances Candidate → Investigating → Reproducing", () => {
    const investigation = openCase();
    expect(investigation.status()).toBe("candidate");

    const t1 = investigation.startInvestigation({
      expectedVersion: 1,
      idempotencyKey: "k-start",
    });
    expect(t1).toMatchObject({ toStatus: "investigating", version: 2 });

    const t2 = investigation.startReproduction({
      expectedVersion: 2,
      idempotencyKey: "k-repro",
    });
    expect(t2).toMatchObject({ toStatus: "reproducing", version: 3 });
    expect(investigation.planRevision()).toBe(1);
  });

  it("rejects an illegal reverse transition", () => {
    const investigation = openCase();
    expect(() =>
      investigation.confirm({
        expectedVersion: 1,
        idempotencyKey: "k",
        episode: {
          episodeId: "ep-1",
          confirmedAttemptIds: ["attempt-x"],
          expectedClaims: [],
          observedFacts: [],
          minimalSteps,
          environment: {},
          evidenceRefs: [],
          confidence: 0.9,
        },
      }),
    ).toThrowError(InvestigationError);
    try {
      investigation.verifyRegression({ expectedVersion: 1, idempotencyKey: "k2" });
      throw new Error("expected an illegal transition");
    } catch (error) {
      expect(error).toBeInstanceOf(InvestigationError);
      expect((error as InvestigationError).code).toBe(
        "InvestigationIllegalTransition",
      );
    }
  });

  it("rejects a stale write under optimistic concurrency", () => {
    const investigation = openCase();
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "a" });

    try {
      investigation.startReproduction({ expectedVersion: 1, idempotencyKey: "b" });
      throw new Error("expected a version conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(InvestigationError);
      expect((error as InvestigationError).code).toBe(
        "InvestigationVersionConflict",
      );
    }
  });

  it("replays an idempotent command without advancing the version", () => {
    const investigation = openCase();
    const first = investigation.startInvestigation({
      expectedVersion: 1,
      idempotencyKey: "same",
    });
    const replay = investigation.startInvestigation({
      expectedVersion: 1,
      idempotencyKey: "same",
    });
    expect(replay).toEqual(first);
    expect(investigation.currentVersion()).toBe(2);
  });

  it("builds a BugEpisode only after confirmation threshold and a reproduced attempt", () => {
    const investigation = openCase();
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "a" });
    investigation.startReproduction({ expectedVersion: 2, idempotencyKey: "b" });
    const appended = investigation.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "c",
      attempt: draft({ attemptId: "attempt-hit", outcome: "reproduced" }),
    });
    expect(appended.toStatus).toBe("reproducing");

    // Below-threshold confidence is rejected deterministically.
    expect(() =>
      investigation.confirm({
        expectedVersion: 4,
        idempotencyKey: "low",
        episode: {
          episodeId: "ep-low",
          confirmedAttemptIds: ["attempt-hit"],
          expectedClaims: ["cart.total==0"],
          observedFacts: ["cart.total==5"],
          minimalSteps,
          environment: { browser: "chromium" },
          evidenceRefs: ["evidence-1"],
          confidence: 0.5,
        },
      }),
    ).toThrowError(/ConfirmationRejected/);

    const confirmed = investigation.confirm({
      expectedVersion: 4,
      idempotencyKey: "ok",
      episode: {
        episodeId: "ep-1",
        confirmedAttemptIds: ["attempt-hit"],
        expectedClaims: ["cart.total==0"],
        observedFacts: ["cart.total==5"],
        minimalSteps,
        environment: { browser: "chromium" },
        evidenceRefs: ["evidence-1"],
        confidence: 0.95,
      },
    });
    expect(confirmed.toStatus).toBe("confirmed");
    expect(confirmed.bugEpisode).toMatchObject({
      caseId: "case-1",
      findingId: "finding-1",
      confidence: 0.95,
    });
    expect(investigation.bugEpisode()?.minimalSteps).toEqual(minimalSteps);
  });

  it("rejects confirmation when no referenced attempt reproduced", () => {
    const investigation = openCase();
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "a" });
    investigation.startReproduction({ expectedVersion: 2, idempotencyKey: "b" });
    investigation.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "c",
      attempt: draft({ attemptId: "attempt-miss", outcome: "not_reproduced" }),
    });
    expect(() =>
      investigation.confirm({
        expectedVersion: 4,
        idempotencyKey: "d",
        episode: {
          episodeId: "ep-x",
          confirmedAttemptIds: ["attempt-miss"],
          expectedClaims: [],
          observedFacts: [],
          minimalSteps,
          environment: {},
          evidenceRefs: [],
          confidence: 0.99,
        },
      }),
    ).toThrowError(/ConfirmationRejected/);
  });

  it("appends attempts append-only with monotonic ordinals", () => {
    const investigation = openCase();
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "a" });
    investigation.startReproduction({ expectedVersion: 2, idempotencyKey: "b" });
    investigation.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "c",
      attempt: draft({ attemptId: "one" }),
    });
    investigation.appendAttempt({
      expectedVersion: 4,
      idempotencyKey: "d",
      attempt: draft({ attemptId: "two" }),
    });
    const attempts = investigation.reproductionAttempts();
    expect(attempts.map((a) => a.ordinal)).toEqual([1, 2]);
    expect(attempts.map((a) => a.attemptId)).toEqual(["one", "two"]);
    expect(attempts.every((a) => a.caseId === "case-1")).toBe(true);
  });

  it("escalates an ambiguous case to Needs Human with a handoff", () => {
    const investigation = openCase();
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "a" });
    const escalated = investigation.escalateToHuman({
      expectedVersion: 2,
      idempotencyKey: "esc",
      handoff: {
        bestHypothesis: "Ambiguous selector",
        keyEvidenceRefs: ["evidence-9"],
        suggestedActions: ["inspect manually"],
        limitationCodes: ["ambiguous_case"],
      },
    });
    expect(escalated.toStatus).toBe("needs_human");
    expect(escalated.handoff).toMatchObject({
      caseId: "case-1",
      limitationCodes: ["ambiguous_case"],
    });
  });

  it("resolves and then verifies regression from a confirmed case", () => {
    const investigation = openCase();
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "a" });
    investigation.startReproduction({ expectedVersion: 2, idempotencyKey: "b" });
    investigation.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "c",
      attempt: draft({ attemptId: "attempt-hit", outcome: "reproduced" }),
    });
    investigation.confirm({
      expectedVersion: 4,
      idempotencyKey: "d",
      episode: {
        episodeId: "ep-1",
        confirmedAttemptIds: ["attempt-hit"],
        expectedClaims: [],
        observedFacts: [],
        minimalSteps,
        environment: {},
        evidenceRefs: [],
        confidence: 0.9,
      },
    });
    const resolved = investigation.resolve({
      expectedVersion: 5,
      idempotencyKey: "e",
      disposition: "fixed",
    });
    expect(resolved.toStatus).toBe("resolved");
    const verified = investigation.verifyRegression({
      expectedVersion: 6,
      idempotencyKey: "f",
    });
    expect(verified.toStatus).toBe("regression_verified");
  });

  it("rehydrates from a persisted snapshot preserving version and attempts", () => {
    const source = openCase();
    source.startInvestigation({ expectedVersion: 1, idempotencyKey: "a" });
    source.startReproduction({ expectedVersion: 2, idempotencyKey: "b" });
    source.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "c",
      attempt: draft({ attemptId: "attempt-1" }),
    });

    const restored = InvestigationCase.restore({
      caseId: source.caseId,
      findingId: source.findingId,
      projectId: source.projectId,
      budget,
      usage: source.usage(),
      version: source.currentVersion(),
      status: source.status(),
      planRevision: source.planRevision(),
      attempts: source.reproductionAttempts(),
    });
    expect(restored.currentVersion()).toBe(source.currentVersion());
    expect(restored.reproductionAttempts()).toHaveLength(1);

    // A resumed writer continues from the restored version.
    const next = restored.appendAttempt({
      expectedVersion: restored.currentVersion(),
      idempotencyKey: "resumed",
      attempt: draft({ attemptId: "attempt-2" }),
    });
    expect(next.appendedAttempt?.ordinal).toBe(2);
  });
});

const allDimensions: readonly BudgetDimension[] = [
  "reproductionAttempts",
  "planningRevisions",
  "environmentRetries",
  "wallClockMs",
  "modelTokens",
  "environmentResets",
  "destructiveActions",
];

it("exposes every budget dimension name", () => {
  expect(new Set(allDimensions).size).toBe(7);
});
