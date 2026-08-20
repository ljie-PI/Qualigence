import { describe, expect, it } from "vitest";
import {
  ModelGateway,
  ModelGatewayError,
  type ModelProvider,
  type StructuredOutputContract,
} from "@qualigence/model-gateway";
import type { JsonSchema, ModelProviderRequest } from "@qualigence/model-provider";

const decisionContract: StructuredOutputContract<{
  readonly action: { readonly kind: "click"; readonly nodeId: string };
  readonly reason: string;
}> = {
  name: "execution-decision",
  jsonSchema: { type: "object" },
  parse(value) {
    const candidate = value as {
      action?: { kind?: string; nodeId?: string };
      reason?: string;
    };
    if (
      candidate.action?.kind !== "click" ||
      typeof candidate.action.nodeId !== "string" ||
      typeof candidate.reason !== "string"
    ) {
      throw Object.assign(new Error("raw provider output must not be repeated"), {
        name: "StructuredOutputValidationError",
        issues: [{ path: "action.nodeId", reason: "invalid_type" }],
      });
    }

    return {
      action: { kind: "click", nodeId: candidate.action.nodeId },
      reason: candidate.reason,
    };
  },
};

describe("ModelGateway", () => {
  it("rejects providers without structured-output capability before invoking them", async () => {
    const provider = fakeProvider({ structuredOutput: false });
    const gateway = new ModelGateway({ provider });

    await expect(
      gateway.invokeStructured(request(), decisionContract),
    ).rejects.toMatchObject({ code: "CapabilityMismatch" } satisfies Partial<ModelGatewayError>);
    expect(provider.requests).toHaveLength(0);
  });

  it("retries once when structured output does not match the local contract", async () => {
    const provider = fakeProvider(
      { structuredOutput: true },
      [{ malformed: true }, { action: { kind: "click", nodeId: "add" }, reason: "add item" }],
    );
    const gateway = new ModelGateway({ provider });

    const result = await gateway.invokeStructured(request(), decisionContract);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "choose a button" },
      {
        role: "user",
        content:
          "The previous response failed schema validation for execution-decision. Validation issues: action.nodeId:invalid_type. Return only JSON that matches the supplied schema.",
      },
    ]);
    expect(provider.requests[1]?.messages.at(-1)?.content).not.toContain(
      "raw provider output",
    );
    expect(result.value).toEqual({
      action: { kind: "click", nodeId: "add" },
      reason: "add item",
    });
  });

  it("forwards the output limit and preserves usage from the single correction", async () => {
    const provider = fakeProvider(
      { structuredOutput: true },
      [
        { output: { malformed: true }, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
        { output: { action: { kind: "click", nodeId: "add" }, reason: "add item" }, usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } },
      ],
    );
    const gateway = new ModelGateway({ provider });

    const result = await gateway.invokeStructured(
      { ...request(), maximumOutputTokens: 17 },
      decisionContract,
    );

    expect(provider.requests.map((providerRequest) => providerRequest.maximumOutputTokens)).toEqual([17, 17]);
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 5, totalTokens: 18 });
  });

  it("preserves the complete consumed total when correction usage fields differ", async () => {
    const provider = fakeProvider(
      { structuredOutput: true },
      [
        { output: { malformed: true }, usage: { totalTokens: 7 } },
        { output: { action: { kind: "click", nodeId: "add" }, reason: "add item" }, usage: { inputTokens: 8, outputTokens: 3 } },
      ],
    );

    const result = await new ModelGateway({ provider }).invokeStructured(request(), decisionContract);

    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 3, totalTokens: 18 });
  });

  it("returns aggregate usage on exhausted structured-output correction", async () => {
    const provider = fakeProvider(
      { structuredOutput: true },
      [
        { output: { malformed: true }, usage: { totalTokens: 7 } },
        { output: { stillMalformed: true }, usage: { totalTokens: 11 } },
      ],
    );

    await expect(
      new ModelGateway({ provider }).invokeStructured(request(), decisionContract),
    ).rejects.toMatchObject({
      code: "InvalidStructuredOutput",
      usage: { totalTokens: 18 },
    });
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid output limit %s before invoking the provider",
    async (maximumOutputTokens) => {
      const provider = fakeProvider({ structuredOutput: true });
      const gateway = new ModelGateway({ provider });

      await expect(
        gateway.invokeStructured(
          { ...request(), maximumOutputTokens },
          decisionContract,
        ),
      ).rejects.toMatchObject({ code: "InvalidRequest" });
      expect(provider.requests).toHaveLength(0);
    },
  );

  it("propagates a non-validation parser defect without retrying the provider", async () => {
    const parserDefect = new TypeError("contract bug");
    const provider = fakeProvider(
      { structuredOutput: true },
      [{ action: { kind: "click", nodeId: "add" }, reason: "add item" }],
    );
    const gateway = new ModelGateway({ provider });
    const defectiveContract: StructuredOutputContract<never> = {
      name: "defective-contract",
      jsonSchema: { type: "object" },
      parse() {
        throw parserDefect;
      },
    };

    await expect(gateway.invokeStructured(request(), defectiveContract)).rejects.toBe(parserDefect);
    expect(provider.requests).toHaveLength(1);
  });

  it("propagates a provider-request construction defect without invoking or retrying", async () => {
    const requestConstructionDefect = new TypeError("schema getter bug");
    const provider = fakeProvider({ structuredOutput: true });
    const gateway = new ModelGateway({ provider });
    const defectiveContract: StructuredOutputContract<never> = {
      name: "defective-contract",
      get jsonSchema(): JsonSchema {
        throw requestConstructionDefect;
      },
      parse() {
        throw new Error("parse must not run");
      },
    };

    await expect(gateway.invokeStructured(request(), defectiveContract)).rejects.toBe(
      requestConstructionDefect,
    );
    expect(provider.requests).toHaveLength(0);
  });

  it("does not retry an authentication failure", async () => {
    const provider = fakeProvider(
      { structuredOutput: true },
      [new Error("unauthorized")],
      "AuthenticationFailed",
    );
    const gateway = new ModelGateway({ provider });

    await expect(
      gateway.invokeStructured(request(), decisionContract),
    ).rejects.toMatchObject({ code: "AuthenticationFailed" } satisfies Partial<ModelGatewayError>);
    expect(provider.requests).toHaveLength(1);
  });

  it("does not retry a permanent invalid provider request", async () => {
    const provider = fakeProvider(
      { structuredOutput: true },
      [new Error("unsupported response format")],
      "InvalidRequest",
    );
    const gateway = new ModelGateway({ provider });

    await expect(
      gateway.invokeStructured(request(), decisionContract),
    ).rejects.toMatchObject({ code: "InvalidRequest" } satisfies Partial<ModelGatewayError>);
    expect(provider.requests).toHaveLength(1);
  });

  it("normalizes a timeout after exactly one transient retry", async () => {
    const provider = fakeProvider(
      { structuredOutput: true },
      [new Error("timed out"), new Error("timed out")],
      "TimedOut",
    );
    const delays: number[] = [];
    const gateway = new ModelGateway({
      provider,
      delay: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(
      gateway.invokeStructured(request(), decisionContract),
    ).rejects.toMatchObject({ code: "TimedOut" } satisfies Partial<ModelGatewayError>);
    expect(provider.requests).toHaveLength(2);
    expect(delays).toEqual([100]);
  });
});

function request() {
  return {
    operation: "execution.decision" as const,
    model: "test-model",
    messages: [{ role: "user" as const, content: "choose a button" }],
    timeoutMs: 1_000,
  };
}

function fakeProvider(
  capabilities: Pick<ModelProvider["capabilities"], "structuredOutput">,
  responses: unknown[] = [],
  errorCode?: "AuthenticationFailed" | "InvalidRequest" | "TimedOut",
) {
  const requests: ModelProviderRequest[] = [];
  const provider: ModelProvider & { readonly requests: ModelProviderRequest[] } = {
    capabilities: {
      structuredOutput: capabilities.structuredOutput,
      visionInput: false,
      toolCalling: false,
      streaming: false,
    },
    requests,
    async invoke(providerRequest) {
      requests.push(providerRequest);
      const response = responses.shift();
      if (response instanceof Error) {
        throw {
          code: errorCode,
          message: response.message,
        };
      }

      const scripted = isScriptedResponse(response) ? response : { output: response };
      return {
        output: scripted.output,
        model: providerRequest.model,
        finishReason: "stop",
        ...(scripted.usage === undefined ? {} : { usage: scripted.usage }),
      };
    },
  };

  return provider;
}

function isScriptedResponse(value: unknown): value is {
  readonly output: unknown;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number };
} {
  return typeof value === "object" && value !== null && "output" in value;
}
