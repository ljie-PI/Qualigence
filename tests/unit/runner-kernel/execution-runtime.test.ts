import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeterministicRunnerPolicyGate,
  DeterministicExecutionBudget,
  ExecutionRuntime,
  resolvedActionNodeId,
  toDecisionTracePayload,
  toResolvedActionTracePayload,
  type AnyProposedAction,
  type AnyResolvedAction,
  type RunnerPolicyGate,
} from "@qualigence/runner-kernel";
import {
  AllowAllRunnerPolicyGate,
  InMemoryTraceRecorder,
  ScriptedDecisionProvider,
} from "@qualigence/testkit";

const policy = { policyId: "policy-1", environment: "isolated_test" as const, allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"] as const, maximumRisk: "Normal" as const, explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" };

describe("ExecutionRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("classifies missing finite model usage once before resolution or permit minting", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    let resolverCalls = 0;
    let executorCalls = 0;
    const budget = new DeterministicExecutionBudget();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => ({ graphId: "graph-1", nodes: [] }) },
      decisionProvider: {
        decide: async (context) => {
          context.budget?.consumeModelUsage(context.job.runId, undefined);
          return { kind: "click", target: { nodeId: "node-1" }, reason: "not reached" };
        },
      },
      resolver: {
        resolve: async () => {
          resolverCalls += 1;
          return { kind: "click", target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" };
        },
      },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => { executorCalls += 1; return { status: "ok" }; } },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder,
      budget,
    });

    const completion = await runtime.run(indexedJob());

    expect(completion).toMatchObject({ status: "error", errorCode: "ModelUsageUnavailable" });
    expect(resolverCalls).toBe(0);
    expect(executorCalls).toBe(0);
    expect(traceRecorder.eventsFor("run-indexed").map((event) => event.stage)).toEqual([
      "observation",
      "run_completed",
    ]);
    expect(traceRecorder.eventsFor("run-indexed").at(-1)?.payload).toEqual({
      status: "error",
      errorCode: "ModelUsageUnavailable",
    });
    expect(() => budget.beforeStep("run-indexed", 0)).toThrowError(
      expect.objectContaining({ code: "ExecutionBudgetNotActive" }),
    );
  });

  it("classifies wall-clock exhaustion before permit minting", async () => {
    let now = 0;
    let policyCalls = 0;
    let executorCalls = 0;
    const traceRecorder = new InMemoryTraceRecorder();
    const budget = new DeterministicExecutionBudget({ clock: { now: () => now } });
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => ({ graphId: "graph-1", nodes: [] }) },
      decisionProvider: {
        decide: async () => {
          now = 1_000;
          return { kind: "click", target: { nodeId: "node-1" }, reason: "test" };
        },
      },
      resolver: { resolve: async () => ({ kind: "click", target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" }) },
      policyGate: { authorize: async () => { policyCalls += 1; return { status: "allowed", reason: "allowed" }; } },
      actionExecutor: { execute: async () => { executorCalls += 1; return { status: "ok" }; } },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder,
      budget,
    });

    const completion = await runtime.run(indexedJob());

    expect(completion).toMatchObject({ status: "blocked", errorCode: "WallClockBudgetExceeded" });
    expect(policyCalls).toBe(0);
    expect(executorCalls).toBe(0);
    expect(traceRecorder.eventsFor("run-indexed").at(-1)?.payload).toEqual({
      status: "blocked",
      errorCode: "WallClockBudgetExceeded",
    });
  });

  it("keeps model-budget exhaustion in the approved blocked classification", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => ({ graphId: "graph-1", nodes: [] }) },
      decisionProvider: {
        decide: async (context) => {
          context.budget?.consumeModelUsage(context.job.runId, { totalTokens: 1_001 });
          return { kind: "click", target: { nodeId: "node-1" }, reason: "not reached" };
        },
      },
      resolver: { resolve: async () => { throw new Error("not reached"); } },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder,
    });

    const completion = await runtime.run(indexedJob());

    expect(completion).toEqual({
      jobId: "job-indexed",
      runId: "run-indexed",
      status: "blocked",
      errorCode: "ModelBudgetExceeded",
    });
    expect(traceRecorder.eventsFor("run-indexed").at(-1)?.payload).toEqual({
      status: "blocked",
      errorCode: "ModelBudgetExceeded",
    });
  });

  it.each(["observer", "decision", "resolver", "policy", "action", "verifier"] as const)(
    "bounds a hanging %s call by the remaining wall-clock budget",
    async (hangingStage) => {
      vi.useFakeTimers();
      let now = 0;
      let captureCalls = 0;
      let aborted = false;
      const never = (signal: AbortSignal | undefined) => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      });
      const traceRecorder = new InMemoryTraceRecorder();
      const runtime = new ExecutionRuntime({
        observer: {
          capture: async (_job, signal) => {
            captureCalls += 1;
            if (hangingStage === "observer") {
              return never(signal);
            }
            return { graphId: `graph-${captureCalls}`, nodes: [] };
          },
        },
        decisionProvider: {
          decide: async (context) => hangingStage === "decision"
            ? never(context.signal)
            : { kind: "click", target: { nodeId: "node-1" }, reason: "test" },
        },
        resolver: {
          resolve: async (_decision, _observation, signal) => hangingStage === "resolver"
            ? never(signal)
            : { kind: "click", target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" },
        },
        policyGate: {
          authorize: async (_action, context) => hangingStage === "policy"
            ? never(context.signal)
            : { status: "allowed", reason: "allowed" },
        },
        actionExecutor: {
          execute: async (_action, _permit, signal) => hangingStage === "action"
            ? never(signal)
            : { status: "ok" },
        },
        verifier: {
          verify: async (context) => hangingStage === "verifier"
            ? never(context.signal)
            : { status: "passed", summary: "passed", claims: [] },
        },
        traceRecorder,
        budget: new DeterministicExecutionBudget({ clock: { now: () => now } }),
      });

      const completionPromise = runtime.run(indexedJob());
      await vi.advanceTimersByTimeAsync(0);
      now = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      const completion = await completionPromise;

      expect(completion).toEqual({
        jobId: "job-indexed",
        runId: "run-indexed",
        status: "blocked",
        errorCode: "WallClockBudgetExceeded",
      });
      expect(aborted).toBe(true);
      expect(traceRecorder.eventsFor("run-indexed").at(-1)?.payload).toEqual({
        status: "blocked",
        errorCode: "WallClockBudgetExceeded",
      });
    },
  );

  it.each([
    [
      { kind: "navigate", path: "/checkout", reason: "open checkout" } as AnyProposedAction,
      { targetKind: "web", kind: "navigate", url: "https://example.test/checkout" } as AnyResolvedAction,
    ],
    [
      { kind: "click", target: { nodeId: "button-1" }, reason: "continue" } as AnyProposedAction,
      { targetKind: "web", kind: "click", target: { nodeId: "button-1", selector: "token-1" }, graphId: "graph-1" } as AnyResolvedAction,
    ],
    [
      { kind: "input", target: { nodeId: "email-1" }, valueRef: "customer.email", reason: "enter email" } as AnyProposedAction,
      { targetKind: "web", kind: "input", target: { nodeId: "email-1", selector: "token-2" }, graphId: "graph-1", valueRef: "customer.email" } as AnyResolvedAction,
    ],
    [
      { kind: "select", target: { nodeId: "country-1" }, valueRef: "customer.country", reason: "choose country" } as AnyProposedAction,
      { targetKind: "web", kind: "select", target: { nodeId: "country-1", selector: "token-3" }, graphId: "graph-1", valueRef: "customer.country" } as AnyResolvedAction,
    ],
    [
      { kind: "scroll", target: { nodeId: "summary-1" }, direction: "down", amount: "small", reason: "review summary" } as AnyProposedAction,
      { targetKind: "web", kind: "scroll", target: { nodeId: "summary-1", selector: "token-4" }, graphId: "graph-1", direction: "down", amount: "small" } as AnyResolvedAction,
    ],
  ])("maps a lossless %s decision and Web resolution trace payload", (proposal, resolved) => {
    expect(toDecisionTracePayload(proposal)).toEqual(proposal);
    expect(toResolvedActionTracePayload(resolved)).toEqual(resolved);
  });

  it("records a Desktop window resolution honestly instead of fabricating a click", () => {
    const resolved: AnyResolvedAction = {
      targetKind: "desktop",
      kind: "window",
      actionId: "action-1",
      graphId: "graph-1",
      nodeId: "window-1",
      resolution: "semantic",
      windowOperation: "focus",
    };
    expect(toResolvedActionTracePayload(resolved)).toEqual(resolved);
  });

  it("returns no node id for navigation", () => {
    expect(resolvedActionNodeId({ targetKind: "web", kind: "navigate", url: "https://example.test/checkout" })).toBeUndefined();
  });

  it("preserves the indexed action step through public run and Trace recording", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const observations = [
      { graphId: "graph-before", nodes: [] },
      { graphId: "graph-after", nodes: [] },
    ];
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => observations.shift()! },
      decisionProvider: new ScriptedDecisionProvider({ kind: "click", target: { nodeId: "button-1" }, reason: "execute step zero" }),
      resolver: { resolve: async () => ({ targetKind: "web", kind: "click", target: { nodeId: "button-1", selector: "token-1" }, graphId: "graph-before" }) },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: { verify: async () => ({ status: "passed", summary: "passed", claims: [] }) },
      traceRecorder,
    });

    await runtime.run({
      jobId: "job-indexed",
      runId: "run-indexed",
      projectId: "project-test",
      target: { kind: "web", url: "https://example.test/" },
      objective: "click",
      policy,
      plan: {
        missionId: "mission-1",
        missionRevision: 1,
        testCaseId: "case-1",
        steps: [{ stepIndex: 0, kind: "click", target: { purpose: "continue" } }],
        expectedClaimIds: ["claim-1"],
        budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 1_000 },
      },
    });

    const actionEvents = traceRecorder.eventsFor("run-indexed").filter((event) => event.stage !== "run_completed");
    expect(actionEvents).not.toHaveLength(0);
    expect(actionEvents.every((event) => event.stepIndex === 0)).toBe(true);
  });

  it.each([
    ["action-kind mismatch", { allowedActionKinds: ["navigate"] as const, maximumRisk: "Normal" as const }],
    ["risk above ceiling", { allowedActionKinds: ["window"] as const, maximumRisk: "Normal" as const }],
    ["ProductionForbidden policy", { allowedActionKinds: ["click"] as const, maximumRisk: "ProductionForbidden" as const }],
  ])("does not mint a permit or invoke the executor for %s", async (_name, override) => {
    let executorCalls = 0;
    const traceRecorder = new InMemoryTraceRecorder();
    const action = override.allowedActionKinds[0] === "window"
      ? { targetKind: "desktop" as const, actionId: "close", graphId: "graph-1", nodeId: "node-1", resolution: "semantic" as const, kind: "window" as const, windowOperation: "close" as const }
      : { kind: "click" as const, target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" };
    const policy = { policyId: "policy-1", environment: "isolated_test" as const, allowedOrigins: ["https://example.test"], explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z", ...override };
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => ({ graphId: "graph-1", nodes: [] }) },
      decisionProvider: new ScriptedDecisionProvider({ kind: "click", target: { nodeId: "node-1" }, reason: "test" }),
      resolver: { resolve: async () => action as never },
      policyGate: new DeterministicRunnerPolicyGate(policy),
      actionExecutor: { execute: async () => { executorCalls += 1; return { status: "ok" as const }; } },
      verifier: { verify: async () => ({ status: "passed" as const, summary: "not reached", claims: [] }) },
      traceRecorder,
    });
    const completion = await runtime.run({ jobId: "job-1", runId: "run-1", projectId: "project-test", target: { kind: "web", url: "https://example.test/" }, objective: "test", policy });
    expect(completion).toMatchObject({ status: "blocked", errorCode: "PolicyDenied" });
    expect(executorCalls).toBe(0);
    expect(traceRecorder.eventsFor("run-1").map((event) => event.stage)).not.toContain("policy_authorized");
  });

  it("runs an accepted web job through all M1 stages and records trace in order", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const observations = [
      {
        graphId: "graph-before",
        nodes: [
          {
            id: "node-login",
            role: "button",
            name: "Login",
            confidence: 1,
          },
        ],
      },
      {
        graphId: "graph-after",
        nodes: [
          {
            id: "node-logout",
            role: "button",
            name: "Logout",
            confidence: 1,
          },
        ],
      },
    ];
    const runtime = new ExecutionRuntime({
      observer: {
        capture: async () => observations.shift()!,
      },
      decisionProvider: new ScriptedDecisionProvider({
        kind: "click",
        target: { nodeId: "node-login" },
        reason: "exercise first web action",
      }),
      resolver: {
        resolve: async (action, graph) => ({
          kind: "click",
          target: { nodeId: action.target.nodeId, selector: "text=Login" },
          graphId: graph.graphId,
        }),
      },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: {
        execute: async () => ({ status: "ok" }),
      },
      verifier: {
        verify: async ({ before, after }) => ({
          status: "passed",
          summary: `${before.graphId} -> ${after.graphId}`,
          claims: [],
        }),
      },
      traceRecorder,
    });

    const completion = await runtime.run({
      jobId: "job-1",
      runId: "run-1",
      projectId: "project-test",
      target: { kind: "web", url: "https://example.test" },
      objective: "Click login",
      policy,
    });

    expect(completion.status).toBe("passed");
    expect(completion).not.toHaveProperty("finding");
    expect(traceRecorder.eventsFor("run-1").map((event) => event.stage)).toEqual([
      "observation",
      "decision",
      "action_resolved",
      "policy_authorized",
      "action_executed",
      "observation",
      "verification",
      "run_completed",
    ]);
    expect(traceRecorder.eventsFor("run-1").at(-1)?.payload).toEqual({
      status: "passed",
    });
  });

  it("records a blocked terminal event without a finding when policy denies the action", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const deniedPolicyGate: RunnerPolicyGate = {
      authorize: async () => ({
        status: "denied",
        reason: "click requires approval",
      }),
    };
    let executed = false;

    const runtime = new ExecutionRuntime({
      observer: {
        capture: async () => ({
          graphId: "graph-before",
          nodes: [
            {
              id: "node-danger",
              role: "button",
              name: "Delete",
              confidence: 1,
            },
          ],
        }),
      },
      decisionProvider: new ScriptedDecisionProvider({
        kind: "click",
        target: { nodeId: "node-danger" },
        reason: "exercise denied action",
      }),
      resolver: {
        resolve: async (action, graph) => ({
          kind: "click",
          target: { nodeId: action.target.nodeId, selector: "text=Delete" },
          graphId: graph.graphId,
        }),
      },
      policyGate: deniedPolicyGate,
      actionExecutor: {
        execute: async () => {
          executed = true;
          return { status: "ok" };
        },
      },
      verifier: {
        verify: async () => ({
          status: "passed",
          summary: "not reached",
          claims: [],
        }),
      },
      traceRecorder,
    });

    const completion = await runtime.run({
      jobId: "job-denied",
      runId: "run-denied",
      projectId: "project-test",
      target: { kind: "web", url: "https://example.test" },
      objective: "Click delete",
      policy,
    });

    expect(completion.status).toBe("blocked");
    expect(completion).not.toHaveProperty("finding");
    expect(executed).toBe(false);
    expect(traceRecorder.eventsFor("run-denied").map((event) => event.stage)).toEqual([
      "observation",
      "decision",
      "action_resolved",
      "policy_denied",
      "run_completed",
    ]);
    expect(traceRecorder.eventsFor("run-denied").at(-1)?.payload).toEqual({
      status: "blocked",
      errorCode: "PolicyDenied",
    });
  });

  it("returns a finding completion with grounded evidence when verification fails", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const observations = [
      {
        graphId: "graph-before",
        nodes: [
          {
            id: "node-price",
            role: "text",
            text: "$19",
            confidence: 1,
          },
        ],
      },
      {
        graphId: "graph-after",
        nodes: [
          {
            id: "node-total",
            role: "text",
            text: "$29",
            confidence: 1,
          },
        ],
      },
    ];

    const runtime = new ExecutionRuntime({
      observer: {
        capture: async () => observations.shift()!,
      },
      decisionProvider: new ScriptedDecisionProvider({
        kind: "click",
        target: { nodeId: "node-price" },
        reason: "exercise failed verification",
      }),
      resolver: {
        resolve: async (action, graph) => ({
          kind: "click",
          target: { nodeId: action.target.nodeId, selector: "text=Price" },
          graphId: graph.graphId,
        }),
      },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: {
        execute: async () => ({ status: "ok" }),
      },
      verifier: {
        verify: async () => ({
          status: "failed",
          summary: "cart total differs from the displayed price",
          severitySuggestion: "high",
          claims: [
            {
              expected: {
                graphId: "graph-before",
                nodeId: "node-price",
                text: "$19",
              },
              observed: {
                graphId: "graph-after",
                nodeId: "node-total",
                text: "$29",
              },
            },
          ],
        }),
      },
      traceRecorder,
    });

    const completion = await runtime.run({
      jobId: "job-failed",
      runId: "run-failed",
      projectId: "project-test",
      target: { kind: "web", url: "https://example.test" },
      objective: "Verify cart total",
      policy,
      plan: {
        missionId: "mission-1",
        missionRevision: 1,
        testCaseId: "case-1",
        steps: [{ stepIndex: 0, kind: "click", target: { purpose: "verify cart total" } }],
        expectedClaimIds: ["claim-1"],
        budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 1_000 },
      },
    });

    expect(completion.status).toBe("finding");
    if (completion.status !== "finding") {
      throw new Error("Expected a finding completion.");
    }
    expect(completion.finding).toMatchObject({
      title: "M1 verification failed",
      summary: "cart total differs from the displayed price",
      severity: "high",
      evidenceRefs: ["graph-before:node-price", "graph-after:node-total"],
    });
    expect(traceRecorder.eventsFor("run-failed").map((event) => event.stage)).toEqual([
      "observation",
      "decision",
      "action_resolved",
      "policy_authorized",
      "action_executed",
      "observation",
      "verification",
      "finding",
      "run_completed",
    ]);
    const indexedEvents = traceRecorder.eventsFor("run-failed").filter((event) => event.stage !== "run_completed");
    expect(indexedEvents.every((event) => event.stepIndex === 0)).toBe(true);
  });

  it("blocks immediately when the action executor reports a failed outcome", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    let captureCount = 0;
    let verificationCalled = false;
    const runtime = new ExecutionRuntime({
      observer: {
        capture: async () => {
          captureCount += 1;
          return {
            graphId: "graph-before",
            nodes: [
              {
                id: "node-add",
                role: "button",
                name: "Add to cart",
                confidence: 1,
              },
            ],
          };
        },
      },
      decisionProvider: new ScriptedDecisionProvider({
        kind: "click",
        target: { nodeId: "node-add" },
        reason: "exercise failed action",
      }),
      resolver: {
        resolve: async (action, graph) => ({
          kind: "click",
          target: { nodeId: action.target.nodeId, selector: "text=Add to cart" },
          graphId: graph.graphId,
        }),
      },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: {
        execute: async () => ({ status: "failed", errorCode: "ActionTimedOut" }),
      },
      verifier: {
        verify: async () => {
          verificationCalled = true;
          return { status: "passed", summary: "not reached", claims: [] };
        },
      },
      traceRecorder,
    });

    const completion = await runtime.run({
      jobId: "job-action-failed",
      runId: "run-action-failed",
      projectId: "project-test",
      target: { kind: "web", url: "https://example.test" },
      objective: "Add item to cart",
      policy,
    });

    expect(completion).toEqual({
      jobId: "job-action-failed",
      runId: "run-action-failed",
      status: "blocked",
      errorCode: "ActionTimedOut",
    });
    expect(captureCount).toBe(1);
    expect(verificationCalled).toBe(false);
    expect(traceRecorder.eventsFor("run-action-failed").map((event) => event.stage)).toEqual([
      "observation",
      "decision",
      "action_resolved",
      "policy_authorized",
      "action_executed",
      "run_completed",
    ]);
    expect(traceRecorder.eventsFor("run-action-failed").at(-1)?.payload).toEqual({
      status: "blocked",
      errorCode: "ActionTimedOut",
    });
  });
});

function indexedJob() {
  return {
    jobId: "job-indexed",
    runId: "run-indexed",
    projectId: "project-test",
    target: { kind: "web" as const, url: "https://example.test/" },
    objective: "click",
    policy,
    plan: {
      missionId: "mission-1",
      missionRevision: 1,
      testCaseId: "case-1",
      steps: [{ stepIndex: 0, kind: "click" as const, target: { purpose: "continue" } }] as const,
      expectedClaimIds: ["claim-1"] as [string],
      budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 1_000 },
    },
  };
}
