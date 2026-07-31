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
          claims: [],
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
      target: { kind: "web", url: "https://example.test" },
      objective: "Click delete",
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
      target: { kind: "web", url: "https://example.test" },
      objective: "Verify cart total",
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
  });
});
