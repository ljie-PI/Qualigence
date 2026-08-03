export {
  normalizeSemanticKey,
} from "./domain/expected-claim.js";

export type {
  ProposedExpectedClaim,
  ProposedIntentStep,
  ProposedTestCase,
  SemanticTarget,
  TestPlanProposal,
  ValidatedExpectedClaim,
  ValidatedIntentStep,
  ValidatedTestCase,
  ValidatedTestPlanProposal,
} from "./domain/expected-claim.js";

export { TestPlanProposalValidator } from "./application/test-plan-proposal-validator.js";

export type {
  PlanningValidationError,
  PlanningValidationErrorCode,
  PlanningValidationReason,
} from "./application/test-plan-proposal-validator.js";
