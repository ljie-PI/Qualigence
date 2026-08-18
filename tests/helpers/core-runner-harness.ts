import {
  capabilities,
  type AcceptedExecutionJob,
  type ExecutionJobOffer,
  type RunnerCapabilities,
} from "@qualigence/runner-protocol";
import { SqliteRunnerSpool, type RunnerSpool } from "@qualigence/runner-spool";
import {
  AllowAllRunnerPolicyGate,
  ScriptedDecisionProvider,
} from "@qualigence/testkit";
import type { LeasedJobExecutorDependencies } from "../../apps/runner/src/job-executor.js";

/** Advertised token every deterministic web Runner in these tests satisfies. */
export const WEB_TARGET_TOKEN = "target:web-playwright";
/** A token the default Runner never advertises, used to force a mismatch. */
export const UNSUPPORTED_TOKEN = "model:vision-input";

export const isolatedTestPolicy = {
  policyId: "policy-test",
  environment: "isolated_test" as const,
  allowedOrigins: ["https://shop.example.test"],
  allowedActionKinds: ["click"] as const,
  maximumRisk: "Normal" as const,
  explorationAllowed: false,
  issuedAt: "2026-08-18T00:00:00.000Z",
  expiresAt: "2026-08-18T00:01:00.000Z",
};

export function webRunnerCapabilities(): RunnerCapabilities {
  return capabilities({ targetAdapters: ["web-playwright"] });
}

export function webJob(overrides: Partial<AcceptedExecutionJob> = {}): AcceptedExecutionJob {
  const { policy = isolatedTestPolicy, ...rest } = overrides;
  return {
    jobId: "job-1",
    runId: "run-1",
    projectId: "project-test",
    target: { kind: "web", url: "https://shop.example.test/cart" },
    objective: "add the item to the cart",
    policy,
    ...rest,
  };
}

export function offerFor(
  job: AcceptedExecutionJob,
  requiredCapabilities: readonly string[],
  leaseDurationMs = 30_000,
): ExecutionJobOffer {
  return {
    offerId: `offer-${job.jobId}`,
    job,
    requiredCapabilities,
    leaseDurationMs,
  };
}

export async function openMemorySpool(): Promise<SqliteRunnerSpool> {
  return SqliteRunnerSpool.open({ databaseFile: ":memory:" });
}

export interface DeterministicClocks {
  monotonic: number;
  wall: number;
}

/**
 * A deterministic single-action web pipeline for the Runner side of the Gate.
 * It observes twice, clicks once and verifies to a passing completion, with no
 * real browser or model — the transport, spool and lease semantics are what the
 * Gate exercises.
 */
export function deterministicRunnerDependencies(
  spool: RunnerSpool,
  clocks: DeterministicClocks,
  overrides: Partial<LeasedJobExecutorDependencies> = {},
): LeasedJobExecutorDependencies {
  const observations = [
    {
      graphId: "graph-before",
      nodes: [{ id: "node-add", role: "button", name: "Add to cart", confidence: 1 }],
    },
    {
      graphId: "graph-after",
      nodes: [{ id: "node-checkout", role: "button", name: "Checkout", confidence: 1 }],
    },
  ];
  return {
    observer: { capture: async () => observations.shift()! },
    decisionProvider: new ScriptedDecisionProvider({
      kind: "click",
      target: { nodeId: "node-add" },
      reason: "add the item to the cart",
    }),
    resolver: {
      resolve: async (action, graph) => ({
        kind: "click",
        target: { nodeId: action.target.nodeId, selector: "text=Add to cart" },
        graphId: graph.graphId,
      }),
    },
    policyGate: new AllowAllRunnerPolicyGate(),
    actionExecutor: { execute: async () => ({ status: "ok" }) },
    verifier: {
      verify: async ({ before, after }) => ({
        status: "passed",
        summary: `${before.graphId} -> ${after.graphId}`,
        claims: [],
      }),
    },
    spool,
    capabilities: webRunnerCapabilities(),
    clocks: {
      monotonicNow: (): number => clocks.monotonic,
      wallNow: (): number => clocks.wall,
    },
    actionDeadlineSafetyMarginMs: 5_000,
    ...overrides,
  };
}
