import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeterministicRunnerPolicyGate,
  DeterministicExecutionBudget,
  ExecutionBudgetError,
  ExecutionTargetError,
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
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_TYPE,
  type ObservationGraphV1,
  type ObservationNodeV1,
} from "@qualigence/runner-protocol";

const policy = { policyId: "policy-1", environment: "isolated_test" as const, allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"] as const, maximumRisk: "Normal" as const, explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" };
const objectiveOnlyBudget = {
  objectiveOnlyMaximumWallClockMs: 1_000,
  objectiveOnlyMaximumModelTokens: 1_000,
} as const;

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
      observer: { capture: async () => graph("graph-1") },
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

  it("does not append a terminal when budget admission fails before execution starts", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => { throw new Error("not reached"); } },
      decisionProvider: new ScriptedDecisionProvider({ kind: "click", target: { nodeId: "node-1" }, reason: "not reached" }),
      resolver: { resolve: async () => { throw new Error("not reached"); } },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder,
    });
    const job = indexedJob();
    job.plan.budget.maximumWallClockMs = 0;

    await expect(runtime.run(job)).rejects.toMatchObject({ code: "ExecutionBudgetInvalid" });
    expect(traceRecorder.eventsFor(job.runId)).toEqual([]);
  });

  it("classifies wall-clock exhaustion before permit minting", async () => {
    let now = 0;
    let policyCalls = 0;
    let executorCalls = 0;
    const traceRecorder = new InMemoryTraceRecorder();
    const budget = new DeterministicExecutionBudget({ clock: { now: () => now } });
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-1") },
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

  it("keeps wall-clock exhaustion at the final pre-dispatch check blocked", async () => {
    let remainingChecks = 0;
    let executorCalls = 0;
    const traceRecorder = new InMemoryTraceRecorder();
    const budget = {
      begin: () => undefined,
      beforeStep: () => undefined,
      remainingWallClockMs: () => {
        remainingChecks += 1;
        if (remainingChecks === 9) {
          throw new ExecutionBudgetError("WallClockBudgetExceeded");
        }
        return 1_000;
      },
      maximumOutputTokens: () => 100,
      consumeModelUsage: () => undefined,
      finish: () => undefined,
    };
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-1") },
      decisionProvider: new ScriptedDecisionProvider({ kind: "click", target: { nodeId: "node-1" }, reason: "test" }),
      resolver: { resolve: async () => ({ kind: "click", target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" }) },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => { executorCalls += 1; return { status: "ok" }; } },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder,
      budget,
    });

    await expect(runtime.run(indexedJob())).resolves.toMatchObject({
      status: "blocked",
      errorCode: "WallClockBudgetExceeded",
    });
    expect(executorCalls).toBe(0);
    expect(traceRecorder.eventsFor("run-indexed").filter((event) => event.stage === "run_completed")).toHaveLength(1);
  });

  it("keeps model-budget exhaustion in the approved blocked classification", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-1") },
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
            return graph(`graph-${captureCalls}`);
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
          execute: async (_action, permit, signal) => {
            if (hangingStage === "action") {
              permit.assertAuthorizedForDispatch(signal);
              return never(signal);
            }
            return { status: "ok" };
          },
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
        status: hangingStage === "action" ? "error" : "blocked",
        errorCode: hangingStage === "action"
          ? "ActionOutcomeUnknown"
          : "WallClockBudgetExceeded",
      });
      expect(aborted).toBe(true);
      expect(traceRecorder.eventsFor("run-indexed").filter((event) => event.stage === "run_completed")).toHaveLength(1);
      expect(traceRecorder.eventsFor("run-indexed").at(-1)?.payload).toMatchObject({
        status: hangingStage === "action" ? "error" : "blocked",
        errorCode: hangingStage === "action"
          ? "ActionOutcomeUnknown"
          : "WallClockBudgetExceeded",
      });
      if (hangingStage === "action") {
        expect(traceRecorder.eventsFor("run-indexed").map((event) => event.stage)).toEqual([
          "observation",
          "decision",
          "action_resolved",
          "policy_authorized",
          "run_completed",
        ]);
      }
    },
  );

  it("bounds Trace appends by the run deadline and observes a late rejection", async () => {
    vi.useFakeTimers();
    let now = 0;
    let rejectLate: ((error: Error) => void) | undefined;
    const appended: unknown[] = [];
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-1") },
      decisionProvider: new ScriptedDecisionProvider({
        kind: "click",
        target: { nodeId: "node-1" },
        reason: "test",
      }),
      resolver: { resolve: async () => { throw new Error("not reached"); } },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder: {
        append: async (event) => {
          appended.push(event);
          if (appended.length > 1) return {} as never;
          return new Promise<never>((_resolve, reject) => { rejectLate = reject; });
        },
      },
      budget: new DeterministicExecutionBudget({
        clock: { now: () => now },
        objectiveOnlyMaximumWallClockMs: 100,
        objectiveOnlyMaximumModelTokens: 10,
      }),
    });

    const completionPromise = runtime.run({
      jobId: "job-objective",
      runId: "run-objective",
      projectId: "project-test",
      target: { kind: "web", url: "https://example.test/" },
      objective: "click",
      policy,
    });
    for (let attempt = 0; attempt < 10 && rejectLate === undefined; attempt += 1) {
      await Promise.resolve();
    }
    expect(rejectLate).toBeDefined();
    now = 100;
    await vi.advanceTimersByTimeAsync(100);
    await vi.runOnlyPendingTimersAsync();

    await expect(completionPromise).resolves.toMatchObject({
      status: "blocked",
      errorCode: "WallClockBudgetExceeded",
    });
    expect(appended).toHaveLength(2);
    expect(appended.at(-1)).toMatchObject({
      stage: "run_completed",
      payload: { status: "blocked", errorCode: "WallClockBudgetExceeded" },
    });
    rejectLate?.(new Error("late Trace rejection"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it.each([
    ["StaleObservation", "blocked"],
    ["UnknownObservationNode", "blocked"],
    ["TargetNotFound", "blocked"],
    ["AmbiguousTarget", "blocked"],
    ["OriginViolation", "blocked"],
    ["ActionTimedOut", "blocked"],
    ["TargetNotVisible", "blocked"],
    ["TargetDisabled", "blocked"],
    ["ActionValueUnavailable", "blocked"],
    ["UnsupportedAction", "blocked"],
    ["BrowserLaunchFailed", "error"],
    ["NavigationFailed", "error"],
    ["NavigationTimedOut", "error"],
    ["ConcurrentSessionOperation", "error"],
    ["SessionClosed", "error"],
    ["ActionInfrastructureFailure", "error"],
  ] as const)("maps expected target error %s to a terminal %s completion", async (errorCode, status) => {
    const traceRecorder = new InMemoryTraceRecorder();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-1") },
      decisionProvider: new ScriptedDecisionProvider({
        kind: "click",
        target: { nodeId: "node-1" },
        reason: "test",
      }),
      resolver: {
        resolve: async () => {
          throw new ExecutionTargetError(errorCode, status);
        },
      },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder,
      ...objectiveOnlyBudget,
    });

    await expect(runtime.run(objectiveJob())).resolves.toMatchObject({ status, errorCode });
    expect(traceRecorder.eventsFor("run-objective").filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(traceRecorder.eventsFor("run-objective").at(-1)?.payload).toEqual({ status, errorCode });
  });

  it("reports terminal recorder failure as a distinct disposition without a duplicate append", async () => {
    let terminalAppends = 0;
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-1") },
      decisionProvider: new ScriptedDecisionProvider({
        kind: "click",
        target: { nodeId: "node-1" },
        reason: "test",
      }),
      resolver: { resolve: async () => ({ kind: "click", target: { nodeId: "node-1", selector: "button" }, graphId: "graph-1" }) },
      policyGate: { authorize: async () => ({ status: "denied", reason: "test" }) },
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder: {
        append: async (event) => {
          if (event.stage === "run_completed") {
            terminalAppends += 1;
            throw new Error("spool unavailable");
          }
          return {} as never;
        },
      },
      ...objectiveOnlyBudget,
    });

    await expect(runtime.run(objectiveJob())).rejects.toMatchObject({
      code: "TerminalTracePersistenceFailed",
      disposition: "terminal_persistence_failed",
    });
    expect(terminalAppends).toBe(1);
  });

  it("bounds a hanging terminal recorder independently from an expired execution budget", async () => {
    vi.useFakeTimers();
    let now = 0;
    let terminalAppends = 0;
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-1") },
      decisionProvider: {
        decide: async () => {
          now = 1_000;
          return { kind: "click", target: { nodeId: "node-1" }, reason: "test" };
        },
      },
      resolver: { resolve: async () => { throw new Error("not reached"); } },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: { verify: async () => ({ status: "passed", summary: "not reached", claims: [] }) },
      traceRecorder: {
        append: async (event) => {
          if (event.stage === "run_completed") {
            terminalAppends += 1;
            return new Promise<never>(() => undefined);
          }
          return {} as never;
        },
      },
      budget: new DeterministicExecutionBudget({ clock: { now: () => now } }),
      terminalRecordingTimeoutMs: 25,
    });

    const completion = runtime.run(indexedJob());
    const completionExpectation = expect(completion).rejects.toMatchObject({
      code: "TerminalTracePersistenceFailed",
      disposition: "terminal_persistence_failed",
    });
    await vi.advanceTimersByTimeAsync(25);

    await completionExpectation;
    expect(terminalAppends).toBe(1);
  });

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
      graph("graph-before"),
      graph("graph-after"),
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

  it("executes every immutable plan step sequentially with fresh grounding and indexed Trace", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const calls: string[] = [];
    const decisionSteps: unknown[] = [];
    const verifiedClaimIds: readonly string[][] = [];
    let observationOrdinal = 0;
    const budget = new DeterministicExecutionBudget();
    const beforeStep = vi.spyOn(budget, "beforeStep");
    const runtime = new ExecutionRuntime({
      observer: {
        capture: async () => {
          observationOrdinal += 1;
          calls.push(`observe:${observationOrdinal}`);
          return graph(`graph-${observationOrdinal}`, [
            { id: `node-${observationOrdinal}`, role: "button", name: `Step ${observationOrdinal}`, confidence: 1 },
          ]);
        },
      },
      decisionProvider: {
        decide: async (context) => {
          const step = context.step!;
          decisionSteps.push(step);
          calls.push(`decide:${context.stepIndex}:${step.kind}`);
          if (step.kind === "navigate") return { kind: "navigate", path: step.path, reason: "approved path" };
          if (step.kind === "input" || step.kind === "select") {
            return { kind: step.kind, target: { nodeId: context.observation.nodes[0]!.id }, valueRef: step.valueRef, reason: "ground field" };
          }
          if (step.kind === "scroll") {
            return { kind: "scroll", target: { nodeId: context.observation.nodes[0]!.id }, direction: step.direction, amount: step.amount, reason: "ground region" };
          }
          if (step.kind === "click") {
            return { kind: "click", target: { nodeId: context.observation.nodes[0]!.id }, reason: "ground control" };
          }
          throw new Error("verify must not call the decision provider");
        },
      },
      resolver: {
        resolve: async (proposal, graph) => {
          const action = proposal as AnyProposedAction;
          calls.push(`resolve:${action.kind}:${graph.graphId}`);
          if (action.kind === "navigate") {
            return { targetKind: "web", kind: "navigate", url: `https://example.test${action.path}` };
          }
          const target = action.target === undefined
            ? undefined
            : { nodeId: action.target.nodeId, selector: `${graph.graphId}:${action.target.nodeId}` };
          if (action.kind === "input" || action.kind === "select") {
            return { targetKind: "web", kind: action.kind, target: target!, graphId: graph.graphId, valueRef: action.valueRef };
          }
          if (action.kind === "scroll") {
            return { targetKind: "web", kind: "scroll", ...(target === undefined ? {} : { target }), graphId: graph.graphId, direction: action.direction, amount: action.amount };
          }
          return { targetKind: "web", kind: "click", target: target!, graphId: graph.graphId };
        },
      },
      policyGate: {
        authorize: async (action) => {
          calls.push(`policy:${action.kind}`);
          return { status: "allowed", reason: "approved" };
        },
      },
      actionExecutor: {
        execute: async (action) => {
          calls.push(`execute:${action.kind}`);
          return { status: "ok" };
        },
      },
      verifier: {
        verify: async (context) => {
          (verifiedClaimIds as string[][]).push([...(context.claimIds ?? [])]);
          calls.push(`verify:${context.after.graphId}`);
          return { status: "passed", summary: "claims passed", claims: [] };
        },
      },
      traceRecorder,
      budget,
    });
    const plan = {
      missionId: "mission-19",
      missionRevision: 3,
      testCaseId: "case-multi-step",
      steps: [
        { stepIndex: 0, kind: "navigate", path: "/form" },
        { stepIndex: 1, kind: "input", target: { role: "textbox", purpose: "enter email" }, valueRef: "profile.email" },
        { stepIndex: 2, kind: "select", target: { role: "combobox", purpose: "choose country" }, valueRef: "profile.country" },
        { stepIndex: 3, kind: "click", target: { role: "button", purpose: "submit" } },
        { stepIndex: 4, kind: "scroll", target: { purpose: "review result" }, direction: "down", amount: "page" },
        { stepIndex: 5, kind: "verify", claimIds: ["claim-result"] },
      ],
      expectedClaimIds: ["claim-result"],
      budget: { maximumStepsPerJob: 6, maximumWallClockMs: 10_000, maximumModelTokens: 1_000 },
    } as const;
    const job = {
      jobId: "job-multi-step",
      runId: "run-multi-step",
      projectId: "project-test",
      target: { kind: "web" as const, url: "https://example.test/" },
      objective: "complete the form",
      policy: {
        ...policy,
        allowedActionKinds: ["navigate", "input", "select", "click", "scroll"] as const,
        maximumRisk: "ExternalSideEffect" as const,
      },
      plan,
    };

    await expect(runtime.run(job)).resolves.toEqual({
      jobId: "job-multi-step",
      runId: "run-multi-step",
      status: "passed",
    });

    expect(decisionSteps).toEqual(plan.steps.slice(0, 5));
    expect(verifiedClaimIds).toEqual([["claim-result"]]);
    expect(beforeStep.mock.calls).toEqual(plan.steps.map((step) => ["run-multi-step", step.stepIndex]));
    expect(calls).toEqual([
      "observe:1", "decide:0:navigate", "resolve:navigate:graph-1", "policy:navigate", "execute:navigate",
      "observe:2", "decide:1:input", "resolve:input:graph-2", "policy:input", "execute:input",
      "observe:3", "decide:2:select", "resolve:select:graph-3", "policy:select", "execute:select",
      "observe:4", "decide:3:click", "resolve:click:graph-4", "policy:click", "execute:click",
      "observe:5", "decide:4:scroll", "resolve:scroll:graph-5", "policy:scroll", "execute:scroll",
      "observe:6", "verify:graph-6",
    ]);
    const trace = traceRecorder.eventsFor("run-multi-step");
    expect(trace.filter((event) => event.stage === "decision")).toHaveLength(5);
    expect(trace.filter((event) => event.stage === "verification")).toHaveLength(1);
    expect(trace.map((event) => event.stepIndex)).toEqual([
      0, 0, 0, 0, 0,
      1, 1, 1, 1, 1,
      2, 2, 2, 2, 2,
      3, 3, 3, 3, 3,
      4, 4, 4, 4, 4,
      5, 5, 5,
    ]);
    expect(trace.at(-1)).toMatchObject({ stage: "run_completed", stepIndex: 5, payload: { status: "passed" } });
  });

  it("runs one final verification with expected claims when the Plan has no verify step", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const verificationContexts: unknown[] = [];
    let captures = 0;
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph(`graph-${++captures}`, [{ id: "node-1", role: "button", confidence: 1 }]) },
      decisionProvider: { decide: async () => ({ kind: "click", target: { nodeId: "node-1" }, reason: "continue" }) },
      resolver: { resolve: async (_action, graph) => ({ targetKind: "web", kind: "click", target: { nodeId: "node-1", selector: "token" }, graphId: graph.graphId }) },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "ok" }) },
      verifier: { verify: async (context) => { verificationContexts.push(context); return { status: "passed", summary: "passed", claims: [] }; } },
      traceRecorder,
    });
    const job = twoClickPlanJob({
      steps: [{ stepIndex: 0, kind: "click", target: { purpose: "continue" } }],
      maximumStepsPerJob: 1,
    });

    await expect(runtime.run(job)).resolves.toMatchObject({ status: "passed" });

    expect(verificationContexts).toHaveLength(1);
    expect(verificationContexts[0]).toMatchObject({ claimIds: ["claim-final"], stepIndex: 0 });
    expect(captures).toBe(2);
    expect(traceRecorder.eventsFor(job.runId).at(-1)).toMatchObject({ stage: "run_completed", stepIndex: 0 });
  });

  it.each([
    ["denial", "PolicyDenied"],
    ["timeout", "ActionTimedOut"],
  ] as const)("stops later Plan steps after an intermediate %s", async (failure, errorCode) => {
    const traceRecorder = new InMemoryTraceRecorder();
    let decisionCalls = 0;
    let executorCalls = 0;
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-current", [{ id: "node-1", role: "button", confidence: 1 }]) },
      decisionProvider: { decide: async () => { decisionCalls += 1; return { kind: "click", target: { nodeId: "node-1" }, reason: "continue" }; } },
      resolver: { resolve: async (_action, graph) => ({ targetKind: "web", kind: "click", target: { nodeId: "node-1", selector: "token" }, graphId: graph.graphId }) },
      policyGate: {
        authorize: async () => failure === "denial"
          ? { status: "denied", reason: "denied" }
          : { status: "allowed", reason: "allowed" },
      },
      actionExecutor: { execute: async () => { executorCalls += 1; return { status: "failed", errorCode: "ActionTimedOut" }; } },
      verifier: { verify: async () => { throw new Error("later verification must not run"); } },
      traceRecorder,
    });
    const job = twoClickPlanJob();

    await expect(runtime.run(job)).resolves.toMatchObject({ status: "blocked", errorCode });

    expect(decisionCalls).toBe(1);
    expect(executorCalls).toBe(failure === "denial" ? 0 : 1);
    const trace = traceRecorder.eventsFor(job.runId);
    expect(trace.filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(trace.at(-1)).toMatchObject({ stepIndex: 0, payload: { status: "blocked", errorCode } });
  });

  it("classifies an unknown action outcome as error and never retries or starts a later step", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    let decisions = 0;
    let attempts = 0;
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-current", [{ id: "node-1", role: "button", confidence: 1 }]) },
      decisionProvider: { decide: async () => { decisions += 1; return { kind: "click", target: { nodeId: "node-1" }, reason: "continue" }; } },
      resolver: { resolve: async (_action, graph) => ({ targetKind: "web", kind: "click", target: { nodeId: "node-1", selector: "token" }, graphId: graph.graphId }) },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async (_action, permit, signal) => { attempts += 1; permit.assertAuthorizedForDispatch(signal); throw new Error("connection lost after dispatch"); } },
      verifier: { verify: async () => { throw new Error("verification must not run"); } },
      traceRecorder,
    });
    const job = twoClickPlanJob();

    await expect(runtime.run(job)).resolves.toEqual({
      jobId: job.jobId,
      runId: job.runId,
      status: "error",
      errorCode: "ActionOutcomeUnknown",
    });

    expect(decisions).toBe(1);
    expect(attempts).toBe(1);
    expect(traceRecorder.eventsFor(job.runId).filter((event) => event.stage === "run_completed")).toHaveLength(1);
    expect(traceRecorder.eventsFor(job.runId).at(-1)).toMatchObject({
      stepIndex: 0,
      payload: { status: "error", errorCode: "ActionOutcomeUnknown" },
    });
  });

  it.each([
    [
      "navigate",
      { kind: "navigate", path: "/next", reason: "navigate" },
      { targetKind: "web", kind: "navigate", url: "https://example.test/next" },
      { stepIndex: 0, kind: "navigate", path: "/next" },
    ],
    [
      "click",
      { kind: "click", target: { nodeId: "node-1" }, reason: "click" },
      { targetKind: "web", kind: "click", target: { nodeId: "node-1", selector: "token" }, graphId: "graph-current" },
      { stepIndex: 0, kind: "click", target: { purpose: "click" } },
    ],
    [
      "input",
      { kind: "input", target: { nodeId: "node-1" }, valueRef: "value.input", reason: "input" },
      { targetKind: "web", kind: "input", target: { nodeId: "node-1", selector: "token" }, graphId: "graph-current", valueRef: "value.input" },
      { stepIndex: 0, kind: "input", target: { purpose: "input" }, valueRef: "value.input" },
    ],
    [
      "select",
      { kind: "select", target: { nodeId: "node-1" }, valueRef: "value.select", reason: "select" },
      { targetKind: "web", kind: "select", target: { nodeId: "node-1", selector: "token" }, graphId: "graph-current", valueRef: "value.select" },
      { stepIndex: 0, kind: "select", target: { purpose: "select" }, valueRef: "value.select" },
    ],
    [
      "scroll",
      { kind: "scroll", target: { nodeId: "node-1" }, direction: "down", amount: "small", reason: "scroll" },
      { targetKind: "web", kind: "scroll", target: { nodeId: "node-1", selector: "token" }, graphId: "graph-current", direction: "down", amount: "small" },
      { stepIndex: 0, kind: "scroll", target: { purpose: "scroll" }, direction: "down", amount: "small" },
    ],
  ] as const)("terminalizes a generic dispatched %s rejection as unknown without starting the next step", async (_kind, proposal, resolved, firstStep) => {
    const traceRecorder = new InMemoryTraceRecorder();
    let decisions = 0;
    let attempts = 0;
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-current", [{ id: "node-1", role: "button", confidence: 1 }]) },
      decisionProvider: { decide: async () => { decisions += 1; return proposal as never; } },
      resolver: { resolve: async () => resolved as never },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async (_action, permit, signal) => { attempts += 1; permit.assertAuthorizedForDispatch(signal); throw new Error("generic Playwright rejection"); } },
      verifier: { verify: async () => { throw new Error("later verification must not run"); } },
      traceRecorder,
    });
    const job = {
      ...indexedJob(),
      jobId: `job-unknown-${_kind}`,
      runId: `run-unknown-${_kind}`,
      plan: {
        ...indexedJob().plan,
        steps: [
          firstStep,
          { stepIndex: 1, kind: "click", target: { purpose: "must not run" } },
        ],
        maximumStepsPerJob: 2,
        budget: { maximumStepsPerJob: 2, maximumWallClockMs: 1_000, maximumModelTokens: 1_000 },
      },
    };

    await expect(runtime.run(job as never)).resolves.toMatchObject({
      status: "error",
      errorCode: "ActionOutcomeUnknown",
    });
    expect(decisions).toBe(1);
    expect(attempts).toBe(1);
    expect(traceRecorder.eventsFor(job.runId).filter((event) => event.stage === "run_completed")).toHaveLength(1);
  });

  it("preserves an explicit unknown action outcome as error", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-current") },
      decisionProvider: new ScriptedDecisionProvider({ kind: "click", target: { nodeId: "node-1" }, reason: "continue" }),
      resolver: { resolve: async () => ({ targetKind: "web", kind: "click", target: { nodeId: "node-1", selector: "token" }, graphId: "graph-current" }) },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: { execute: async () => ({ status: "failed", errorCode: "ActionOutcomeUnknown" }) },
      verifier: { verify: async () => { throw new Error("verification must not run"); } },
      traceRecorder,
      ...objectiveOnlyBudget,
    });

    await expect(runtime.run(objectiveJob())).resolves.toMatchObject({
      status: "error",
      errorCode: "ActionOutcomeUnknown",
    });
    expect(traceRecorder.eventsFor("run-objective").filter((event) => event.stage === "run_completed")).toHaveLength(1);
  });

  it("maps a timeout reported after dispatch to unknown outcome", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const runtime = new ExecutionRuntime({
      observer: { capture: async () => graph("graph-current") },
      decisionProvider: new ScriptedDecisionProvider({ kind: "click", target: { nodeId: "node-1" }, reason: "continue" }),
      resolver: { resolve: async () => ({ targetKind: "web", kind: "click", target: { nodeId: "node-1", selector: "token" }, graphId: "graph-current" }) },
      policyGate: new AllowAllRunnerPolicyGate(),
      actionExecutor: {
        execute: async (_action, permit, signal) => {
          permit.assertAuthorizedForDispatch(signal);
          return { status: "failed", errorCode: "ActionTimedOut" };
        },
      },
      verifier: { verify: async () => { throw new Error("verification must not run"); } },
      traceRecorder,
      ...objectiveOnlyBudget,
    });

    await expect(runtime.run(objectiveJob())).resolves.toMatchObject({
      status: "error",
      errorCode: "ActionOutcomeUnknown",
    });
  });

  it("maps an expected executor target rejection but treats infrastructure loss after dispatch as unknown", async () => {
    const run = async (error: ExecutionTargetError) => {
      const traceRecorder = new InMemoryTraceRecorder();
      const runtime = new ExecutionRuntime({
        observer: { capture: async () => graph("graph-current") },
        decisionProvider: new ScriptedDecisionProvider({ kind: "click", target: { nodeId: "node-1" }, reason: "continue" }),
        resolver: { resolve: async () => ({ targetKind: "web", kind: "click", target: { nodeId: "node-1", selector: "token" }, graphId: "graph-current" }) },
        policyGate: new AllowAllRunnerPolicyGate(),
        actionExecutor: { execute: async (_action, permit, signal) => {
          if (error.errorCode === "ActionInfrastructureFailure") {
            permit.assertAuthorizedForDispatch(signal);
          }
          throw error;
        } },
        verifier: { verify: async () => { throw new Error("verification must not run"); } },
        traceRecorder,
        ...objectiveOnlyBudget,
      });
      return runtime.run(objectiveJob());
    };

    await expect(run(new ExecutionTargetError("TargetDisabled", "blocked"))).resolves.toMatchObject({
      status: "blocked",
      errorCode: "TargetDisabled",
    });
    await expect(run(new ExecutionTargetError("ActionInfrastructureFailure", "error"))).resolves.toMatchObject({
      status: "error",
      errorCode: "ActionOutcomeUnknown",
    });
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
      observer: { capture: async () => graph("graph-1") },
      decisionProvider: new ScriptedDecisionProvider({ kind: "click", target: { nodeId: "node-1" }, reason: "test" }),
      resolver: { resolve: async () => action as never },
      policyGate: new DeterministicRunnerPolicyGate(policy),
      actionExecutor: { execute: async () => { executorCalls += 1; return { status: "ok" as const }; } },
      verifier: { verify: async () => ({ status: "passed" as const, summary: "not reached", claims: [] }) },
      traceRecorder,
      ...objectiveOnlyBudget,
    });
    const completion = await runtime.run({ jobId: "job-1", runId: "run-1", projectId: "project-test", target: { kind: "web", url: "https://example.test/" }, objective: "test", policy });
    expect(completion).toMatchObject({ status: "blocked", errorCode: "PolicyDenied" });
    expect(executorCalls).toBe(0);
    expect(traceRecorder.eventsFor("run-1").map((event) => event.stage)).not.toContain("policy_authorized");
  });

  it("runs an accepted web job through all M1 stages and records trace in order", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const observations = [
      graph("graph-before", [
        {
          id: "node-login",
          role: "button",
          name: "Login",
          confidence: 1,
        },
      ]),
      graph("graph-after", [
        {
          id: "node-logout",
          role: "button",
          name: "Logout",
          confidence: 1,
        },
      ]),
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
      ...objectiveOnlyBudget,
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
        capture: async () => graph("graph-before", [
          {
            id: "node-danger",
            role: "button",
            name: "Delete",
            confidence: 1,
          },
        ]),
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
      ...objectiveOnlyBudget,
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
      graph("graph-before", [
        {
          id: "node-price",
          role: "text",
          name: "$19",
          confidence: 1,
        },
      ]),
      graph("graph-after", [
        {
          id: "node-total",
          role: "text",
          name: "$29",
          confidence: 1,
        },
      ]),
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
      ...objectiveOnlyBudget,
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
          return graph("graph-before", [
            {
              id: "node-add",
              role: "button",
              name: "Add to cart",
              confidence: 1,
            },
          ]);
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
      ...objectiveOnlyBudget,
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

type TestNode = Pick<ObservationNodeV1, "id" | "role" | "confidence"> & {
  readonly name?: string;
  readonly value?: string;
};

function graph(graphId: string, nodes: readonly TestNode[] = []): ObservationGraphV1 {
  const root: ObservationNodeV1 = {
    id: `${graphId}:root`,
    role: "document",
    name: "Test page",
    state: {},
    relations: nodes.map((node) => ({ type: "child", targetNodeId: node.id })),
    source: { adapterId: "runner-kernel-test", sourceKind: "fixture" },
    confidence: 1,
    sensitivity: "public",
    extensions: {},
    evidenceRefs: [],
  };
  return {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId,
    target: { kind: "web", targetId: "https://example.test" },
    capturedAt: "2026-08-24T00:00:00.000Z",
    rootNodeIds: [root.id],
    nodes: [root, ...nodes.map((node): ObservationNodeV1 => ({
      id: node.id,
      role: node.role,
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(node.value === undefined ? {} : { value: node.value }),
      state: {},
      relations: [],
      source: { adapterId: "runner-kernel-test", sourceKind: "fixture" },
      confidence: node.confidence,
      sensitivity: "public",
      extensions: {},
      evidenceRefs: [],
    }))],
    evidenceRefs: [],
    extensions: {
      [WEB_EXTENSION_V1_TYPE]: {
        type: WEB_EXTENSION_V1_TYPE,
        version: "1.0",
        payload: {
          origin: "https://example.test",
          pathname: "/",
          title: "Test page",
          viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
          query: {},
        },
      },
    },
  };
}

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

function objectiveJob() {
  return {
    jobId: "job-objective",
    runId: "run-objective",
    projectId: "project-test",
    target: { kind: "web" as const, url: "https://example.test/" },
    objective: "click",
    policy,
  };
}

function twoClickPlanJob(options: {
  readonly steps?: readonly [{ readonly stepIndex: number; readonly kind: "click"; readonly target: { readonly purpose: string } }];
  readonly maximumStepsPerJob?: number;
} = {}) {
  const steps = options.steps ?? [
    { stepIndex: 0, kind: "click" as const, target: { purpose: "first" } },
    { stepIndex: 1, kind: "click" as const, target: { purpose: "second" } },
  ];
  return {
    jobId: "job-two-step",
    runId: "run-two-step",
    projectId: "project-test",
    target: { kind: "web" as const, url: "https://example.test/" },
    objective: "execute bounded clicks",
    policy,
    plan: {
      missionId: "mission-1",
      missionRevision: 1,
      testCaseId: "case-two-step",
      steps,
      expectedClaimIds: ["claim-final"] as [string],
      budget: {
        maximumStepsPerJob: options.maximumStepsPerJob ?? 2,
        maximumWallClockMs: 1_000,
        maximumModelTokens: 1_000,
      },
    },
  };
}
