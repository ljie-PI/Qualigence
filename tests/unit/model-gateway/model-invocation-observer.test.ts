import { describe, expect, it } from "vitest";
import {
  ModelGateway,
  type ModelInvocationObserver,
  type ModelInvocationReport,
  type ModelProvider,
  type StructuredOutputContract,
} from "@qualigence/model-gateway";
import type { ModelInvocationStore } from "@qualigence/evidence";
import { PersistedModelInvocationObserver } from "@qualigence/execution-application";

const decisionContract: StructuredOutputContract<{ readonly nodeId: string }> = {
  name: "execution-decision",
  jsonSchema: { type: "object" },
  parse(value) {
    const candidate = value as { nodeId?: unknown };
    if (typeof candidate.nodeId !== "string") {
      throw Object.assign(new Error("invalid"), {
        name: "StructuredOutputValidationError",
        issues: [{ path: "nodeId", reason: "invalid_type" }],
      });
    }
    return { nodeId: candidate.nodeId };
  },
};

function collectingObserver(): {
  readonly observer: ModelInvocationObserver;
  readonly reports: ModelInvocationReport[];
} {
  const reports: ModelInvocationReport[] = [];
  return {
    reports,
    observer: {
      async record(report) {
        reports.push(report);
      },
    },
  };
}

function request() {
  return {
    operation: "execution.decision" as const,
    model: "test-model",
    messages: [{ role: "user" as const, content: "secret-prompt" }],
    timeoutMs: 1_000,
    invocation: { runId: "run-1", invocationId: "inv-1" },
  };
}

describe("ModelGateway invocation reporting", () => {
  it("emits exactly one succeeded report for a successful invocation", async () => {
    const { observer, reports } = collectingObserver();
    const provider: ModelProvider = {
      capabilities: {
        structuredOutput: true,
        visionInput: false,
        toolCalling: false,
        streaming: false,
      },
      async invoke(providerRequest) {
        return {
          output: { nodeId: "add" },
          model: providerRequest.model,
          providerRequestId: "prov-1",
          finishReason: "stop",
          usage: { inputTokens: 11, outputTokens: 5 },
        };
      },
    };
    const gateway = new ModelGateway({ provider, invocationObserver: observer });

    await gateway.invokeStructured(request(), decisionContract);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      context: { runId: "run-1", invocationId: "inv-1" },
      operation: "execution.decision",
      status: "succeeded",
      model: "test-model",
      providerRequestId: "prov-1",
      inputTokens: 11,
      outputTokens: 5,
    });
    expect(JSON.stringify(reports[0])).not.toContain("secret-prompt");
  });

  it("emits exactly one failed report after transient retries are exhausted", async () => {
    const { observer, reports } = collectingObserver();
    let attempts = 0;
    const provider: ModelProvider = {
      capabilities: {
        structuredOutput: true,
        visionInput: false,
        toolCalling: false,
        streaming: false,
      },
      async invoke() {
        attempts += 1;
        throw { code: "TimedOut", message: "timed out" };
      },
    };
    const gateway = new ModelGateway({
      provider,
      invocationObserver: observer,
      delay: async () => undefined,
    });

    await expect(
      gateway.invokeStructured(request(), decisionContract),
    ).rejects.toMatchObject({ code: "TimedOut" });

    expect(attempts).toBe(2);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "failed",
      errorCode: "TimedOut",
      context: { invocationId: "inv-1" },
    });
  });

  it("emits no report when the request carries no invocation context", async () => {
    const { observer, reports } = collectingObserver();
    const provider: ModelProvider = {
      capabilities: {
        structuredOutput: true,
        visionInput: false,
        toolCalling: false,
        streaming: false,
      },
      async invoke(providerRequest) {
        return {
          output: { nodeId: "add" },
          model: providerRequest.model,
          finishReason: "stop",
        };
      },
    };
    const gateway = new ModelGateway({ provider, invocationObserver: observer });

    await gateway.invokeStructured(
      {
        operation: "execution.decision",
        model: "test-model",
        messages: [{ role: "user", content: "x" }],
        timeoutMs: 1_000,
      },
      decisionContract,
    );

    expect(reports).toHaveLength(0);
  });
});

describe("PersistedModelInvocationObserver", () => {
  it("maps a report to one summary without raw messages or output", async () => {
    const appended: Parameters<ModelInvocationStore["append"]>[0][] = [];
    const store: ModelInvocationStore = {
      async append(summary) {
        appended.push(summary);
      },
      async listForRun() {
        return appended;
      },
    };
    const observer = new PersistedModelInvocationObserver(store);

    await observer.record({
      context: { runId: "run-1", invocationId: "inv-1" },
      operation: "execution.verification",
      model: "test-model",
      status: "succeeded",
      latencyMs: 42,
      inputTokens: 7,
      outputTokens: 3,
      providerRequestId: "prov-1",
      occurredAt: "2026-08-01T00:00:00.000Z",
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]).toEqual({
      invocationId: "inv-1",
      runId: "run-1",
      operation: "execution.verification",
      model: "test-model",
      status: "succeeded",
      latencyMs: 42,
      inputTokens: 7,
      outputTokens: 3,
      providerRequestId: "prov-1",
      occurredAt: "2026-08-01T00:00:00.000Z",
    });
  });
});
