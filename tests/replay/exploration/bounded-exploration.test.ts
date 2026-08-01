import { describe, expect, it } from "vitest";
import {
  ExplorationController,
  type ExplorationAgentPort,
  type ExplorationContext,
  type ExplorationJob,
  type ExplorationProposal,
  type ExplorationResult,
  type ExplorationTarget,
  type GroundedExplorationAction,
  type MonotonicClock,
} from "@qualigence/exploration";
import type { ExplorationDecision, ExplorationPolicy } from "@qualigence/mission";
import type { ObservationGraph } from "@qualigence/runner-protocol";

class FakeClock implements MonotonicClock {
  private value = 0;
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
}

/** A fixed three-state cart fixture: product -> cart -> confirmation. */
const FIXTURE: readonly ObservationGraph[] = [
  {
    graphId: "g-product",
    url: "https://shop.example/product?ts=111",
    title: "Product",
    capturedAt: "2026-08-01T00:00:00.000Z",
    nodes: [{ id: "p-add", role: "button", name: "Add to cart", confidence: 0.91 }],
  },
  {
    graphId: "g-cart",
    url: "https://shop.example/cart?ts=222",
    title: "Cart",
    capturedAt: "2026-08-01T00:00:05.000Z",
    nodes: [{ id: "c-checkout", role: "button", name: "Checkout", confidence: 0.88 }],
  },
  {
    graphId: "g-confirm",
    url: "https://shop.example/confirm?ts=333",
    title: "Confirmation",
    capturedAt: "2026-08-01T00:00:09.000Z",
    nodes: [{ id: "x-done", role: "heading", name: "Order placed", confidence: 0.99 }],
  },
];

class FixtureTarget implements ExplorationTarget {
  private index = 0;
  readonly executed: GroundedExplorationAction[] = [];

  async capture(): Promise<ObservationGraph> {
    const graph = FIXTURE[Math.min(this.index, FIXTURE.length - 1)] as ObservationGraph;
    this.index += 1;
    return graph;
  }

  async execute(action: GroundedExplorationAction): Promise<void> {
    this.executed.push(action);
  }
}

/** A deterministic agent: click the first interactable node until none remain. */
class FixtureAgent implements ExplorationAgentPort {
  async nextAction(context: ExplorationContext): Promise<ExplorationProposal> {
    const node = context.graph.nodes.find((candidate) => candidate.role === "button");
    const decision: ExplorationDecision =
      node === undefined
        ? { status: "stop", reason: "no interactable node" }
        : { status: "act", action: { kind: "click", nodeId: node.id, reason: "advance" }, reason: "advance" };
    return { decision, tokensUsed: 12 };
  }
}

function policy(): ExplorationPolicy {
  return {
    seedSkillBundleIds: [],
    allowedActionKinds: ["navigate", "click", "input"],
    allowedOrigins: ["https://shop.example"],
    maximumSteps: 10,
    maximumWallClockMs: 60_000,
    maximumModelTokens: 100_000,
    maximumStateVisits: 10,
    maximumRecoveries: 2,
    riskCeiling: "RecoverableMutation",
  };
}

const job: ExplorationJob = { runId: "run-replay", policy: policy(), environment: "test" };

async function runOnce(): Promise<ExplorationResult> {
  const controller = new ExplorationController({
    target: new FixtureTarget(),
    agent: new FixtureAgent(),
    clock: new FakeClock(),
  });
  return controller.run(job);
}

describe("bounded exploration replay determinism", () => {
  it("produces the same terminal reason and state sequence across repeated runs", async () => {
    const first = await runOnce();
    const second = await runOnce();

    expect(first.terminalReason).toBe("objective_satisfied");
    expect(second.terminalReason).toBe(first.terminalReason);

    const fingerprints = (result: ExplorationResult): readonly string[] =>
      result.checkpoints.map((checkpoint) => checkpoint.graphFingerprint);

    expect(fingerprints(second)).toEqual(fingerprints(first));
    // Three distinct states, then a clean stop on the terminal confirmation page.
    expect(new Set(fingerprints(first)).size).toBe(fingerprints(first).length);
    expect(first.stepsExecuted).toBe(2);
  });
});
