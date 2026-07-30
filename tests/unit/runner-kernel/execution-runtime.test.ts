import { describe, expect, it } from "vitest";
import {
  ExecutionRuntime,
  type RunnerPolicyGate,
} from "@qualigence/runner-kernel";
import {
  AllowAllRunnerPolicyGate,
  InMemoryTraceRecorder,
  ScriptedDecisionProvider,
} from "@qualigence/testkit";

describe("ExecutionRuntime", () => {
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
        }),
      },
      traceRecorder,
    });

    const completion = await runtime.run({
      jobId: "job-1",
      runId: "run-1",
      target: { kind: "web", url: "https://example.test" },
      objective: "Click login",
    });

    expect(completion.status).toBe("completed");
    expect(completion.finding.title).toBe("M1 verification passed");
    expect(completion.finding.summary).toBe("graph-before -> graph-after");
    expect(traceRecorder.eventsFor("run-1").map((event) => event.stage)).toEqual([
      "observation",
      "decision",
      "action_resolved",
      "policy_authorized",
      "action_executed",
      "observation",
      "verification",
      "finding",
    ]);
  });

  it("records a finding trace when policy denies the action", async () => {
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
        }),
      },
      traceRecorder,
    });

    const completion = await runtime.run({
      jobId: "job-denied",
      runId: "run-denied",
      target: { kind: "web", url: "https://example.test" },
      objective: "Click delete",
    });

    expect(completion.status).toBe("blocked");
    expect(executed).toBe(false);
    expect(traceRecorder.eventsFor("run-denied").map((event) => event.stage)).toEqual([
      "observation",
      "decision",
      "action_resolved",
      "policy_denied",
      "finding",
    ]);
  });

  it("returns a blocked completion and finding when verification fails", async () => {
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
            id: "node-error",
            role: "alert",
            name: "Login failed",
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
        reason: "exercise failed verification",
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
        verify: async () => ({
          status: "failed",
          summary: "expected logout button was not observed",
        }),
      },
      traceRecorder,
    });

    const completion = await runtime.run({
      jobId: "job-failed",
      runId: "run-failed",
      target: { kind: "web", url: "https://example.test" },
      objective: "Click login",
    });

    expect(completion.status).toBe("blocked");
    expect(completion.finding).toMatchObject({
      title: "M1 verification failed",
      summary: "expected logout button was not observed",
      severity: "medium",
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
    ]);
  });
});
