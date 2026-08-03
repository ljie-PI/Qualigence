import { describe, expect, it } from "vitest";
import {
  InvestigationBudgetLedger,
  InvestigationCase,
  outcomeConsumesReproductionAttempt,
  type InvestigationBudget,
  type InvestigationBudgetUsage,
  type ReproductionAttempt,
  type ReproductionAttemptDraft,
} from "@qualigence/investigation";

const budget: InvestigationBudget = {
  maximumReproductionAttempts: 2,
  maximumPlanningRevisions: 5,
  maximumEnvironmentRetries: 2,
  maximumWallClockMs: 100_000,
  maximumModelTokens: 10_000,
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

function attempt(
  overrides: Partial<ReproductionAttempt> = {},
): ReproductionAttempt {
  return {
    attemptId: "a",
    caseId: "case-1",
    ordinal: 1,
    planRevision: 1,
    environmentRef: "env-1",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:00:01.000Z",
    outcome: "not_reproduced",
    evidenceRefs: [],
    budgetConsumed: noUsage,
    ...overrides,
  };
}

function draft(
  overrides: Partial<ReproductionAttemptDraft> = {},
): ReproductionAttemptDraft {
  return {
    attemptId: `attempt-${Math.random().toString(36).slice(2)}`,
    environmentRef: "env-1",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:00:01.000Z",
    outcome: "not_reproduced",
    evidenceRefs: [],
    budgetConsumed: noUsage,
    ...overrides,
  };
}

describe("InvestigationBudgetLedger", () => {
  it("counts an environment failure against only the environment retry budget", () => {
    const ledger = InvestigationBudgetLedger.open(budget);
    const result = ledger.consumeAttempt(
      attempt({ outcome: "environment_failed" }),
    );
    expect(result.usage).toMatchObject({
      environmentRetries: 1,
      reproductionAttempts: 0,
    });
    expect(result.exhausted).toBe(false);
  });

  it("counts a reproduction outcome against the reproduction attempt budget", () => {
    const ledger = InvestigationBudgetLedger.open(budget);
    const result = ledger.consumeAttempt(attempt({ outcome: "not_reproduced" }));
    expect(result.usage).toMatchObject({
      reproductionAttempts: 1,
      environmentRetries: 0,
    });
  });

  it("accumulates the resource dimensions an attempt reports", () => {
    const ledger = InvestigationBudgetLedger.open(budget);
    ledger.consumeAttempt(
      attempt({
        budgetConsumed: {
          ...noUsage,
          wallClockMs: 4_000,
          modelTokens: 250,
          environmentResets: 1,
          destructiveActions: 0,
        },
      }),
    );
    expect(ledger.usage()).toMatchObject({
      wallClockMs: 4_000,
      modelTokens: 250,
      environmentResets: 1,
    });
  });

  it("reports clean exhaustion when reproduction attempts reach the ceiling", () => {
    const ledger = InvestigationBudgetLedger.open(budget);
    const first = ledger.consumeAttempt(attempt());
    expect(first.exhausted).toBe(false);
    const second = ledger.consumeAttempt(attempt());
    expect(second.exhausted).toBe(true);
    expect(second.exhaustedDimensions).toContain("reproductionAttempts");
  });

  it("rejects a negative resource dimension", () => {
    const ledger = InvestigationBudgetLedger.open(budget);
    expect(() =>
      ledger.consumeAttempt(
        attempt({ budgetConsumed: { ...noUsage, modelTokens: -1 } }),
      ),
    ).toThrowError();
  });

  it("classifies which outcomes consume a reproduction attempt", () => {
    expect(outcomeConsumesReproductionAttempt("reproduced")).toBe(true);
    expect(outcomeConsumesReproductionAttempt("not_reproduced")).toBe(true);
    expect(outcomeConsumesReproductionAttempt("diverged")).toBe(true);
    expect(outcomeConsumesReproductionAttempt("blocked")).toBe(true);
    expect(outcomeConsumesReproductionAttempt("environment_failed")).toBe(false);
  });
});

describe("InvestigationCase budget exhaustion", () => {
  function reproducing(): InvestigationCase {
    const investigation = InvestigationCase.open({
      caseId: "case-1",
      findingId: "finding-1",
      projectId: "proj-1",
      budget,
    });
    investigation.startInvestigation({ expectedVersion: 1, idempotencyKey: "a" });
    investigation.startReproduction({ expectedVersion: 2, idempotencyKey: "b" });
    return investigation;
  }

  it("transitions to Needs Human when the reproduction budget cleanly exhausts", () => {
    const investigation = reproducing();
    const first = investigation.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "c",
      attempt: draft({ outcome: "not_reproduced" }),
    });
    expect(first.toStatus).toBe("reproducing");

    const second = investigation.appendAttempt({
      expectedVersion: 4,
      idempotencyKey: "d",
      attempt: draft({ outcome: "not_reproduced" }),
    });
    expect(second.toStatus).toBe("needs_human");
    expect(second.exhaustedDimensions).toContain("reproductionAttempts");
    expect(second.handoff).toMatchObject({ caseId: "case-1" });
    expect(second.handoff?.limitationCodes).toContain(
      "budget_exhausted:reproductionAttempts",
    );
  });

  it("does not force Needs Human when the exhausting attempt reproduced", () => {
    const investigation = reproducing();
    investigation.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "c",
      attempt: draft({ outcome: "not_reproduced" }),
    });
    const second = investigation.appendAttempt({
      expectedVersion: 4,
      idempotencyKey: "d",
      attempt: draft({ attemptId: "hit", outcome: "reproduced" }),
    });
    // Budget is exhausted but the reproduction is a confirmation opportunity.
    expect(second.toStatus).toBe("reproducing");
    expect(investigation.usage().reproductionAttempts).toBe(2);
  });

  it("does not append attempts after the case has left Reproducing", () => {
    const investigation = reproducing();
    investigation.appendAttempt({
      expectedVersion: 3,
      idempotencyKey: "c",
      attempt: draft({ outcome: "not_reproduced" }),
    });
    investigation.appendAttempt({
      expectedVersion: 4,
      idempotencyKey: "d",
      attempt: draft({ outcome: "not_reproduced" }),
    });
    // The case is now needs_human; further attempts are illegal.
    expect(() =>
      investigation.appendAttempt({
        expectedVersion: 5,
        idempotencyKey: "e",
        attempt: draft({ outcome: "not_reproduced" }),
      }),
    ).toThrowError(/IllegalTransition/);
  });
});
