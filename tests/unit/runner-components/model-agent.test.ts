import { describe, expect, it } from "vitest";
import {
  ModelBackedDecisionProvider,
  ModelBackedVerifier,
} from "@qualigence/model-agent";
import { ModelGateway } from "@qualigence/model-gateway";
import { ExecutionRuntime } from "@qualigence/runner-kernel";
import {
  AllowAllRunnerPolicyGate,
  InMemoryTraceRecorder,
  ScriptedDecisionProvider,
} from "@qualigence/testkit";
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

  it("corrects a decision that references a node outside the current observation", async () => {
    const modelProvider = new ScriptedModelProvider([
      { action: { kind: "click", nodeId: "node-unknown" }, reason: "add the item" },
      { action: { kind: "click", nodeId: "node-add" }, reason: "add the item" },
    ]);
    const provider = new ModelBackedDecisionProvider(
      new ModelGateway({ provider: modelProvider }),
      "test-model",
    );

    const decision = await provider.decide({
      job: job(),
      observation: observation("before", [
        { id: "node-add", role: "button", name: "Add to cart", confidence: 1 },
      ]),
    });

    expect(decision.target.nodeId).toBe("node-add");
    expect(modelProvider.requests).toHaveLength(2);
    expect(modelProvider.requests[1]?.messages.at(-1)?.content).toContain(
      "action.nodeId:unknown_node_reference",
    );
    expect(modelProvider.requests[1]?.messages.at(-1)?.content).not.toContain(
      "node-unknown",
    );
  });

  it("blocks before resolution when the corrected decision still references an unknown node", async () => {
    const modelProvider = new ScriptedModelProvider([
      { action: { kind: "click", nodeId: "node-unknown-1" }, reason: "missing node" },
      { action: { kind: "click", nodeId: "node-unknown-2" }, reason: "still missing node" },
    ]);
    const traceRecorder = new InMemoryTraceRecorder();
    let resolverCalled = false;
    let actionExecutorCalled = false;
    let verifierCalled = false;
    const runtime = new ExecutionRuntime({
      observer: {
        capture: async () => observation("before", [
          { id: "node-add", role: "button", name: "Add", confidence: 1 },
        ]),
      },
      decisionProvider: new ModelBackedDecisionProvider(
        new ModelGateway({ provider: modelProvider }),
        "test-model",
      ),
      resolver: {
        resolve: async (action, graph) => {
          resolverCalled = true;
          return {
            kind: "click",
            target: { nodeId: action.target.nodeId, selector: "button" },
            graphId: graph.graphId,
          };
        },
      },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: {
        execute: async () => {
          actionExecutorCalled = true;
          return { status: "ok" };
        },
      },
      verifier: {
        verify: async () => {
          verifierCalled = true;
          return { status: "passed", summary: "not reached", claims: [] };
        },
      },
      traceRecorder,
    });

    const completion = await runtime.run(job());

    expect(completion).toEqual({
      jobId: "job-1",
      runId: "run-1",
      status: "blocked",
      errorCode: "InvalidStructuredOutput",
    });
    expect(modelProvider.requests).toHaveLength(2);
    expect(resolverCalled).toBe(false);
    expect(actionExecutorCalled).toBe(false);
    expect(verifierCalled).toBe(false);
    expect(traceRecorder.eventsFor("run-1").map((event) => event.stage)).toEqual([
      "observation",
      "run_completed",
    ]);
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
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain(
      "claims[0].expected:unknown_evidence_reference",
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
      name: "ExecutionBlockedError",
      errorCode: "InvalidStructuredOutput",
    });
    expect(provider.requests).toHaveLength(2);
  });

  it("blocks the run after one correction when verification keeps citing invalid evidence", async () => {
    const invalid = failedVerification({
      expected: { graphId: "before", nodeId: "invented", text: "$19" },
      observed: { graphId: "after", nodeId: "node-total", text: "$29" },
    });
    const modelProvider = new ScriptedModelProvider([invalid, invalid]);
    const traceRecorder = new InMemoryTraceRecorder();
    const observations = [verificationContext().before, verificationContext().after];
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => observations.shift()! },
      decisionProvider: new ScriptedDecisionProvider({
        kind: "click",
        target: { nodeId: "node-price" },
        reason: "verify the cart total",
      }),
      resolver: {
        resolve: async (action, graph) => ({
          kind: "click",
          target: { nodeId: action.target.nodeId, selector: "button" },
          graphId: graph.graphId,
        }),
      },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: new ModelBackedVerifier(
        new ModelGateway({ provider: modelProvider }),
        "test-model",
      ),
      traceRecorder,
    });

    const completion = await runtime.run(job());

    expect(completion).toEqual({
      jobId: "job-1",
      runId: "run-1",
      status: "blocked",
      errorCode: "InvalidStructuredOutput",
    });
    expect(modelProvider.requests).toHaveLength(2);
    expect(traceRecorder.eventsFor("run-1").map((event) => event.stage)).toEqual([
      "observation",
      "decision",
      "action_resolved",
      "policy_authorized",
      "action_executed",
      "observation",
      "run_completed",
    ]);
    expect(traceRecorder.eventsFor("run-1").at(-1)?.payload).toEqual({
      status: "blocked",
      errorCode: "InvalidStructuredOutput",
    });
  });

  it("rejects whitespace-only evidence instead of grounding it to an empty node", async () => {
    const emptyEvidence = failedVerification({
      expected: { graphId: "before", nodeId: "node-empty", text: "   " },
      observed: { graphId: "after", nodeId: "node-total", text: "$29" },
    });
    const provider = new ScriptedModelProvider([emptyEvidence, emptyEvidence]);
    const verifier = new ModelBackedVerifier(
      new ModelGateway({ provider }),
      "test-model",
    );

    await expect(
      verifier.verify({
        ...verificationContext(),
        before: observation("before", [
          { id: "node-empty", role: "generic", confidence: 1 },
        ]),
      }),
    ).rejects.toMatchObject({
      name: "ExecutionBlockedError",
      errorCode: "InvalidStructuredOutput",
    });
    expect(provider.requests).toHaveLength(2);
  });
});

function job() {
  return {
    jobId: "job-1",
    runId: "run-1",
    projectId: "project-test",
    target: { kind: "web" as const, url: "https://example.test" },
    objective: "verify the cart total",
    policy: { policyId: "policy-1", environment: "isolated_test" as const, allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"] as const, maximumRisk: "Normal" as const, explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
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
