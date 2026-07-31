import { describe, expect, it } from "vitest";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import { InMemoryTraceStore, TraceIngestor } from "@qualigence/evidence";
import { ExecutionRuntime } from "@qualigence/runner-kernel";
import {
  AllowAllRunnerPolicyGate,
  ScriptedDecisionProvider,
} from "@qualigence/testkit";

describe("M1 web walking skeleton", () => {
  it("delivers runner trace and finding events into Core Evidence", async () => {
    const traceStore = new InMemoryTraceStore();
    const traceIngestor = new TraceIngestor(traceStore);
    const traceRecorder = new InMemoryProtocolTraceRecorder(traceIngestor);
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
        verify: async () => ({
          status: "passed",
          summary: "login transition observed",
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
    expect(traceStore.eventsFor("run-1").map((event) => event.stage)).toEqual([
      "observation",
      "decision",
      "action_resolved",
      "policy_authorized",
      "action_executed",
      "observation",
      "verification",
      "run_completed",
    ]);
    expect(traceStore.findingsFor("run-1")).toEqual([]);
  });
});
