import { describe, expect, it } from "vitest";
import {
  approveTestPlan,
  createDraftTestPlan,
} from "@qualigence/mission";
import type { Clock } from "@qualigence/shared-kernel";
import { sequentialIds, validatedProposal } from "./fixtures.js";

const fixedClock: Clock = { now: () => "2026-08-01T00:00:00.000Z" };

function draftPlan() {
  const result = createDraftTestPlan(
    { projectId: "p", prdId: "prd-1", prdRevision: 1, proposal: validatedProposal() },
    sequentialIds(),
  );
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("createDraftTestPlan", () => {
  it("creates a versioned draft with allocated claim/test-case ids", () => {
    const plan = draftPlan();
    expect(plan.status).toBe("draft");
    expect(plan.version).toBe(1);
    expect(plan.prdRevision).toBe(1);
    expect(plan.expectedClaims[0]?.claimId).toBeTruthy();
    expect(plan.testCases[0]?.id).toBeTruthy();
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("compiles verify steps' semantic keys into concrete claim ids", () => {
    const plan = draftPlan();
    const claimId = plan.expectedClaims[0]?.claimId;
    const verifyStep = plan.testCases[0]?.steps.find(
      (step) => step.kind === "verify",
    );
    expect(verifyStep?.kind).toBe("verify");
    if (verifyStep?.kind !== "verify") return;
    expect(verifyStep.claimIds).toEqual([claimId]);
  });
});

describe("approveTestPlan optimistic concurrency", () => {
  it("rejects approval with a stale expectedVersion (PlanVersionConflict)", () => {
    const plan = draftPlan();
    const result = approveTestPlan(
      plan,
      { expectedVersion: 0, reviewerId: "r", idempotencyKey: "k" },
      fixedClock,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PlanVersionConflict" },
    });
  });

  it("approves with the correct expectedVersion and bumps the version", () => {
    const plan = draftPlan();
    const result = approveTestPlan(
      plan,
      { expectedVersion: 1, reviewerId: "reviewer-1", idempotencyKey: "k1" },
      fixedClock,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("approved");
    expect(result.value.version).toBe(2);
    expect(result.value.approval).toMatchObject({
      reviewerId: "reviewer-1",
      idempotencyKey: "k1",
      approvedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("does not mutate the original draft (single-writer, no in-place update)", () => {
    const plan = draftPlan();
    approveTestPlan(
      plan,
      { expectedVersion: 1, reviewerId: "r", idempotencyKey: "k" },
      fixedClock,
    );
    expect(plan.status).toBe("draft");
    expect(plan.version).toBe(1);
  });

  it("returns the original approved revision for a duplicate idempotency key", () => {
    const plan = draftPlan();
    const first = approveTestPlan(
      plan,
      { expectedVersion: 1, reviewerId: "r", idempotencyKey: "dup" },
      fixedClock,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = approveTestPlan(
      first.value,
      { expectedVersion: 2, reviewerId: "r", idempotencyKey: "dup" },
      fixedClock,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toBe(first.value);
  });

  it("rejects re-approval with a different idempotency key", () => {
    const plan = draftPlan();
    const first = approveTestPlan(
      plan,
      { expectedVersion: 1, reviewerId: "r", idempotencyKey: "k1" },
      fixedClock,
    );
    if (!first.ok) throw new Error("expected approval");
    const second = approveTestPlan(
      first.value,
      { expectedVersion: 2, reviewerId: "r", idempotencyKey: "k2" },
      fixedClock,
    );
    expect(second).toMatchObject({
      ok: false,
      error: { code: "PlanAlreadyApproved" },
    });
  });
});
