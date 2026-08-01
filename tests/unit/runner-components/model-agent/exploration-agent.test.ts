import { describe, expect, it } from "vitest";
import { ExplorationAgent } from "@qualigence/model-agent";
import type {
  StructuredModelInvoker,
  StructuredModelRequest,
} from "@qualigence/model-gateway";
import type {
  StructuredOutputContract,
  ValidatedModelResult,
} from "@qualigence/model-provider";
import type { ExplorationContext } from "@qualigence/exploration";

function context(): ExplorationContext {
  return {
    runId: "run-1",
    graph: {
      graphId: "graph-1",
      url: "https://shop.example/product",
      title: "Product",
      nodes: [{ id: "node-add", role: "button", name: "Add to cart", confidence: 0.9 }],
    },
    visitedFingerprints: ["fp-previous"],
    allowedActionKinds: ["navigate", "click", "input"],
    riskCeiling: "RecoverableMutation",
    remainingBudget: {
      remainingSteps: 5,
      remainingWallClockMs: 30_000,
      remainingModelTokens: 4_000,
      remainingStateVisits: 5,
      remainingRecoveries: 2,
    },
  };
}

function actOutput(): unknown {
  return {
    status: "act",
    action: { kind: "click", nodeId: "node-add", reason: "advance the cart" },
    reason: "the add-to-cart button is unexplored",
    expectedNovelty: "reach the cart page",
  };
}

class ScriptedGateway implements StructuredModelInvoker {
  readonly requests: StructuredModelRequest[] = [];

  constructor(
    private readonly output: unknown,
    private readonly usage: { totalTokens?: number } = { totalTokens: 42 },
  ) {}

  async invokeStructured<T>(
    request: StructuredModelRequest,
    contract: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>> {
    this.requests.push(request);
    return {
      value: contract.parse(this.output),
      model: request.model,
      finishReason: "stop",
      usage: this.usage,
    };
  }
}

describe("ExplorationAgent", () => {
  it("invokes exploration.next-action and returns a parsed act proposal with token usage", async () => {
    const gateway = new ScriptedGateway(actOutput());
    const agent = new ExplorationAgent(gateway, "test-model");

    const proposal = await agent.nextAction(context());

    expect(gateway.requests[0]?.operation).toBe("exploration.next-action");
    expect(proposal.decision.status).toBe("act");
    expect(proposal.decision.action?.nodeId).toBe("node-add");
    expect(proposal.tokensUsed).toBe(42);
  });

  it("returns a stop proposal without an action", async () => {
    const gateway = new ScriptedGateway({ status: "stop", reason: "nothing left to explore" });
    const agent = new ExplorationAgent(gateway, "test-model");

    const proposal = await agent.nextAction(context());

    expect(proposal.decision.status).toBe("stop");
    expect(proposal.decision.action).toBeUndefined();
  });

  it("rejects a structurally invalid model output", async () => {
    const gateway = new ScriptedGateway({ status: "act" });
    const agent = new ExplorationAgent(gateway, "test-model");

    await expect(agent.nextAction(context())).rejects.toMatchObject({
      name: "StructuredOutputValidationError",
    });
  });

  it("rejects an unknown action kind in the model output", async () => {
    const gateway = new ScriptedGateway({
      status: "act",
      action: { kind: "teleport", reason: "cheat" },
      reason: "cheat",
    });
    const agent = new ExplorationAgent(gateway, "test-model");

    await expect(agent.nextAction(context())).rejects.toMatchObject({
      name: "StructuredOutputValidationError",
    });
  });
});
