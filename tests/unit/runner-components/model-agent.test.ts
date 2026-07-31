import { describe, expect, it } from "vitest";
import {
  ModelBackedDecisionProvider,
  ModelBackedVerifier,
} from "@qualigence/model-agent";
import type {
  StructuredModelInvoker,
  StructuredModelRequest,
} from "@qualigence/model-gateway";

describe("model-backed runner components", () => {
  it("maps a model decision to a node-only click action", async () => {
    const gateway = new ScriptedGateway([
      { action: { kind: "click", nodeId: "node-add" }, reason: "add the item" },
    ]);
    const provider = new ModelBackedDecisionProvider(gateway, "test-model");

    const decision = await provider.decide({
      job: job(),
      observation: observation("before", [
        { id: "node-add", role: "button", name: "Add to cart", confidence: 1 },
      ]),
    });

    expect(decision).toEqual({
      kind: "click",
      target: { nodeId: "node-add" },
      reason: "add the item",
    });
    expect(decision).not.toHaveProperty("selector");
    expect(gateway.requests[0]?.operation).toBe("execution.decision");
  });

  it("preserves only validated graph/node evidence references in failed verification", async () => {
    const gateway = new ScriptedGateway([
      {
        status: "failed",
        summary: "cart total is wrong",
        severitySuggestion: "high",
        claims: [
          {
            expected: { graphId: "before", nodeId: "node-price", text: "$19" },
            observed: { graphId: "after", nodeId: "node-total", text: "$29" },
          },
        ],
      },
    ]);
    const verifier = new ModelBackedVerifier(gateway, "test-model");

    const result = await verifier.verify({
      job: job(),
      before: observation("before", [
        { id: "node-price", role: "text", text: "$19", confidence: 1 },
      ]),
      after: observation("after", [
        { id: "node-total", role: "text", text: "$29", confidence: 1 },
      ]),
      action: {
        kind: "click",
        target: { nodeId: "node-add", selector: "button" },
        graphId: "before",
      },
      outcome: { status: "ok" },
    });

    expect(result).toEqual({
      status: "failed",
      summary: "cart total is wrong",
      severitySuggestion: "high",
      claims: [
        {
          expected: { graphId: "before", nodeId: "node-price", text: "$19" },
          observed: { graphId: "after", nodeId: "node-total", text: "$29" },
        },
      ],
    });
    expect(gateway.requests[0]?.operation).toBe("execution.verification");
  });
});

function job() {
  return {
    jobId: "job-1",
    runId: "run-1",
    target: { kind: "web" as const, url: "https://example.test" },
    objective: "verify the cart total",
  };
}

function observation(
  graphId: string,
  nodes: readonly {
    readonly id: string;
    readonly role: string;
    readonly name?: string;
    readonly text?: string;
    readonly confidence: number;
  }[],
) {
  return { graphId, nodes };
}

class ScriptedGateway implements StructuredModelInvoker {
  readonly requests: StructuredModelRequest[] = [];

  constructor(private readonly values: unknown[]) {}

  async invokeStructured<T>(request: StructuredModelRequest): Promise<{
    readonly value: T;
    readonly model: string;
    readonly finishReason: string;
  }> {
    this.requests.push(request);
    return {
      value: this.values.shift() as T,
      model: "test-model",
      finishReason: "stop",
    };
  }
}
