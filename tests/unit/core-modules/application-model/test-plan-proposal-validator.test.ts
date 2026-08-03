import { describe, expect, it } from "vitest";
import {
  PrdDocument,
  sha256Hex,
} from "@qualigence/context-intake";
import type { PrdSourceRef } from "@qualigence/context-intake";
import {
  TestPlanProposalValidator,
} from "@qualigence/application-model";
import type {
  ProposedExpectedClaim,
  ProposedTestCase,
  TestPlanProposal,
} from "@qualigence/application-model";
import type { Clock } from "@qualigence/shared-kernel";

const fixedClock: Clock = { now: () => "2026-08-01T00:00:00.000Z" };

const CONTENT = "Cart total equals the sum of item prices. Checkout is enabled.";
const document = PrdDocument.create(
  { prdId: "prd-1", revision: 1, projectId: "p", title: "Cart", content: CONTENT },
  fixedClock,
);

function refFor(quote: string): PrdSourceRef {
  const startOffset = CONTENT.indexOf(quote);
  if (startOffset < 0) throw new Error(`quote not found: ${quote}`);
  return {
    prdId: document.prdId,
    revision: document.revision,
    startOffset,
    endOffset: startOffset + quote.length,
    quotedTextSha256: sha256Hex(quote),
  };
}

const groundedRef = refFor("Cart total equals the sum of item prices.");

function claim(
  overrides: Partial<ProposedExpectedClaim> = {},
): ProposedExpectedClaim {
  return {
    semanticKey: "cart-total",
    statement: "Cart total equals the sum of item prices.",
    sourceRefs: [groundedRef],
    confidence: 0.9,
    ...overrides,
  };
}

function testCase(
  overrides: Partial<ProposedTestCase> = {},
): ProposedTestCase {
  return {
    title: "Add item and verify total",
    objective: "Ensure the cart total reflects item prices.",
    preconditions: ["A product is available."],
    steps: [
      { kind: "navigate", path: "/cart" },
      { kind: "click", target: { role: "button", name: "Add to cart", purpose: "add the item" } },
      { kind: "verify", claimSemanticKeys: ["cart-total"] },
    ],
    expectedClaimSemanticKeys: ["cart-total"],
    sourceRefs: [groundedRef],
    priority: "high",
    ...overrides,
  };
}

function proposal(overrides: Partial<TestPlanProposal> = {}): TestPlanProposal {
  return {
    expectedClaims: [claim()],
    testCases: [testCase()],
    ...overrides,
  };
}

const validator = new TestPlanProposalValidator();

describe("TestPlanProposalValidator acceptance", () => {
  it("accepts a grounded click/verify proposal and normalizes keys", () => {
    const result = validator.validate(document, proposal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expectedClaims[0]?.semanticKey).toBe("cart-total");
    expect(result.value.testCases[0]?.expectedClaimSemanticKeys).toEqual([
      "cart-total",
    ]);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("normalizes mixed-case/spaced semantic keys before matching", () => {
    const result = validator.validate(
      document,
      proposal({
        expectedClaims: [claim({ semanticKey: "Cart Total" })],
        testCases: [
          testCase({
            expectedClaimSemanticKeys: ["cart-total"],
            steps: [
              { kind: "navigate", path: "/cart" },
              { kind: "verify", claimSemanticKeys: ["CART TOTAL"] },
            ],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("TestPlanProposalValidator rejection matrix", () => {
  it("rejects an empty proposal", () => {
    const result = validator.validate(document, {
      expectedClaims: [],
      testCases: [],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "InvalidPlanningProposal", reason: "EmptyProposal" },
    });
  });

  it("rejects a claim with no source citation (missing provenance)", () => {
    const result = validator.validate(
      document,
      proposal({
        expectedClaims: [
          { ...claim(), sourceRefs: [] as unknown as ProposedExpectedClaim["sourceRefs"] },
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "InvalidPlanningProposal", reason: "MissingProvenance" },
    });
  });

  it("rejects a claim whose source offsets/hash do not match the PRD", () => {
    const badRef: PrdSourceRef = { ...groundedRef, endOffset: groundedRef.endOffset + 3 };
    const result = validator.validate(
      document,
      proposal({ expectedClaims: [claim({ sourceRefs: [badRef] })] }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PrdSourceMismatch", reason: "SourceRefOutOfBounds" },
    });
  });

  it("rejects duplicate semantic keys", () => {
    const result = validator.validate(
      document,
      proposal({
        expectedClaims: [claim(), claim({ statement: "Cart total is correct." })],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "InvalidPlanningProposal", reason: "DuplicateSemanticKey" },
    });
  });

  it("rejects confidence outside [0,1]", () => {
    const result = validator.validate(
      document,
      proposal({ expectedClaims: [claim({ confidence: 1.5 })] }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "InvalidPlanningProposal", reason: "ConfidenceOutOfRange" },
    });
  });

  it("rejects contradictory assertions across claims", () => {
    const result = validator.validate(
      document,
      proposal({
        expectedClaims: [
          claim(),
          claim({
            semanticKey: "cart-total-negative",
            statement: "Cart total not equals the sum of item prices.",
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "InvalidPlanningProposal", reason: "ContradictoryAssertions" },
    });
  });

  it("rejects a proposal referencing a claim that does not exist", () => {
    const result = validator.validate(
      document,
      proposal({
        testCases: [testCase({ expectedClaimSemanticKeys: ["missing-claim"] })],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "InvalidPlanningProposal", reason: "UnknownClaimReference" },
    });
  });

  it("rejects a test case with no steps", () => {
    const result = validator.validate(
      document,
      proposal({
        testCases: [
          { ...testCase(), steps: [] as unknown as ProposedTestCase["steps"] },
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "InvalidPlanningProposal", reason: "EmptySteps" },
    });
  });

  it("rejects an unknown step action kind", () => {
    const result = validator.validate(
      document,
      proposal({
        testCases: [
          testCase({
            steps: [
              { kind: "teleport" } as unknown as ProposedTestCase["steps"][number],
            ] as unknown as ProposedTestCase["steps"],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "InvalidPlanningProposal", reason: "UnknownAction" },
    });
  });

  it("rejects a CSS selector leak", () => {
    const result = validator.validate(
      document,
      proposal({
        testCases: [
          testCase({
            steps: [
              { kind: "click", target: { purpose: "css=#buy" } },
              { kind: "verify", claimSemanticKeys: ["cart-total"] },
            ],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SelectorLeakRejected", reason: "SelectorLeak" },
    });
  });

  it("rejects an XPath selector leak", () => {
    const result = validator.validate(
      document,
      proposal({
        testCases: [
          testCase({
            steps: [
              { kind: "click", target: { purpose: "//button[@id='buy']" } },
              { kind: "verify", claimSemanticKeys: ["cart-total"] },
            ],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SelectorLeakRejected", reason: "SelectorLeak" },
    });
  });

  it("rejects coordinate leaks", () => {
    const result = validator.validate(
      document,
      proposal({
        testCases: [
          testCase({
            steps: [
              { kind: "click", target: { purpose: "click at (120, 480)" } },
              { kind: "verify", claimSemanticKeys: ["cart-total"] },
            ],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SelectorLeakRejected", reason: "SelectorLeak" },
    });
  });

  it("rejects script injection leaks", () => {
    const result = validator.validate(
      document,
      proposal({
        testCases: [
          testCase({
            steps: [
              { kind: "input", target: { purpose: "search box" }, valueRef: "javascript:alert(1)" },
              { kind: "verify", claimSemanticKeys: ["cart-total"] },
            ],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SelectorLeakRejected", reason: "SelectorLeak" },
    });
  });

  it("rejects URL credentials in a navigation path", () => {
    const result = validator.validate(
      document,
      proposal({
        testCases: [
          testCase({
            steps: [
              { kind: "navigate", path: "https://user:pass@shop.example/cart" },
              { kind: "verify", claimSemanticKeys: ["cart-total"] },
            ],
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SelectorLeakRejected", reason: "SelectorLeak" },
    });
  });
});
