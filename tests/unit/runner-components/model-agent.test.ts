import { describe, expect, it } from "vitest";
import {
  ModelBackedDecisionProvider,
  ModelBackedVerifier,
} from "@qualigence/model-agent";
import { ModelGateway } from "@qualigence/model-gateway";
import type {
  ModelProvider,
  StructuredModelInvoker,
  StructuredModelRequest,
} from "@qualigence/model-gateway";
import type { ModelProviderRequest } from "@qualigence/model-provider";

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

  it("uses the gateway correction retry when the first verification cites invented evidence", async () => {
    const provider = new ScriptedModelProvider([
      failedVerification({
        expected: { graphId: "before", nodeId: "invented", text: "$19" },
        observed: { graphId: "after", nodeId: "node-total", text: "$29" },
      }),
      failedVerification({
        expected: { graphId: "before", nodeId: "node-price", text: "$19" },
        observed: { graphId: "after", nodeId: "node-total", text: "$29" },
      }),
    ]);
    const verifier = new ModelBackedVerifier(
      new ModelGateway({ provider }),
      "test-model",
    );

    const result = await verifier.verify(verificationContext());

    expect(result.status).toBe("failed");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain(
      "failed schema validation",
    );
  });

  it("rejects claims whose expected and observed evidence use the wrong observation stages", async () => {
    const reversed = failedVerification({
      expected: { graphId: "after", nodeId: "node-total", text: "$29" },
      observed: { graphId: "before", nodeId: "node-price", text: "$19" },
    });
    const provider = new ScriptedModelProvider([reversed, reversed]);
    const verifier = new ModelBackedVerifier(
      new ModelGateway({ provider }),
      "test-model",
    );

    await expect(verifier.verify(verificationContext())).rejects.toMatchObject({
      code: "InvalidStructuredOutput",
    });
    expect(provider.requests).toHaveLength(2);
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

function verificationContext() {
  return {
    job: job(),
    before: observation("before", [
      { id: "node-price", role: "text", text: "$19", confidence: 1 },
    ]),
    after: observation("after", [
      { id: "node-total", role: "text", text: "$29", confidence: 1 },
    ]),
    action: {
      kind: "click" as const,
      target: { nodeId: "node-add", selector: "button" },
      graphId: "before",
    },
    outcome: { status: "ok" as const },
  };
}

function failedVerification(claim: {
  readonly expected: { readonly graphId: string; readonly nodeId: string; readonly text: string };
  readonly observed: { readonly graphId: string; readonly nodeId: string; readonly text: string };
}) {
  return {
    status: "failed" as const,
    summary: "cart total is wrong",
    severitySuggestion: "high" as const,
    claims: [claim],
  };
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

class ScriptedModelProvider implements ModelProvider {
  readonly capabilities = {
    structuredOutput: true,
    visionInput: false,
    toolCalling: false,
    streaming: false,
  } as const;
  readonly requests: ModelProviderRequest[] = [];

  constructor(private readonly outputs: unknown[]) {}

  async invoke(request: ModelProviderRequest) {
    this.requests.push(request);
    return {
      output: this.outputs.shift(),
      model: request.model,
      finishReason: "stop",
    };
  }
}
