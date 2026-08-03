import type { Result, Clock, Instant } from "@qualigence/shared-kernel";
import type { PrdSourceRef } from "@qualigence/context-intake";
import type {
  SemanticTarget,
  ValidatedExpectedClaim,
  ValidatedIntentStep,
  ValidatedTestPlanProposal,
} from "@qualigence/application-model";

/** Final expected claim with an allocated identity. */
export interface ExpectedClaim {
  readonly claimId: string;
  readonly semanticKey: string;
  readonly statement: string;
  readonly sourceRefs: readonly [PrdSourceRef, ...PrdSourceRef[]];
  readonly confidence: number;
}

/** Final intent step: verify steps reference concrete claim IDs, not keys. */
export type IntentStep =
  | { readonly kind: "navigate"; readonly path: string }
  | { readonly kind: "click"; readonly target: SemanticTarget }
  | {
      readonly kind: "input";
      readonly target: SemanticTarget;
      readonly valueRef: string;
    }
  | {
      readonly kind: "verify";
      readonly claimIds: readonly [string, ...string[]];
    };

export interface TestCase {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly [IntentStep, ...IntentStep[]];
  readonly expectedClaims: readonly [ExpectedClaim, ...ExpectedClaim[]];
  readonly sourceRefs: readonly [PrdSourceRef, ...PrdSourceRef[]];
  readonly priority: "low" | "medium" | "high";
}

export type TestPlanStatus = "draft" | "approved";

export interface TestPlanApproval {
  readonly reviewerId: string;
  readonly approvedAt: Instant;
  readonly idempotencyKey: string;
}

/**
 * A versioned Test Plan revision aggregate. Approval is a single-writer,
 * expected-version optimistic-concurrency transition — never last-writer-wins.
 */
export interface TestPlanRevision {
  readonly planId: string;
  readonly projectId: string;
  readonly prdId: string;
  readonly prdRevision: number;
  readonly version: number;
  readonly status: TestPlanStatus;
  readonly expectedClaims: readonly [ExpectedClaim, ...ExpectedClaim[]];
  readonly testCases: readonly [TestCase, ...TestCase[]];
  readonly approval?: TestPlanApproval;
}

export type MissionErrorCode =
  | "PlanVersionConflict"
  | "PlanNotApproved"
  | "PlanAlreadyApproved"
  | "TargetCapabilityMismatch"
  | "MissionBudgetExceeded"
  | "EmptyTestPlan";

export interface MissionError {
  readonly code: MissionErrorCode;
  readonly message: string;
}

export interface CreateTestPlanInput {
  readonly projectId: string;
  readonly prdId: string;
  readonly prdRevision: number;
  readonly proposal: ValidatedTestPlanProposal;
}

export interface ApproveTestPlanCommand {
  readonly expectedVersion: number;
  readonly reviewerId: string;
  readonly idempotencyKey: string;
}

function compileStep(
  step: ValidatedIntentStep,
  claimIdByKey: ReadonlyMap<string, string>,
): IntentStep {
  switch (step.kind) {
    case "navigate":
      return { kind: "navigate", path: step.path };
    case "click":
      return { kind: "click", target: step.target };
    case "input":
      return { kind: "input", target: step.target, valueRef: step.valueRef };
    case "verify": {
      const claimIds = step.claimSemanticKeys.map((key) => {
        const claimId = claimIdByKey.get(key);
        if (claimId === undefined) {
          throw new Error(`No claim id allocated for semantic key "${key}".`);
        }
        return claimId;
      });
      const [first, ...rest] = claimIds;
      if (first === undefined) {
        throw new Error("Verify step compiled to zero claim ids.");
      }
      return { kind: "verify", claimIds: [first, ...rest] };
    }
  }
}

function toFinalClaim(
  claim: ValidatedExpectedClaim,
  claimId: string,
): ExpectedClaim {
  return {
    claimId,
    semanticKey: claim.semanticKey,
    statement: claim.statement,
    sourceRefs: claim.sourceRefs,
    confidence: claim.confidence,
  };
}

/**
 * Create a draft {@link TestPlanRevision} from a validated proposal, allocating
 * deterministic IDs via {@link idFactory} and compiling verify steps' semantic
 * keys into concrete claim IDs. Starts at version 1 in `draft` status.
 */
export function createDraftTestPlan(
  input: CreateTestPlanInput,
  idFactory: () => string,
): Result<TestPlanRevision, MissionError> {
  const { proposal } = input;
  if (proposal.expectedClaims.length === 0 || proposal.testCases.length === 0) {
    return {
      ok: false,
      error: {
        code: "EmptyTestPlan",
        message: "A test plan needs at least one claim and test case.",
      },
    };
  }

  const claimIdByKey = new Map<string, string>();
  const claimByKey = new Map<string, ExpectedClaim>();
  const finalClaims: ExpectedClaim[] = [];
  for (const claim of proposal.expectedClaims) {
    const claimId = idFactory();
    const finalClaim = toFinalClaim(claim, claimId);
    claimIdByKey.set(claim.semanticKey, claimId);
    claimByKey.set(claim.semanticKey, finalClaim);
    finalClaims.push(finalClaim);
  }

  const finalTestCases: TestCase[] = [];
  for (const testCase of proposal.testCases) {
    const steps = testCase.steps.map((step) =>
      compileStep(step, claimIdByKey),
    );
    const [firstStep, ...restSteps] = steps;
    if (firstStep === undefined) {
      return {
        ok: false,
        error: {
          code: "EmptyTestPlan",
          message: `Test case "${testCase.title}" has no steps.`,
        },
      };
    }

    const expectedClaims = testCase.expectedClaimSemanticKeys.map((key) => {
      const claim = claimByKey.get(key);
      if (claim === undefined) {
        throw new Error(`No claim for semantic key "${key}".`);
      }
      return claim;
    });
    const [firstClaim, ...restClaims] = expectedClaims;
    if (firstClaim === undefined) {
      return {
        ok: false,
        error: {
          code: "EmptyTestPlan",
          message: `Test case "${testCase.title}" references no claims.`,
        },
      };
    }

    finalTestCases.push({
      id: idFactory(),
      title: testCase.title,
      objective: testCase.objective,
      preconditions: testCase.preconditions,
      steps: [firstStep, ...restSteps],
      expectedClaims: [firstClaim, ...restClaims],
      sourceRefs: testCase.sourceRefs,
      priority: testCase.priority,
    });
  }

  const [firstClaim, ...restClaims] = finalClaims;
  const [firstTestCase, ...restTestCases] = finalTestCases;
  if (firstClaim === undefined || firstTestCase === undefined) {
    return {
      ok: false,
      error: {
        code: "EmptyTestPlan",
        message: "A test plan needs at least one claim and test case.",
      },
    };
  }

  const revision: TestPlanRevision = {
    planId: idFactory(),
    projectId: input.projectId,
    prdId: input.prdId,
    prdRevision: input.prdRevision,
    version: 1,
    status: "draft",
    expectedClaims: [firstClaim, ...restClaims],
    testCases: [firstTestCase, ...restTestCases],
  };

  return { ok: true, value: Object.freeze(revision) };
}

/**
 * Approve a draft plan. Requires the caller's {@link ApproveTestPlanCommand.expectedVersion}
 * to equal the current version (optimistic concurrency); a mismatch is a stale
 * write and returns `PlanVersionConflict`. Re-approving with the same
 * idempotency key returns the original approved revision unchanged.
 */
export function approveTestPlan(
  plan: TestPlanRevision,
  command: ApproveTestPlanCommand,
  clock: Clock,
): Result<TestPlanRevision, MissionError> {
  if (plan.status === "approved") {
    if (plan.approval?.idempotencyKey === command.idempotencyKey) {
      return { ok: true, value: plan };
    }
    return {
      ok: false,
      error: {
        code: "PlanAlreadyApproved",
        message: `Plan ${plan.planId} is already approved.`,
      },
    };
  }

  if (command.expectedVersion !== plan.version) {
    return {
      ok: false,
      error: {
        code: "PlanVersionConflict",
        message: `Expected version ${command.expectedVersion} but plan ${plan.planId} is at version ${plan.version}.`,
      },
    };
  }

  const approvedPlan: TestPlanRevision = {
    ...plan,
    version: plan.version + 1,
    status: "approved",
    approval: {
      reviewerId: command.reviewerId,
      approvedAt: clock.now(),
      idempotencyKey: command.idempotencyKey,
    },
  };

  return { ok: true, value: Object.freeze(approvedPlan) };
}
