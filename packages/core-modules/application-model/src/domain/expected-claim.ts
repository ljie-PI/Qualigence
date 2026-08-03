import type { PrdSourceRef } from "@qualigence/context-intake";

export interface SemanticTarget {
  readonly role?: string;
  readonly name?: string;
  readonly purpose: string;
}

/** A single expected claim proposed by the planner (no ID yet). */
export interface ProposedExpectedClaim {
  readonly semanticKey: string;
  readonly statement: string;
  readonly sourceRefs: readonly [PrdSourceRef, ...PrdSourceRef[]];
  readonly confidence: number;
}

export type ProposedIntentStep =
  | { readonly kind: "navigate"; readonly path: string }
  | { readonly kind: "click"; readonly target: SemanticTarget }
  | {
      readonly kind: "input";
      readonly target: SemanticTarget;
      readonly valueRef: string;
    }
  | {
      readonly kind: "verify";
      readonly claimSemanticKeys: readonly [string, ...string[]];
    };

export interface ProposedTestCase {
  readonly title: string;
  readonly objective: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly [ProposedIntentStep, ...ProposedIntentStep[]];
  readonly expectedClaimSemanticKeys: readonly [string, ...string[]];
  readonly sourceRefs: readonly [PrdSourceRef, ...PrdSourceRef[]];
  readonly priority: "low" | "medium" | "high";
}

export interface TestPlanProposal {
  readonly expectedClaims: readonly ProposedExpectedClaim[];
  readonly testCases: readonly ProposedTestCase[];
}

/** A validated claim: semantic key normalized, statement text preserved. */
export interface ValidatedExpectedClaim {
  readonly semanticKey: string;
  readonly statement: string;
  readonly sourceRefs: readonly [PrdSourceRef, ...PrdSourceRef[]];
  readonly confidence: number;
}

export type ValidatedIntentStep =
  | { readonly kind: "navigate"; readonly path: string }
  | { readonly kind: "click"; readonly target: SemanticTarget }
  | {
      readonly kind: "input";
      readonly target: SemanticTarget;
      readonly valueRef: string;
    }
  | {
      readonly kind: "verify";
      readonly claimSemanticKeys: readonly [string, ...string[]];
    };

export interface ValidatedTestCase {
  readonly title: string;
  readonly objective: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly [ValidatedIntentStep, ...ValidatedIntentStep[]];
  readonly expectedClaimSemanticKeys: readonly [string, ...string[]];
  readonly sourceRefs: readonly [PrdSourceRef, ...PrdSourceRef[]];
  readonly priority: "low" | "medium" | "high";
}

export interface ValidatedTestPlanProposal {
  readonly expectedClaims: readonly ValidatedExpectedClaim[];
  readonly testCases: readonly ValidatedTestCase[];
}

/** Normalize a semantic key: trimmed, lower-cased, whitespace collapsed to `-`. */
export function normalizeSemanticKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "-");
}
