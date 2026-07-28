import { describe, expect, it } from "vitest";
import {
  AllowAllRunnerPolicyGate,
  ExecutionRuntime,
  InMemoryTraceRecorder,
  ScriptedDecisionProvider,
} from "../../../packages/runner-kernel/src/index.js";

describe("ExecutionRuntime", () => {
  it("runs an accepted web job through all M1 stages and records trace in order", async () => {
    const traceRecorder = new InMemoryTraceRecorder();
    const runtime = new ExecutionRuntime({
      observer: {
        capture: async () => ({
          graphId: "graph-1",
          nodes: [
            {
              id: "node-login",
              role: "button",
              name: "Login",
              confidence: 1,
            },
          ],
        }),
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
          summary: "login button accepted click",
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
    expect(traceRecorder.eventsFor("run-1").map((event) => event.stage)).toEqual([
      "observation",
      "decision",
      "action_resolved",
      "policy_authorized",
      "action_executed",
      "verification",
      "finding",
    ]);
  });
});
