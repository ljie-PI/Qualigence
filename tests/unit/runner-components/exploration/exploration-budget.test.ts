import { describe, expect, it } from "vitest";
import { ExplorationBudget } from "@qualigence/exploration";
import type { ExplorationPolicy } from "@qualigence/mission";

function policy(overrides: Partial<ExplorationPolicy> = {}): ExplorationPolicy {
  return {
    seedSkillBundleIds: [],
    allowedActionKinds: ["navigate", "click", "input"],
    allowedOrigins: ["https://shop.example"],
    maximumSteps: 8,
    maximumWallClockMs: 60_000,
    maximumModelTokens: 10_000,
    maximumStateVisits: 8,
    maximumRecoveries: 2,
    riskCeiling: "RecoverableMutation",
    ...overrides,
  };
}

/** A controllable monotonic clock returning milliseconds. */
class FakeClock {
  private value = 0;

  now(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

describe("ExplorationBudget", () => {
  it("reserves steps up to the exact limit then reports budget_exhausted", () => {
    const budget = ExplorationBudget.from(policy({ maximumSteps: 2 }), new FakeClock());
    expect(budget.reserveStep().ok).toBe(true);
    expect(budget.reserveStep().ok).toBe(true);
    expect(budget.reserveStep()).toMatchObject({ ok: false, reason: "budget_exhausted" });
  });

  it("reserves distinct state visits up to the exact limit", () => {
    const budget = ExplorationBudget.from(policy({ maximumStateVisits: 1 }), new FakeClock());
    expect(budget.reserveStateVisit().ok).toBe(true);
    expect(budget.reserveStateVisit()).toMatchObject({
      ok: false,
      reason: "budget_exhausted",
    });
  });

  it("reserves recoveries up to the exact limit", () => {
    const budget = ExplorationBudget.from(policy({ maximumRecoveries: 1 }), new FakeClock());
    expect(budget.reserveRecovery().ok).toBe(true);
    expect(budget.reserveRecovery()).toMatchObject({
      ok: false,
      reason: "budget_exhausted",
    });
  });

  it("reserves model tokens against the cap and settles actual usage", () => {
    const budget = ExplorationBudget.from(
      policy({ maximumModelTokens: 100 }),
      new FakeClock(),
    );
    const reservation = budget.reserveModelTokens(60);
    expect(reservation.ok).toBe(true);
    // Settling a lower actual usage frees the reservation difference.
    budget.settleModelTokens(60, 20);
    expect(budget.snapshot().remainingModelTokens).toBe(80);
    expect(budget.reserveModelTokens(90)).toMatchObject({
      ok: false,
      reason: "budget_exhausted",
    });
  });

  it("stops before the next step once the wall clock is exceeded", () => {
    const clock = new FakeClock();
    const budget = ExplorationBudget.from(policy({ maximumWallClockMs: 1_000 }), clock);
    expect(budget.checkWallClock().ok).toBe(true);
    clock.advance(1_000);
    expect(budget.checkWallClock()).toMatchObject({
      ok: false,
      reason: "budget_exhausted",
    });
  });

  it("reflects remaining budget in a snapshot", () => {
    const budget = ExplorationBudget.from(
      policy({
        maximumSteps: 4,
        maximumStateVisits: 3,
        maximumModelTokens: 500,
        maximumRecoveries: 2,
        maximumWallClockMs: 5_000,
      }),
      new FakeClock(),
    );
    budget.reserveStep();
    budget.reserveStateVisit();
    budget.reserveModelTokens(100);
    budget.reserveRecovery();

    expect(budget.snapshot()).toEqual({
      remainingSteps: 3,
      remainingWallClockMs: 5_000,
      remainingModelTokens: 400,
      remainingStateVisits: 2,
      remainingRecoveries: 1,
    });
  });

  it("canContinue is false once any dimension is exhausted", () => {
    const clock = new FakeClock();
    const budget = ExplorationBudget.from(policy({ maximumSteps: 1 }), clock);
    expect(budget.canContinue()).toBe(true);
    budget.reserveStep();
    expect(budget.canContinue()).toBe(false);
  });

  it("rejects a policy with a negative limit", () => {
    expect(() =>
      ExplorationBudget.from(policy({ maximumSteps: -1 }), new FakeClock()),
    ).toThrow(/negative/i);
  });
});
