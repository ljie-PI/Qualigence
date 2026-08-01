import { PrdDocument, sha256Hex } from "@qualigence/context-intake";
import type { PrdSourceRef } from "@qualigence/context-intake";
import { TestPlanProposalValidator } from "@qualigence/application-model";
import type { ValidatedTestPlanProposal } from "@qualigence/application-model";
import type { Clock } from "@qualigence/shared-kernel";

const fixedClock: Clock = { now: () => "2026-08-01T00:00:00.000Z" };

const CONTENT = "Cart total equals the sum of item prices. Checkout is enabled.";

export const prdDocument = PrdDocument.create(
  { prdId: "prd-1", revision: 1, projectId: "p", title: "Cart", content: CONTENT },
  fixedClock,
);

export function refFor(quote: string): PrdSourceRef {
  const startOffset = CONTENT.indexOf(quote);
  if (startOffset < 0) throw new Error(`quote not found: ${quote}`);
  return {
    prdId: prdDocument.prdId,
    revision: prdDocument.revision,
    startOffset,
    endOffset: startOffset + quote.length,
    quotedTextSha256: sha256Hex(quote),
  };
}

const groundedRef = refFor("Cart total equals the sum of item prices.");

/** A counter-based id factory so plan IDs are deterministic across builds. */
export function sequentialIds(prefix = "id"): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

export function validatedProposal(options: { withInput?: boolean } = {}): ValidatedTestPlanProposal {
  const steps = options.withInput
    ? ([
        { kind: "navigate", path: "/cart" },
        {
          kind: "input",
          target: { role: "textbox", name: "Quantity", purpose: "set quantity" },
          valueRef: "qty.default",
        },
        { kind: "verify", claimSemanticKeys: ["cart-total"] },
      ] as const)
    : ([
        { kind: "navigate", path: "/cart" },
        { kind: "click", target: { role: "button", name: "Add to cart", purpose: "add the item" } },
        { kind: "verify", claimSemanticKeys: ["cart-total"] },
      ] as const);

  const proposal = {
    expectedClaims: [
      {
        semanticKey: "cart-total",
        statement: "Cart total equals the sum of item prices.",
        sourceRefs: [groundedRef] as const,
        confidence: 0.9,
      },
    ],
    testCases: [
      {
        title: "Add item and verify total",
        objective: "Ensure the cart total reflects item prices.",
        preconditions: ["A product is available."],
        steps,
        expectedClaimSemanticKeys: ["cart-total"] as const,
        sourceRefs: [groundedRef] as const,
        priority: "high" as const,
      },
    ],
  };

  const result = new TestPlanProposalValidator().validate(prdDocument, proposal);
  if (!result.ok) {
    throw new Error(`fixture proposal should validate: ${result.error.reason}`);
  }
  return result.value;
}
