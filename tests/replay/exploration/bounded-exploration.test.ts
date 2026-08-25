import { describe, expect, it } from "vitest";
import {
  ExplorationController,
  type ExplorationAgentPort,
  type ExplorationContext,
  type ExplorationJob,
  type ExplorationProgressStore,
  type ExplorationProgressUpdate,
  type ExplorationProgressUpdateResult,
  type ExplorationProposal,
  type ExplorationResult,
  type ExplorationTarget,
  type GroundedExplorationAction,
  type MonotonicClock,
} from "@qualigence/exploration";
import type {
  ExplorationAttemptProgress,
  ExplorationCheckpoint,
  ExplorationDecision,
  ExplorationPolicy,
} from "@qualigence/mission";
import { PreV1TraceProjector } from "@qualigence/observation-migration";
import type { ObservationGraphV1 } from "@qualigence/runner-protocol";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";

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
const FIXTURE: readonly ObservationGraphV1[] = [
  graph("g-product", "/product", "Product", [
    { id: "p-add", role: "button", name: "Add to cart", confidence: 0.91 },
  ]),
  graph("g-cart", "/cart", "Cart", [
    { id: "c-checkout", role: "button", name: "Checkout", confidence: 0.88 },
  ]),
  graph("g-confirm", "/confirm", "Confirmation", [
    { id: "x-done", role: "heading", name: "Order placed", confidence: 0.99 },
  ]),
];

class FixtureTarget implements ExplorationTarget {
  private index = 0;
  readonly executed: GroundedExplorationAction[] = [];

  constructor(private readonly graphs: readonly ObservationGraphV1[] = FIXTURE) {}

  async capture(): Promise<ObservationGraphV1> {
    const graph = this.graphs[Math.min(this.index, this.graphs.length - 1)] as ObservationGraphV1;
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

const job: ExplorationJob = {
  runId: "run-replay",
  attemptId: "attempt-replay",
  sourceBindingHash: "source-replay",
  policy: policy(),
  environment: "test",
};

function graph(
  graphId: string,
  pathname: string,
  title: string,
  nodes: Parameters<typeof observationGraphV1>[1],
): ObservationGraphV1 {
  return observationGraphV1(graphId, nodes, {
    target: { kind: "web", targetId: "https://shop.example" },
    extensions: {
      "web/v1": {
        type: "web/v1",
        version: "1.0",
        payload: {
          origin: "https://shop.example",
          pathname,
          title,
          viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
          query: {},
        },
      },
    },
  });
}

class TestProgressStore implements ExplorationProgressStore {
  private progress: ExplorationAttemptProgress | undefined;
  private readonly checkpoints: ExplorationCheckpoint[] = [];

  async loadAttemptProgress(): Promise<ExplorationAttemptProgress | undefined> {
    return this.progress;
  }

  async initializeAttemptProgress(input: Parameters<ExplorationProgressStore["initializeAttemptProgress"]>[0]): Promise<ExplorationAttemptProgress> {
    if (this.progress !== undefined) return this.progress;
    this.progress = {
      ...input,
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    return this.progress;
  }

  async compareAndSetAttemptProgress(update: ExplorationProgressUpdate): Promise<ExplorationProgressUpdateResult> {
    if (this.progress === undefined || this.progress.version !== update.expectedVersion) {
      return { status: "conflict", current: this.progress };
    }
    if (update.checkpoint !== undefined) {
      this.checkpoints.push(update.checkpoint);
    }
    this.progress = {
      attemptId: this.progress.attemptId,
      runId: this.progress.runId,
      sourceBindingHash: this.progress.sourceBindingHash,
      policyBindingHash: this.progress.policyBindingHash,
      seedBindingHash: this.progress.seedBindingHash,
      phase: update.phase,
      seedCursor: update.seedCursor,
      lastSafeStep: update.lastSafeStep,
      ...(update.lastSafeGraphFingerprint === undefined ? {} : { lastSafeGraphFingerprint: update.lastSafeGraphFingerprint }),
      remaining: update.remaining,
      ...(update.inFlightAction === undefined ? {} : { inFlightAction: update.inFlightAction }),
      ...(update.terminalReason === undefined ? {} : { terminalReason: update.terminalReason }),
      version: this.progress.version + 1,
      createdAt: this.progress.createdAt,
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    return { status: "updated", progress: this.progress };
  }

  async liveCheckpointsForAttempt(): Promise<readonly ExplorationCheckpoint[]> {
    return this.checkpoints;
  }
}

async function runOnce(): Promise<ExplorationResult> {
  const controller = new ExplorationController({
    target: new FixtureTarget(),
    agent: new FixtureAgent(),
    progressStore: new TestProgressStore(),
    clock: new FakeClock(),
  });
  return controller.run(job);
}

describe("bounded exploration replay determinism", () => {
  it("projects historical pre-v1 input before replaying it through the live exploration consumer", async () => {
    const projected = new PreV1TraceProjector().project({
      assetId: "legacy-web-observation",
      kind: "observation",
      sourceSchemaVersion: "m1-web-observation",
      target: { kind: "web", targetId: "https://shop.example" },
      adapterId: "legacy-web-adapter",
      capturedAt: "2026-08-01T00:00:00.000Z",
      observation: {
        graphId: "legacy-product",
        url: "https://shop.example/product?secret=never-copy",
        title: "Product",
        nodes: [{ id: "legacy-add", role: "button", name: "Add to cart", confidence: 0.91 }],
      },
    });
    const target = new FixtureTarget([projected]);
    const controller = new ExplorationController({
      target,
      agent: { async nextAction() { return { decision: { status: "stop", reason: "projected" }, tokensUsed: 1 }; } },
      progressStore: new TestProgressStore(),
      clock: new FakeClock(),
    });

    const result = await controller.run({ ...job, attemptId: "attempt-projected" });

    expect(projected.schema.epoch).toBe("v1");
    expect(JSON.stringify(projected)).not.toContain("never-copy");
    expect(result.terminalReason).toBe("objective_satisfied");
  });

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
