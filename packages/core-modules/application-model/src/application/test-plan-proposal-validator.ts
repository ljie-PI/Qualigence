import type { Result } from "@qualigence/shared-kernel";
import type { PrdDocument, PrdSourceRef } from "@qualigence/context-intake";
import { verifySourceRef } from "@qualigence/context-intake";
import {
  normalizeSemanticKey,
  type ProposedExpectedClaim,
  type ProposedIntentStep,
  type ProposedTestCase,
  type SemanticTarget,
  type TestPlanProposal,
  type ValidatedExpectedClaim,
  type ValidatedIntentStep,
  type ValidatedTestCase,
  type ValidatedTestPlanProposal,
} from "../domain/expected-claim.js";

export type PlanningValidationErrorCode =
  | "InvalidPlanningProposal"
  | "PrdSourceMismatch"
  | "SelectorLeakRejected";

/**
 * A stable, machine-readable reason distinguishing each row of the deterministic
 * rejection matrix. `code` maps to the frozen Design error codes.
 */
export type PlanningValidationReason =
  | "EmptyProposal"
  | "MissingProvenance"
  | "SourceRefOutOfBounds"
  | "DuplicateSemanticKey"
  | "ConfidenceOutOfRange"
  | "EmptySteps"
  | "UnknownAction"
  | "UnknownClaimReference"
  | "ContradictoryAssertions"
  | "SelectorLeak";

export interface PlanningValidationError {
  readonly code: PlanningValidationErrorCode;
  readonly reason: PlanningValidationReason;
  readonly message: string;
}

type Fail = { readonly ok: false; readonly error: PlanningValidationError };

function fail(
  code: PlanningValidationErrorCode,
  reason: PlanningValidationReason,
  message: string,
): Fail {
  return { ok: false, error: { code, reason, message } };
}

const KNOWN_STEP_KINDS = new Set([
  "navigate",
  "click",
  "input",
  "verify",
]);

const NEGATION_TOKENS = new Set([
  "not",
  "no",
  "never",
  "cannot",
  "without",
]);

// Deterministic selector/injection leak detectors. Purpose/name/role/valueRef
// fields are semantic and must never carry CSS/XPath/coordinate/script/creds.
const CSS_SELECTOR = /css\s*=/i;
const XPATH_EXPR = /(xpath\s*=)|((^|[^:])\/\/)/;
const COORDINATE = /(\bx\s*=\s*-?\d)|(\by\s*=\s*-?\d)|(@\s*\(?\s*-?\d+\s*,\s*-?\d+)|(\bat\s+\(?\s*-?\d+\s*,\s*-?\d+)/i;
const SCRIPT_INJECTION = /(javascript:)|(<\s*script)|(\beval\s*\()|(=>)|(\bfunction\s*\()/i;
const URL_CREDENTIALS = /:\/\/[^/@\s]+:[^/@\s]+@/;

function selectorLeakReason(text: string): string | undefined {
  if (CSS_SELECTOR.test(text)) return "css selector";
  if (XPATH_EXPR.test(text)) return "xpath expression";
  if (COORDINATE.test(text)) return "coordinate";
  if (SCRIPT_INJECTION.test(text)) return "script";
  if (URL_CREDENTIALS.test(text)) return "url credentials";
  return undefined;
}

function targetStrings(target: SemanticTarget): string[] {
  const values = [target.purpose];
  if (target.role !== undefined) values.push(target.role);
  if (target.name !== undefined) values.push(target.name);
  return values;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Normalize a statement for negation-aware contradiction detection. */
function statementTokens(statement: string): {
  readonly stripped: string;
  readonly hasNegation: boolean;
} {
  const words = statement
    .trim()
    .toLowerCase()
    .replace(/[.,;:!?]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const hasNegation = words.some((word) => NEGATION_TOKENS.has(word));
  const stripped = words
    .filter((word) => !NEGATION_TOKENS.has(word))
    .join(" ");
  return { stripped, hasNegation };
}

/**
 * Deterministic validator implementing the LS-07 rejection matrix. It never
 * calls a model, allocates IDs, or persists anything; it returns an immutable
 * validated value or a stable error code.
 */
export class TestPlanProposalValidator {
  validate(
    document: PrdDocument,
    proposal: TestPlanProposal,
  ): Result<ValidatedTestPlanProposal, PlanningValidationError> {
    const claims = proposal.expectedClaims ?? [];
    const testCases = proposal.testCases ?? [];

    if (claims.length === 0 || testCases.length === 0) {
      return fail(
        "InvalidPlanningProposal",
        "EmptyProposal",
        "A proposal must contain at least one expected claim and test case.",
      );
    }

    const validatedClaims: ValidatedExpectedClaim[] = [];
    const claimKeys = new Set<string>();

    for (const claim of claims) {
      const claimResult = this.#validateClaim(document, claim, claimKeys);
      if (!claimResult.ok) return claimResult;
      claimKeys.add(claimResult.value.semanticKey);
      validatedClaims.push(claimResult.value);
    }

    const contradiction = this.#detectContradiction(validatedClaims);
    if (contradiction !== undefined) return contradiction;

    const validatedTestCases: ValidatedTestCase[] = [];
    for (const testCase of testCases) {
      const testCaseResult = this.#validateTestCase(
        document,
        testCase,
        claimKeys,
      );
      if (!testCaseResult.ok) return testCaseResult;
      validatedTestCases.push(testCaseResult.value);
    }

    return {
      ok: true,
      value: Object.freeze({
        expectedClaims: Object.freeze(validatedClaims),
        testCases: Object.freeze(validatedTestCases),
      }),
    };
  }

  #validateClaim(
    document: PrdDocument,
    claim: ProposedExpectedClaim,
    seenKeys: ReadonlySet<string>,
  ): Result<ValidatedExpectedClaim, PlanningValidationError> {
    if (
      !isNonEmptyString(claim.semanticKey) ||
      !isNonEmptyString(claim.statement)
    ) {
      return fail(
        "InvalidPlanningProposal",
        "MissingProvenance",
        "Every claim requires a semantic key and statement.",
      );
    }

    if (!Array.isArray(claim.sourceRefs) || claim.sourceRefs.length === 0) {
      return fail(
        "InvalidPlanningProposal",
        "MissingProvenance",
        `Claim "${claim.semanticKey}" is missing source provenance.`,
      );
    }

    const key = normalizeSemanticKey(claim.semanticKey);
    if (seenKeys.has(key)) {
      return fail(
        "InvalidPlanningProposal",
        "DuplicateSemanticKey",
        `Duplicate claim semantic key "${key}".`,
      );
    }

    if (
      typeof claim.confidence !== "number" ||
      Number.isNaN(claim.confidence) ||
      claim.confidence < 0 ||
      claim.confidence > 1
    ) {
      return fail(
        "InvalidPlanningProposal",
        "ConfidenceOutOfRange",
        `Claim "${key}" confidence must be within [0, 1].`,
      );
    }

    const sourceResult = this.#validateSourceRefs(document, claim.sourceRefs);
    if (!sourceResult.ok) return sourceResult;

    return {
      ok: true,
      value: {
        semanticKey: key,
        statement: claim.statement,
        sourceRefs: claim.sourceRefs,
        confidence: claim.confidence,
      },
    };
  }

  #validateSourceRefs(
    document: PrdDocument,
    sourceRefs: readonly PrdSourceRef[],
  ): Result<true, PlanningValidationError> {
    for (const ref of sourceRefs) {
      if (!verifySourceRef(document, ref)) {
        return fail(
          "PrdSourceMismatch",
          "SourceRefOutOfBounds",
          "Source reference does not match the PRD offsets or hash.",
        );
      }
    }
    return { ok: true, value: true };
  }

  #detectContradiction(
    claims: readonly ValidatedExpectedClaim[],
  ): Fail | undefined {
    const tokenized = claims.map((claim) => ({
      key: claim.semanticKey,
      ...statementTokens(claim.statement),
    }));

    for (let i = 0; i < tokenized.length; i += 1) {
      for (let j = i + 1; j < tokenized.length; j += 1) {
        const a = tokenized[i];
        const b = tokenized[j];
        if (a === undefined || b === undefined) continue;
        if (a.stripped.length === 0) continue;
        if (a.stripped === b.stripped && a.hasNegation !== b.hasNegation) {
          return fail(
            "InvalidPlanningProposal",
            "ContradictoryAssertions",
            `Claims "${a.key}" and "${b.key}" assert contradictory statements.`,
          );
        }
      }
    }
    return undefined;
  }

  #validateTestCase(
    document: PrdDocument,
    testCase: ProposedTestCase,
    claimKeys: ReadonlySet<string>,
  ): Result<ValidatedTestCase, PlanningValidationError> {
    if (!Array.isArray(testCase.sourceRefs) || testCase.sourceRefs.length === 0) {
      return fail(
        "InvalidPlanningProposal",
        "MissingProvenance",
        `Test case "${testCase.title}" is missing source provenance.`,
      );
    }

    const sourceResult = this.#validateSourceRefs(document, testCase.sourceRefs);
    if (!sourceResult.ok) return sourceResult;

    if (!Array.isArray(testCase.steps) || testCase.steps.length === 0) {
      return fail(
        "InvalidPlanningProposal",
        "EmptySteps",
        `Test case "${testCase.title}" must contain at least one step.`,
      );
    }

    if (
      !Array.isArray(testCase.expectedClaimSemanticKeys) ||
      testCase.expectedClaimSemanticKeys.length === 0
    ) {
      return fail(
        "InvalidPlanningProposal",
        "MissingProvenance",
        `Test case "${testCase.title}" must reference at least one expected claim.`,
      );
    }

    const normalizedExpected: string[] = [];
    for (const rawKey of testCase.expectedClaimSemanticKeys) {
      const key = normalizeSemanticKey(rawKey);
      if (!claimKeys.has(key)) {
        return fail(
          "InvalidPlanningProposal",
          "UnknownClaimReference",
          `Test case "${testCase.title}" references unknown claim "${key}".`,
        );
      }
      normalizedExpected.push(key);
    }

    const validatedSteps: ValidatedIntentStep[] = [];
    for (const step of testCase.steps) {
      const stepResult = this.#validateStep(step, claimKeys, testCase.title);
      if (!stepResult.ok) return stepResult;
      validatedSteps.push(stepResult.value);
    }

    const [firstExpected, ...restExpected] = normalizedExpected;
    const [firstStep, ...restSteps] = validatedSteps;
    if (firstExpected === undefined || firstStep === undefined) {
      return fail(
        "InvalidPlanningProposal",
        "EmptySteps",
        `Test case "${testCase.title}" produced no valid steps.`,
      );
    }

    return {
      ok: true,
      value: {
        title: testCase.title,
        objective: testCase.objective,
        preconditions: testCase.preconditions,
        steps: [firstStep, ...restSteps],
        expectedClaimSemanticKeys: [firstExpected, ...restExpected],
        sourceRefs: testCase.sourceRefs,
        priority: testCase.priority,
      },
    };
  }

  #validateStep(
    step: ProposedIntentStep,
    claimKeys: ReadonlySet<string>,
    testCaseTitle: string,
  ): Result<ValidatedIntentStep, PlanningValidationError> {
    if (!KNOWN_STEP_KINDS.has((step as { kind: string }).kind)) {
      return fail(
        "InvalidPlanningProposal",
        "UnknownAction",
        `Test case "${testCaseTitle}" has an unknown step kind.`,
      );
    }

    switch (step.kind) {
      case "navigate": {
        const leak = this.#navigateLeak(step.path);
        if (leak !== undefined) return leak;
        return { ok: true, value: { kind: "navigate", path: step.path } };
      }
      case "click": {
        const leak = this.#targetLeak(step.target);
        if (leak !== undefined) return leak;
        return { ok: true, value: { kind: "click", target: step.target } };
      }
      case "input": {
        const leak =
          this.#targetLeak(step.target) ?? this.#fieldLeak(step.valueRef);
        if (leak !== undefined) return leak;
        return {
          ok: true,
          value: { kind: "input", target: step.target, valueRef: step.valueRef },
        };
      }
      case "verify": {
        const normalized: string[] = [];
        for (const rawKey of step.claimSemanticKeys) {
          const key = normalizeSemanticKey(rawKey);
          if (!claimKeys.has(key)) {
            return fail(
              "InvalidPlanningProposal",
              "UnknownClaimReference",
              `Verify step references unknown claim "${key}".`,
            );
          }
          normalized.push(key);
        }
        const [first, ...rest] = normalized;
        if (first === undefined) {
          return fail(
            "InvalidPlanningProposal",
            "EmptySteps",
            "Verify step must reference at least one claim.",
          );
        }
        return {
          ok: true,
          value: { kind: "verify", claimSemanticKeys: [first, ...rest] },
        };
      }
      default: {
        return fail(
          "InvalidPlanningProposal",
          "UnknownAction",
          `Test case "${testCaseTitle}" has an unknown step kind.`,
        );
      }
    }
  }

  #navigateLeak(path: string): Fail | undefined {
    if (URL_CREDENTIALS.test(path)) {
      return fail(
        "SelectorLeakRejected",
        "SelectorLeak",
        "Navigation path must not embed url credentials.",
      );
    }
    if (path.startsWith("//") || CSS_SELECTOR.test(path) ||
      SCRIPT_INJECTION.test(path) || COORDINATE.test(path)) {
      return fail(
        "SelectorLeakRejected",
        "SelectorLeak",
        "Navigation path must not contain selectors, scripts or coordinates.",
      );
    }
    return undefined;
  }

  #targetLeak(target: SemanticTarget): Fail | undefined {
    for (const value of targetStrings(target)) {
      const leak = this.#fieldLeak(value);
      if (leak !== undefined) return leak;
    }
    return undefined;
  }

  #fieldLeak(value: string): Fail | undefined {
    const reason = selectorLeakReason(value);
    if (reason !== undefined) {
      return fail(
        "SelectorLeakRejected",
        "SelectorLeak",
        `Rejected ${reason} in a semantic field.`,
      );
    }
    return undefined;
  }
}
