import { describe, expect, it } from "vitest";
import { ExplorationAgent } from "@qualigence/model-agent";
import type {
  StructuredModelInvoker,
  StructuredModelRequest,
} from "@qualigence/model-gateway";
import type {
  ModelUsage,
  ModelUsageState,
  StructuredOutputContract,
  ValidatedModelResult,
} from "@qualigence/model-provider";
import type { ExplorationContext } from "@qualigence/exploration";
import { observationGraphV1 } from "../../../helpers/observation-graph-v1.js";

function context(): ExplorationContext {
  return {
    runId: "run-1",
    graph: observationGraphV1("graph-1", [
      { id: "node-add", role: "button", name: "Add to cart", confidence: 0.9 },
    ], {
      target: { kind: "web", targetId: "https://shop.example" },
      extensions: {
        "web/v1": {
          type: "web/v1",
          version: "1.0",
          payload: {
            origin: "https://shop.example",
            pathname: "/product",
            title: "Product",
            viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
            query: { ref: "[redacted]" },
          },
        },
      },
    }),
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
    private readonly usage: ModelUsage | undefined = { totalTokens: 42 },
    private readonly usageState?: ModelUsageState,
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
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(this.usageState === undefined ? {} : { usageState: this.usageState }),
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

  it("serializes only v1 core semantics and redacted web/v1 query keys for the prompt", async () => {
    const gateway = new ScriptedGateway(actOutput());
    const agent = new ExplorationAgent(gateway, "test-model");

    await agent.nextAction(context());

    const prompt = gateway.requests[0]?.messages[1]?.content ?? "";
    expect(prompt).toContain("\"schema\":{\"epoch\":\"v1\"");
    expect(prompt).toContain("\"queryKeys\":[\"ref\"]");
    expect(prompt).not.toContain("[redacted]");
    expect(prompt).not.toContain("url");
  });

  it("returns a stop proposal without an action", async () => {
    const gateway = new ScriptedGateway({ status: "stop", reason: "nothing left to explore" });
    const agent = new ExplorationAgent(gateway, "test-model");

    const proposal = await agent.nextAction(context());

    expect(proposal.decision.status).toBe("stop");
    expect(proposal.decision.action).toBeUndefined();
  });

  it("leaves token usage absent when the provider reports usage unavailable", async () => {
    const gateway = new ScriptedGateway(
      actOutput(),
      undefined,
      { status: "unavailable" },
    );
    const agent = new ExplorationAgent(gateway, "test-model");

    const proposal = await agent.nextAction(context());

    expect(proposal.decision.status).toBe("act");
    expect(proposal.tokensUsed).toBeUndefined();
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
