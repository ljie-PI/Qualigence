import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelBackedDecisionProvider,
  ModelBackedVerifier,
} from "@qualigence/model-agent";
import { ModelGateway } from "@qualigence/model-gateway";
import {
  DeterministicExecutionBudget,
  ExecutionBudgetError,
  ExecutionRuntime,
} from "@qualigence/runner-kernel";
import type { ExecutionBudget, ModelUsage } from "@qualigence/runner-kernel";
import {
  AllowAllRunnerPolicyGate,
  InMemoryTraceRecorder,
  ScriptedDecisionProvider,
} from "@qualigence/testkit";
import type {
  ModelInvocationReport,
  ModelProvider,
  StructuredModelInvoker,
  StructuredModelRequest,
} from "@qualigence/model-gateway";
import type { ModelProviderRequest } from "@qualigence/model-provider";
import type { ObservationGraphV1 } from "@qualigence/runner-protocol";
import { observationGraphV1, type ObservationGraphV1TestNode } from "../../helpers/observation-graph-v1.js";

describe("model-backed runner components", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the remaining output ceiling and accounts decision usage", async () => {
    const gateway = new UsageGateway({ inputTokens: 4, outputTokens: 3, totalTokens: 7 });
    const budget = activeBudget();
    const provider = new ModelBackedDecisionProvider(gateway, "test-model");

    await provider.decide({
      job: job(),
      observation: observation("before", [
        { id: "node-add", role: "button", name: "Add", confidence: 1 },
      ]),
      budget,
    });

    expect(gateway.requests[0]?.maximumOutputTokens).toBe(100);
    expect(budget.maximumOutputTokens("run-1")).toBe(93);
  });

  it("passes the remaining output ceiling and accounts verification usage", async () => {
    const gateway = new UsageGateway(
      { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
      { status: "passed", summary: "verified", claims: [] },
    );
    const budget = activeBudget();
    const verifier = new ModelBackedVerifier(gateway, "test-model");

    await verifier.verify({ ...verificationContext(), budget });

    expect(gateway.requests[0]?.maximumOutputTokens).toBe(100);
    expect(budget.maximumOutputTokens("run-1")).toBe(90);
  });

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

  it("serializes a validated v1 prompt view without raw query values or secret node values", async () => {
    const gateway = new ScriptedGateway([
      { action: { kind: "click", nodeId: "node-add" }, reason: "add the item" },
    ]);
    const provider = new ModelBackedDecisionProvider(gateway, "test-model");

    await provider.decide({
      job: job(),
      observation: observation("before", [
        { id: "node-add", role: "button", name: "Add to cart", confidence: 1 },
        { id: "node-secret", role: "textbox", value: "****", sensitivity: "secret", confidence: 1 },
      ], {
        extensions: {
          "web/v1": {
            type: "web/v1",
            version: "1.0",
            payload: {
              origin: "https://example.test",
              pathname: "/checkout",
              title: "Checkout",
              viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
              query: { token: "[redacted]" },
            },
          },
        },
      }),
    });

    const prompt = gateway.requests[0]?.messages[1]?.content ?? "";
    expect(prompt).toContain("\"schema\":{\"epoch\":\"v1\"");
    expect(prompt).toContain("\"web\":{\"origin\":\"https://example.test\",\"pathname\":\"/checkout\"");
    expect(prompt).toContain("\"queryKeys\":[\"token\"]");
    expect(prompt).not.toContain("[redacted]");
    expect(prompt).not.toContain("****");
    expect(prompt).not.toContain("extensions");
  });

  it("retains the legacy click proposal for a single immutable click Plan step", async () => {
    const step = { stepIndex: 0, kind: "click" as const, target: { purpose: "add" } };
    const provider = new ModelBackedDecisionProvider(
      new ScriptedGateway([{ nodeId: "node-add", reason: "add" }]),
      "test-model",
    );

    await expect(provider.decide({
      job: {
        ...job(),
        plan: { missionId: "mission-1", missionRevision: 1, testCaseId: "case-1", steps: [step], expectedClaimIds: ["claim-1"], budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 100 } },
      },
      observation: observation("before", [{ id: "node-add", role: "button", confidence: 1 }]),
      step,
      stepIndex: 0,
    })).resolves.toEqual({ kind: "click", target: { nodeId: "node-add" }, reason: "add" });
  });

  it.each([
    ["input", "profile.email"],
    ["select", "profile.country"],
  ] as const)("copies the immutable Plan valueRef into a %s proposal", async (kind, valueRef) => {
    const step = {
      stepIndex: 0,
      kind,
      target: { role: kind === "input" ? "textbox" : "combobox", purpose: `exercise ${kind}` },
      valueRef,
    } as const;
    const plannedJob = {
      ...job(),
      policy: { ...job().policy, allowedActionKinds: [kind] },
      plan: {
        missionId: "mission-1",
        missionRevision: 1,
        testCaseId: `case-${kind}`,
        steps: [step],
        expectedClaimIds: ["claim-1"],
        budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 100 },
      },
    } as const;
    const gateway = new ScriptedGateway([
      { nodeId: `node-${kind}`, reason: `perform ${kind}` },
    ]);
    const provider = new ModelBackedDecisionProvider(gateway, "test-model");

    const decision = await provider.decide({
      job: plannedJob,
      observation: observation("before", [
        { id: `node-${kind}`, role: step.target.role, name: kind, confidence: 1 },
      ]),
      step,
      stepIndex: 0,
    });

    expect(decision).toEqual({
      kind,
      target: { nodeId: `node-${kind}` },
      valueRef,
      reason: `perform ${kind}`,
    });
    expect(gateway.requests[0]?.messages[1]?.content).toContain(valueRef);
  });

  it.each([
    [
      { stepIndex: 0, kind: "navigate", path: "/checkout" } as const,
      { reason: "open checkout" },
      { kind: "navigate", path: "/checkout", reason: "open checkout" },
    ],
    [
      { stepIndex: 0, kind: "click", target: { purpose: "continue" } } as const,
      { nodeId: "node-current", reason: "continue" },
      { kind: "click", target: { nodeId: "node-current" }, reason: "continue" },
    ],
    [
      { stepIndex: 0, kind: "scroll", target: { purpose: "summary" }, direction: "down", amount: "page" } as const,
      { nodeId: "node-current", reason: "review summary" },
      { kind: "scroll", target: { nodeId: "node-current" }, direction: "down", amount: "page", reason: "review summary" },
    ],
    [
      { stepIndex: 0, kind: "scroll", direction: "up", amount: "small" } as const,
      { reason: "return upward" },
      { kind: "scroll", direction: "up", amount: "small", reason: "return upward" },
    ],
  ])("derives the %s action only from the current immutable Plan step", async (step, output, expected) => {
    const plannedJob = {
      ...job(),
      plan: {
        missionId: "mission-1",
        missionRevision: 1,
        testCaseId: "case-current-step",
        steps: [step],
        expectedClaimIds: ["claim-1"],
        budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 100 },
      },
    } as const;
    const gateway = new ScriptedGateway([output]);
    const provider = new ModelBackedDecisionProvider(gateway, "test-model");

    await expect(provider.decide({
      job: plannedJob,
      observation: observation("before", [
        { id: "node-current", role: "button", confidence: 1 },
      ]),
      step,
      stepIndex: step.stepIndex,
    })).resolves.toEqual(expected);
  });

  it("rejects a supplied step that does not match the immutable Job Plan", async () => {
    const jobStep = { stepIndex: 0, kind: "input" as const, target: { purpose: "email" }, valueRef: "profile.email" };
    const provider = new ModelBackedDecisionProvider(
      new ScriptedGateway([{ nodeId: "node-input", reason: "input" }]),
      "test-model",
    );
    const suppliedStep = { ...jobStep, valueRef: "model-chosen-value" };

    await expect(provider.decide({
      job: {
        ...job(),
        plan: { missionId: "mission-1", missionRevision: 1, testCaseId: "case-1", steps: [jobStep], expectedClaimIds: ["claim-1"], budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 100 } },
      },
      observation: observation("before", [{ id: "node-input", role: "textbox", confidence: 1 }]),
      step: suppliedStep,
      stepIndex: 0,
    })).rejects.toMatchObject({ errorCode: "PlanExecutionUnsupported" });
  });

  it("rejects a model-supplied valueRef and copies the Plan-owned ref after correction", async () => {
    const step = { stepIndex: 0, kind: "input" as const, target: { purpose: "email" }, valueRef: "profile.email" };
    const modelProvider = new ScriptedModelProvider([
      { nodeId: "node-input", reason: "input", valueRef: "model-chosen-value" },
      { nodeId: "node-input", reason: "input" },
    ]);
    const provider = new ModelBackedDecisionProvider(
      new ModelGateway({ provider: modelProvider }),
      "test-model",
    );

    await expect(provider.decide({
      job: {
        ...job(),
        plan: { missionId: "mission-1", missionRevision: 1, testCaseId: "case-1", steps: [step], expectedClaimIds: ["claim-1"], budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 100 } },
      },
      observation: observation("before", [{ id: "node-input", role: "textbox", confidence: 1 }]),
      step,
      stepIndex: 0,
    })).resolves.toEqual({
      kind: "input",
      target: { nodeId: "node-input" },
      valueRef: "profile.email",
      reason: "input",
    });
    expect(modelProvider.requests).toHaveLength(2);
    expect(modelProvider.requests[1]?.messages.at(-1)?.content).toContain("output:unrecognized_keys");
    expect(modelProvider.requests[1]?.messages.at(-1)?.content).not.toContain("model-chosen-value");
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
      objectiveOnlyMaximumWallClockMs: 1_000,
      objectiveOnlyMaximumModelTokens: 100,
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

  it("accounts both invalid structured responses before blocking", async () => {
    const modelProvider = new ScriptedModelProvider([
      { action: { kind: "click", nodeId: "unknown-1" }, reason: "missing" },
      { action: { kind: "click", nodeId: "unknown-2" }, reason: "missing" },
    ]);
    const budget = activeBudget();
    const provider = new ModelBackedDecisionProvider(
      new ModelGateway({ provider: modelProvider }),
      "test-model",
    );

    await expect(provider.decide({
      job: job(),
      observation: observation("before", []),
      budget,
    })).rejects.toMatchObject({ errorCode: "InvalidStructuredOutput" });

    expect(budget.maximumOutputTokens("run-1")).toBe(96);
  });

  it("classifies absent usage from exhausted correction as unavailable", async () => {
    const provider = new ModelBackedDecisionProvider(
      new ModelGateway({ provider: new NoUsageModelProvider([
        { action: { kind: "click", nodeId: "unknown-1" }, reason: "missing" },
        { action: { kind: "click", nodeId: "unknown-2" }, reason: "missing" },
      ]) }),
      "test-model",
    );

    await expect(provider.decide({
      job: job(),
      observation: observation("before", []),
      budget: activeBudget(),
    })).rejects.toMatchObject({ code: "ModelUsageUnavailable" });
  });

  it("classifies missing usage from a failed retry attempt as unavailable after success", async () => {
    const modelProvider = new RetryModelProvider();
    const provider = new ModelBackedDecisionProvider(
      new ModelGateway({ provider: modelProvider, delay: async () => {} }),
      "test-model",
    );

    await expect(provider.decide({
      job: job(),
      observation: observation("before", [
        { id: "node-add", role: "button", name: "Add", confidence: 1 },
      ]),
      budget: activeBudget(),
    })).rejects.toMatchObject({ code: "ModelUsageUnavailable" });
    expect(modelProvider.requests).toHaveLength(2);
  });

  it("charges failed retry and correction attempts exactly once", async () => {
    const modelProvider = new UsageRetryCorrectionProvider();
    const budget = activeBudget();
    const provider = new ModelBackedDecisionProvider(
      new ModelGateway({ provider: modelProvider, delay: async () => {} }),
      "test-model",
    );

    await provider.decide({
      job: job(),
      observation: observation("before", [
        { id: "node-add", role: "button", name: "Add", confidence: 1 },
      ]),
      budget,
    });

    expect(modelProvider.requests).toHaveLength(3);
    expect(budget.maximumOutputTokens("run-1")).toBe(91);
  });

  it("charges successful usage once when invocation reporting rejects", async () => {
    const auditError = new Error("audit unavailable");
    const budget = new RecordingBudget();
    const reports: ModelInvocationReport[] = [];
    const provider = new ModelBackedDecisionProvider(
      new ModelGateway({
        provider: new ScriptedModelProvider([
          { action: { kind: "click", nodeId: "node-add" }, reason: "add" },
        ]),
        invocationObserver: {
          record: async (report) => {
            reports.push(report);
            throw auditError;
          },
        },
      }),
      "test-model",
    );

    await expect(provider.decide({
      job: job(),
      observation: observation("before", [
        { id: "node-add", role: "button", name: "Add", confidence: 1 },
      ]),
      budget,
    })).rejects.toBe(auditError);

    expect(budget.usages).toEqual([{ inputTokens: 1, outputTokens: 1, totalTokens: 2 }]);
    expect(reports.map((report) => report.status)).toEqual(["succeeded"]);
  });

  it("bounds hanging invocation reporting by the run deadline without late duplicate reporting", async () => {
    vi.useFakeTimers();
    let now = 0;
    const reports: ModelInvocationReport[] = [];
    let rejectLate: ((error: Error) => void) | undefined;
    let markReportStarted: (() => void) | undefined;
    const reportStarted = new Promise<void>((resolve) => { markReportStarted = resolve; });
    const budget = new RecordingBudget(() => now);
    const traceRecorder = new InMemoryTraceRecorder();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => observation("before", [
        { id: "node-add", role: "button", name: "Add", confidence: 1 },
      ]) },
      decisionProvider: new ModelBackedDecisionProvider(
        new ModelGateway({
          provider: new ScriptedModelProvider([
            { action: { kind: "click", nodeId: "node-add" }, reason: "add" },
          ]),
          invocationObserver: {
            record: async (report) => {
              reports.push(report);
              markReportStarted?.();
              return new Promise<never>((_resolve, reject) => { rejectLate = reject; });
            },
          },
        }),
        "test-model",
      ),
      resolver: { resolve: async () => { throw new Error("not reached"); } },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder,
      budget,
    });
    const completionPromise = runtime.run(job());
    await reportStarted;

    now = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runOnlyPendingTimersAsync();
    const completion = await completionPromise;

    expect(completion).toMatchObject({
      status: "blocked",
      errorCode: "WallClockBudgetExceeded",
    });
    expect(budget.usages).toEqual([{ inputTokens: 1, outputTokens: 1, totalTokens: 2 }]);
    expect(reports.map((report) => report.status)).toEqual(["succeeded"]);

    rejectLate?.(new Error("late audit rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(reports.map((report) => report.status)).toEqual(["succeeded"]);
  });

  it("charges known failed usage once and preserves the model failure when reporting rejects", async () => {
    const budget = new RecordingBudget();
    const reports: ModelInvocationReport[] = [];
    const provider = new ModelBackedDecisionProvider(
      new ModelGateway({
        provider: new FailedUsageModelProvider(),
        invocationObserver: {
          record: async (report) => {
            reports.push(report);
            throw new Error("audit unavailable");
          },
        },
      }),
      "test-model",
    );

    await expect(provider.decide({
      job: job(),
      observation: observation("before", [
        { id: "node-add", role: "button", name: "Add", confidence: 1 },
      ]),
      budget,
    })).rejects.toMatchObject({ code: "AuthenticationFailed" });

    expect(budget.usages).toEqual([{ totalTokens: 3 }]);
    expect(reports.map((report) => report.status)).toEqual(["failed"]);
  });

  it("charges accumulated abort usage exactly once before propagating the abort reason", async () => {
    const controller = new AbortController();
    const modelProvider = new AbortCorrectionModelProvider({ totalTokens: 3 });
    const budget = new RecordingBudget();
    const provider = new ModelBackedDecisionProvider(
      new ModelGateway({ provider: modelProvider }),
      "test-model",
    );
    const decision = provider.decide({
      job: job(),
      observation: observation("before", [
        { id: "node-add", role: "button", name: "Add", confidence: 1 },
      ]),
      budget,
      signal: controller.signal,
    });
    await modelProvider.correctionStarted;

    const reason = new ExecutionBudgetError("WallClockBudgetExceeded");
    controller.abort(reason);

    await expect(decision).rejects.toBe(reason);

    expect(budget.usages).toEqual([{ totalTokens: 7 }]);
  });

  it("preserves unavailable-usage classification after charging prior abort usage once", async () => {
    const controller = new AbortController();
    const modelProvider = new AbortCorrectionModelProvider();
    const budget = new RecordingBudget();
    const provider = new ModelBackedDecisionProvider(
      new ModelGateway({ provider: modelProvider }),
      "test-model",
    );
    const decision = provider.decide({
      job: job(),
      observation: observation("before", [
        { id: "node-add", role: "button", name: "Add", confidence: 1 },
      ]),
      budget,
      signal: controller.signal,
    });
    await modelProvider.correctionStarted;

    controller.abort(new ExecutionBudgetError("WallClockBudgetExceeded"));

    await expect(decision).rejects.toMatchObject({ code: "ModelUsageUnavailable" });

    expect(budget.usages).toEqual([{ totalTokens: 4 }]);
  });

  it("charges abort usage before Runtime propagates wall timeout classification", async () => {
    vi.useFakeTimers();
    let now = 0;
    const modelProvider = new AbortCorrectionModelProvider({ totalTokens: 3 });
    const budget = new RecordingBudget(() => now);
    const traceRecorder = new InMemoryTraceRecorder();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => observation("before", [
        { id: "node-add", role: "button", name: "Add", confidence: 1 },
      ]) },
      decisionProvider: new ModelBackedDecisionProvider(
        new ModelGateway({ provider: modelProvider }),
        "test-model",
      ),
      resolver: { resolve: async () => { throw new Error("not reached"); } },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder,
      budget,
    });
    const completionPromise = runtime.run(job());
    await modelProvider.correctionStarted;

    now = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    const completion = await completionPromise;

    expect(completion).toMatchObject({
      status: "blocked",
      errorCode: "WallClockBudgetExceeded",
    });
    expect(budget.usages).toEqual([{ totalTokens: 7 }]);
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
      objectiveOnlyMaximumWallClockMs: 1_000,
      objectiveOnlyMaximumModelTokens: 100,
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
  nodes: readonly ObservationGraphV1TestNode[],
  overrides: Partial<ObservationGraphV1> = {},
) {
  return observationGraphV1(graphId, nodes, overrides);
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

function activeBudget() {
  const budget = new DeterministicExecutionBudget();
  budget.begin({
    ...job(),
    plan: {
      missionId: "mission-1",
      missionRevision: 1,
      testCaseId: "case-1",
      steps: [{ stepIndex: 0, kind: "click" as const, target: { purpose: "test" } }],
      expectedClaimIds: ["claim-1"],
      budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 100 },
    },
  });
  return budget;
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

class UsageGateway implements StructuredModelInvoker {
  readonly requests: StructuredModelRequest[] = [];

  constructor(
    private readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number },
    private readonly value: unknown = { action: { kind: "click", nodeId: "node-add" }, reason: "add" },
  ) {}

  async invokeStructured<T>(request: StructuredModelRequest): Promise<{
    readonly value: T;
    readonly model: string;
    readonly finishReason: string;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };
  }> {
    this.requests.push(request);
    return {
      value: this.value as T,
      model: "test-model",
      finishReason: "stop",
      usage: this.usage,
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
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}

class NoUsageModelProvider implements ModelProvider {
  readonly capabilities = {
    structuredOutput: true,
    visionInput: false,
    toolCalling: false,
    streaming: false,
  } as const;

  constructor(private readonly outputs: unknown[]) {}

  async invoke(request: ModelProviderRequest) {
    return {
      output: this.outputs.shift(),
      model: request.model,
      finishReason: "stop",
    };
  }
}

class RetryModelProvider implements ModelProvider {
  readonly capabilities = {
    structuredOutput: true,
    visionInput: false,
    toolCalling: false,
    streaming: false,
  } as const;
  readonly requests: ModelProviderRequest[] = [];

  async invoke(request: ModelProviderRequest) {
    this.requests.push(request);
    if (this.requests.length === 1) {
      throw { code: "TimedOut", message: "timed out" };
    }
    return {
      output: { action: { kind: "click", nodeId: "node-add" }, reason: "add" },
      model: request.model,
      finishReason: "stop",
      usage: { totalTokens: 2 },
    };
  }
}

class UsageRetryCorrectionProvider implements ModelProvider {
  readonly capabilities = {
    structuredOutput: true,
    visionInput: false,
    toolCalling: false,
    streaming: false,
  } as const;
  readonly requests: ModelProviderRequest[] = [];

  async invoke(request: ModelProviderRequest) {
    this.requests.push(request);
    if (this.requests.length === 1) {
      throw { code: "TimedOut", message: "timed out", usage: { totalTokens: 2 } };
    }
    return {
      output: this.requests.length === 2
        ? { malformed: true }
        : { action: { kind: "click", nodeId: "node-add" }, reason: "add" },
      model: request.model,
      finishReason: "stop",
      usage: { totalTokens: this.requests.length === 2 ? 3 : 4 },
    };
  }
}

class FailedUsageModelProvider implements ModelProvider {
  readonly capabilities = {
    structuredOutput: true,
    visionInput: false,
    toolCalling: false,
    streaming: false,
  } as const;

  async invoke(): Promise<never> {
    throw {
      code: "AuthenticationFailed",
      message: "authentication failed",
      usage: { totalTokens: 3 },
    };
  }
}

class AbortCorrectionModelProvider implements ModelProvider {
  readonly capabilities = {
    structuredOutput: true,
    visionInput: false,
    toolCalling: false,
    streaming: false,
  } as const;
  readonly correctionStarted: Promise<void>;
  private attempts = 0;
  private markCorrectionStarted: (() => void) | undefined;

  constructor(private readonly abortUsage?: ModelUsage) {
    this.correctionStarted = new Promise((resolve) => {
      this.markCorrectionStarted = resolve;
    });
  }

  async invoke(request: ModelProviderRequest) {
    this.attempts += 1;
    if (this.attempts === 1) {
      return {
        output: { malformed: true },
        model: request.model,
        finishReason: "stop",
        usage: { totalTokens: 4 },
      };
    }

    this.markCorrectionStarted?.();
    return new Promise<never>((_resolve, reject) => {
      if (this.abortUsage === undefined) return;
      request.signal?.addEventListener("abort", () => {
        reject({
          code: "TimedOut",
          message: "aborted",
          usage: this.abortUsage,
        });
      }, { once: true });
    });
  }
}

class RecordingBudget implements ExecutionBudget {
  readonly usages: ModelUsage[] = [];

  constructor(private readonly now: () => number = () => 0) {}

  begin(): void {}
  beforeStep(): void {}
  remainingWallClockMs(): number {
    const remaining = 1_000 - this.now();
    if (remaining <= 0) throw new ExecutionBudgetError("WallClockBudgetExceeded");
    return remaining;
  }
  maximumOutputTokens(): number { return 100; }
  consumeModelUsage(_runId: string, usage: ModelUsage | undefined): void {
    if (usage === undefined) throw new ExecutionBudgetError("ModelUsageUnavailable");
    this.usages.push(usage);
  }
  finish(): void {}
}
