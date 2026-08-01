import { describe, expect, it } from "vitest";
import {
  ExplorationController,
  type ExplorationActionClassifier,
  type ExplorationAgentPort,
  type ExplorationContext,
  type ExplorationJob,
  type ExplorationPolicyGate,
  type ExplorationProposal,
  type ExplorationTarget,
  type GroundedExplorationAction,
  type MonotonicClock,
} from "@qualigence/exploration";
import type {
  ActionRiskLevel,
  ExplorationDecision,
  ExplorationPolicy,
  ProposedExplorationAction,
} from "@qualigence/mission";
import type { ObservationGraph } from "@qualigence/runner-protocol";

class FakeClock implements MonotonicClock {
  value = 0;
  now(): number {
    return this.value;
  }
}

function policy(overrides: Partial<ExplorationPolicy> = {}): ExplorationPolicy {
  return {
    seedSkillBundleIds: [],
    allowedActionKinds: ["navigate", "click", "input"],
    allowedOrigins: ["https://shop.example"],
    maximumSteps: 8,
    maximumWallClockMs: 60_000,
    maximumModelTokens: 100_000,
    maximumStateVisits: 8,
    maximumRecoveries: 2,
    riskCeiling: "RecoverableMutation",
    ...overrides,
  };
}

function job(overrides: Partial<ExplorationJob> = {}): ExplorationJob {
  return { runId: "run-1", policy: policy(), environment: "test", ...overrides };
}

let graphCounter = 0;
function distinctGraph(): ObservationGraph {
  graphCounter += 1;
  return {
    graphId: `graph-${graphCounter}`,
    url: `https://shop.example/page-${graphCounter}`,
    title: `Page ${graphCounter}`,
    nodes: [{ id: `node-${graphCounter}`, role: "button", name: "Next", confidence: 0.9 }],
  };
}

function fixedGraph(): ObservationGraph {
  return {
    graphId: "graph-fixed",
    url: "https://shop.example/product",
    title: "Product",
    nodes: [{ id: "node-add", role: "button", name: "Add to cart", confidence: 0.9 }],
  };
}

/** A Target that replays a fixed list of graphs and records every execution. */
class ScriptedTarget implements ExplorationTarget {
  private index = 0;
  private readonly executed: GroundedExplorationAction[] = [];

  constructor(private readonly graphs: readonly ObservationGraph[]) {}

  async capture(): Promise<ObservationGraph> {
    const graph = this.graphs[Math.min(this.index, this.graphs.length - 1)];
    this.index += 1;
    return graph as ObservationGraph;
  }

  async execute(action: GroundedExplorationAction): Promise<void> {
    this.executed.push(action);
  }

  executedActions(): readonly GroundedExplorationAction[] {
    return this.executed;
  }
}

/** An agent that always proposes the same scripted decision. */
class ScriptedAgent implements ExplorationAgentPort {
  readonly contexts: ExplorationContext[] = [];

  constructor(
    private readonly decide: (context: ExplorationContext) => ExplorationDecision,
    private readonly tokensUsed = 10,
  ) {}

  async nextAction(context: ExplorationContext): Promise<ExplorationProposal> {
    this.contexts.push(context);
    return { decision: this.decide(context), tokensUsed: this.tokensUsed };
  }
}

class DenyingPolicyGate implements ExplorationPolicyGate {
  async authorize(): Promise<{ status: "denied"; reason: string }> {
    return { status: "denied", reason: "policy-forbids-exploration" };
  }
}

class RiskClassifier implements ExplorationActionClassifier {
  constructor(private readonly level: ActionRiskLevel) {}
  classify(): ActionRiskLevel {
    return this.level;
  }
}

function act(action: ProposedExplorationAction): ExplorationDecision {
  return { status: "act", action, reason: "explore" };
}

const clickAdd: ProposedExplorationAction = {
  kind: "click",
  nodeId: "node-add",
  reason: "click add to cart",
};

describe("ExplorationController", () => {
  it("refuses to explore a production environment", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = new ExplorationController({
      target,
      agent: new ScriptedAgent(() => act(clickAdd)),
      clock: new FakeClock(),
    });

    const result = await controller.run(job({ environment: "production" }));

    expect(result.terminalReason).toBe("policy_denied");
    expect(result.errorCode).toBe("ExplorationNotAllowed");
    expect(target.executedActions()).toHaveLength(0);
  });

  it("rejects a proposed action that references an unknown node", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = new ExplorationController({
      target,
      agent: new ScriptedAgent(() =>
        act({ kind: "click", nodeId: "node-ghost", reason: "click ghost" }),
      ),
      clock: new FakeClock(),
    });

    const result = await controller.run(job());

    expect(result.terminalReason).toBe("no_safe_action");
    expect(target.executedActions()).toHaveLength(0);
  });

  it("rejects a proposed action kind outside the allowlist", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = new ExplorationController({
      target,
      agent: new ScriptedAgent(() => act(clickAdd)),
      clock: new FakeClock(),
    });

    const result = await controller.run(job({ policy: policy({ allowedActionKinds: ["navigate"] }) }));

    expect(result.terminalReason).toBe("no_safe_action");
    expect(target.executedActions()).toHaveLength(0);
  });

  it("rejects an action classified above the risk ceiling and never executes it", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = new ExplorationController({
      target,
      agent: new ScriptedAgent(() => act(clickAdd)),
      classifier: new RiskClassifier("Destructive"),
      clock: new FakeClock(),
    });

    const result = await controller.run(job());

    expect(result.terminalReason).toBe("no_safe_action");
    expect(result.errorCode).toBe("UnsafeExplorationAction");
    expect(target.executedActions()).toHaveLength(0);
  });

  it("stops with policy_denied when the runner policy gate denies the action", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = new ExplorationController({
      target,
      agent: new ScriptedAgent(() => act(clickAdd)),
      policyGate: new DenyingPolicyGate(),
      clock: new FakeClock(),
    });

    const result = await controller.run(job());

    expect(result.terminalReason).toBe("policy_denied");
    expect(target.executedActions()).toHaveLength(0);
  });

  it("stops with objective_satisfied when the model proposes stop", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = new ExplorationController({
      target,
      agent: new ScriptedAgent(() => ({ status: "stop", reason: "done" })),
      clock: new FakeClock(),
    });

    const result = await controller.run(job());

    expect(result.terminalReason).toBe("objective_satisfied");
    expect(target.executedActions()).toHaveLength(0);
  });

  it("never revisits a fingerprinted state within the same session", async () => {
    // The target always reports the same state, so the second observation is a revisit.
    const target = new ScriptedTarget([fixedGraph(), fixedGraph(), fixedGraph()]);
    const controller = new ExplorationController({
      target,
      agent: new ScriptedAgent(() => act(clickAdd)),
      clock: new FakeClock(),
    });

    const result = await controller.run(job());

    expect(result.terminalReason).toBe("state_repeated");
    // Exactly one action executed on the novel state; the revisit is refused.
    expect(target.executedActions()).toHaveLength(1);
  });

  it("stops cleanly with budget_exhausted when the step budget runs out", async () => {
    const target = new ScriptedTarget([
      distinctGraph(),
      distinctGraph(),
      distinctGraph(),
      distinctGraph(),
    ]);
    let selector = 0;
    const controller = new ExplorationController({
      target,
      agent: new ScriptedAgent((context) => {
        const node = context.graph.nodes[0];
        selector += 1;
        return act({ kind: "click", nodeId: node?.id ?? "missing", reason: `step-${selector}` });
      }),
      clock: new FakeClock(),
    });

    const result = await controller.run(job({ policy: policy({ maximumSteps: 2 }) }));

    expect(result.terminalReason).toBe("budget_exhausted");
    expect(target.executedActions()).toHaveLength(2);
  });

  it("passes remaining budget and visited fingerprints to the model", async () => {
    const target = new ScriptedTarget([fixedGraph(), fixedGraph()]);
    const agent = new ScriptedAgent(() => act(clickAdd));
    const controller = new ExplorationController({
      target,
      agent,
      clock: new FakeClock(),
    });

    await controller.run(job());

    expect(agent.contexts[0]?.remainingBudget.remainingSteps).toBe(7);
    expect(agent.contexts[0]?.allowedActionKinds).toContain("click");
  });
});
