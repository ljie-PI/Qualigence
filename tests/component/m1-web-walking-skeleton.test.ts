import { describe, expect, it } from "vitest";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import { InMemoryTraceStore, TraceIngestor } from "@qualigence/evidence";
import { ExecutionRuntime } from "@qualigence/runner-kernel";
import {
  AllowAllRunnerPolicyGate,
  ScriptedDecisionProvider,
} from "@qualigence/testkit";
import { observationGraphV1 } from "../helpers/observation-graph-v1.js";

describe("M1 web walking skeleton", () => {
  it("delivers runner trace and finding events into Core Evidence", async () => {
    const traceStore = new InMemoryTraceStore();
    const traceIngestor = new TraceIngestor(traceStore);
    const traceRecorder = new InMemoryProtocolTraceRecorder(traceIngestor);
    const observations = [
      observationGraphV1("graph-before", [
        {
          id: "node-login",
          role: "button",
          name: "Login",
          confidence: 1,
        },
      ]),
      observationGraphV1("graph-after", [
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
      projectId: "project-test",
      target: { kind: "web", url: "https://example.test" },
      objective: "Click login",
      policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
      plan: {
        missionId: "mission-1",
        missionRevision: 1,
        testCaseId: "case-1",
        steps: [{ stepIndex: 0, kind: "click", target: { role: "button", name: "Login", purpose: "click login" } }],
        expectedClaimIds: ["claim-1"],
        budget: { maximumStepsPerJob: 1, maximumWallClockMs: 1_000, maximumModelTokens: 1_000 },
      },
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
