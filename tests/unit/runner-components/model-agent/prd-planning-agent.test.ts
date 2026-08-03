import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PrdPlanningAgent } from "@qualigence/model-agent";
import type { TargetCapabilitySummary } from "@qualigence/model-agent";
import { ModelGateway } from "@qualigence/model-gateway";
import type {
  StructuredModelInvoker,
  StructuredModelRequest,
} from "@qualigence/model-gateway";
import type {
  ModelProvider,
  ModelProviderRequest,
  StructuredOutputContract,
  ValidatedModelResult,
} from "@qualigence/model-provider";
import { PrdDocument, sha256Hex } from "@qualigence/context-intake";
import type { PrdSourceRef } from "@qualigence/context-intake";
import { TestPlanProposalValidator } from "@qualigence/application-model";
import type { Clock } from "@qualigence/shared-kernel";

const fixedClock: Clock = { now: () => "2026-08-01T00:00:00.000Z" };

const CONTENT = "Cart total equals the sum of item prices. Checkout is enabled.";

const document = PrdDocument.create(
  { prdId: "prd-1", revision: 1, projectId: "p", title: "Cart", content: CONTENT },
  fixedClock,
);

const webTarget: TargetCapabilitySummary = {
  targetId: "target-web",
  supportedStepKinds: ["navigate", "click", "verify"],
  capabilities: ["web.navigate", "web.click", "web.assert"],
};

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

function groundedProposal(): unknown {
  return {
    expectedClaims: [
      {
        semanticKey: "cart-total",
        statement: "Cart total equals the sum of item prices.",
        sourceRefs: [groundedRef],
        confidence: 0.9,
      },
    ],
    testCases: [
      {
        title: "Add item and verify total",
        objective: "Ensure the cart total reflects item prices.",
        preconditions: ["A product is available."],
        steps: [
          { kind: "navigate", path: "/cart" },
          {
            kind: "click",
            target: { role: "button", name: "Add to cart", purpose: "add the item" },
          },
          { kind: "verify", claimSemanticKeys: ["cart-total"] },
        ],
        expectedClaimSemanticKeys: ["cart-total"],
        sourceRefs: [groundedRef],
        priority: "high",
      },
    ],
  };
}

/** A proposal whose claim cites a range that is not present in the PRD text. */
function ungroundedProposal(): unknown {
  const proposal = groundedProposal() as {
    expectedClaims: { sourceRefs: PrdSourceRef[] }[];
  };
  proposal.expectedClaims[0]!.sourceRefs = [
    {
      prdId: document.prdId,
      revision: document.revision,
      startOffset: 0,
      endOffset: 5,
      quotedTextSha256: sha256Hex("WRONG"),
    },
  ];
  return proposal;
}

/** A fake gateway that returns a scripted structured output and records requests. */
class ScriptedGateway implements StructuredModelInvoker {
  readonly requests: StructuredModelRequest[] = [];

  constructor(private readonly output: unknown) {}

  async invokeStructured<T>(
    request: StructuredModelRequest,
    contract: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>> {
    this.requests.push(request);
    return {
      value: contract.parse(this.output),
      model: request.model,
      finishReason: "stop",
    };
  }
}

class ScriptedModelProvider implements ModelProvider {
  readonly capabilities = {
    structuredOutput: true,
    visionInput: false,
    toolCalling: false,
    streaming: false,
  };
  readonly requests: ModelProviderRequest[] = [];

  constructor(private readonly outputs: readonly unknown[]) {}

  async invoke(request: ModelProviderRequest) {
    this.requests.push(request);
    const index = Math.min(this.requests.length - 1, this.outputs.length - 1);
    return {
      output: this.outputs[index],
      model: request.model,
      finishReason: "stop",
    };
  }
}

function modelAgentPackageDependencies(): string[] {
  const packageJsonUrl = new URL(
    "../../../../packages/runner-components/model-agent/package.json",
    import.meta.url,
  );
  const raw = readFileSync(fileURLToPath(packageJsonUrl), "utf8");
  const parsed = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.devDependencies ?? {}),
  ];
}

describe("PrdPlanningAgent", () => {
  it("invokes the planning.prd-test-cases operation and returns a proposal only", async () => {
    const gateway = new ScriptedGateway(groundedProposal());
    const agent = new PrdPlanningAgent(gateway, "test-model");

    const proposal = await agent.propose(document, webTarget);

    expect(gateway.requests[0]?.operation).toBe("planning.prd-test-cases");
    expect(proposal.expectedClaims[0]?.semanticKey).toBe("cart-total");
    expect(proposal.testCases[0]?.steps.length).toBe(3);
    // The agent never allocates identities or validates provenance itself.
    expect(proposal.expectedClaims[0]).not.toHaveProperty("claimId");
    expect(proposal.testCases[0]).not.toHaveProperty("id");
  });

  it("passes PRD identity, revision and target capability to the model", async () => {
    const gateway = new ScriptedGateway(groundedProposal());
    const agent = new PrdPlanningAgent(gateway, "test-model");

    await agent.propose(document, webTarget);

    const userMessage = gateway.requests[0]?.messages.find(
      (message) => message.role === "user",
    );
    const payload = JSON.parse(userMessage?.content ?? "{}") as {
      prdId?: string;
      revision?: number;
      target?: { targetId?: string };
    };
    expect(payload.prdId).toBe(document.prdId);
    expect(payload.revision).toBe(1);
    expect(payload.target?.targetId).toBe("target-web");
  });

  it("re-prompts once and rejects a structurally invalid proposal", async () => {
    const provider = new ScriptedModelProvider([{ notA: "proposal" }, { still: "bad" }]);
    const agent = new PrdPlanningAgent(
      new ModelGateway({ provider }),
      "test-model",
    );

    await expect(agent.propose(document, webTarget)).rejects.toMatchObject({
      code: "InvalidStructuredOutput",
    });
    expect(provider.requests).toHaveLength(2);
  });

  it("emits proposals that the deterministic validator, not the agent, must ground", async () => {
    const validator = new TestPlanProposalValidator();

    const good = await new PrdPlanningAgent(
      new ScriptedGateway(groundedProposal()),
      "test-model",
    ).propose(document, webTarget);
    expect(validator.validate(document, good)).toMatchObject({ ok: true });

    // The agent happily returns a schema-valid but ungrounded proposal; only the
    // deterministic validator rejects the dependency-boundary violation.
    const ungrounded = await new PrdPlanningAgent(
      new ScriptedGateway(ungroundedProposal()),
      "test-model",
    ).propose(document, webTarget);
    expect(validator.validate(document, ungrounded)).toMatchObject({
      ok: false,
      error: { code: "PrdSourceMismatch" },
    });
  });

  it("never depends on any storage or repository package", () => {
    const dependencies = modelAgentPackageDependencies();
    for (const dependency of dependencies) {
      expect(dependency).not.toContain("storage-providers");
      expect(dependency).not.toContain("sqlite");
    }
  });
});
