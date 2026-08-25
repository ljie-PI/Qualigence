import { describe, expect, it } from "vitest";
import {
  ExplorationController,
  type ExplorationActionClassifier,
  type ExplorationAgentPort,
  type ExplorationContext,
  type ExplorationControllerDependencies,
  type ExplorationJob,
  type ExplorationPolicyGate,
  type ExplorationProgressStore,
  type ExplorationProgressUpdate,
  type ExplorationProgressUpdateResult,
  type ExplorationProposal,
  type ExplorationSeedReplayPort,
  type ExplorationTarget,
  type GroundedExplorationAction,
  type MonotonicClock,
  type NewExplorationAttemptProgress,
  type RegressionJobResult,
  type RegressionSeed,
} from "@qualigence/exploration";
import type {
  ActionRiskLevel,
  ExplorationAttemptProgress,
  ExplorationCheckpoint,
  ExplorationDecision,
  ExplorationPolicy,
  ProposedExplorationAction,
} from "@qualigence/mission";
import type {
  ProcedureSkillVersion,
  SkillVerificationScope,
  SignedSkillBundle,
} from "@qualigence/skill";
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
  return {
    runId: "run-1",
    attemptId: "attempt-1",
    sourceBindingHash: "source-binding-1",
    policy: policy(),
    environment: "test",
    ...overrides,
  };
}

type TestControllerDependencies =
  & Omit<ExplorationControllerDependencies, "clock" | "progressStore">
  & Partial<Pick<ExplorationControllerDependencies, "clock" | "progressStore">>;

function createController(deps: TestControllerDependencies): ExplorationController {
  return new ExplorationController({
    ...deps,
    progressStore: deps.progressStore ?? new InMemoryProgressStore(),
    clock: deps.clock ?? new FakeClock(),
  });
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
  return graphAt("https://shop.example/product");
}

function graphAt(url: string): ObservationGraph {
  return {
    graphId: `graph-${url}`,
    url,
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

class RecoveringTarget extends ScriptedTarget {
  failuresBeforeRecovery = 1;
  recoveries = 0;

  override async capture(): Promise<ObservationGraph> {
    if (this.failuresBeforeRecovery > 0) {
      this.failuresBeforeRecovery -= 1;
      throw new Error("environment unavailable");
    }
    return super.capture();
  }

  async recover(): Promise<void> {
    this.recoveries += 1;
  }
}

class InMemoryProgressStore implements ExplorationProgressStore {
  private progress = new Map<string, ExplorationAttemptProgress>();
  private checkpoints = new Map<string, ExplorationCheckpoint[]>();
  private sequence = 0;

  async loadAttemptProgress(attemptId: string): Promise<ExplorationAttemptProgress | undefined> {
    return this.progress.get(attemptId);
  }

  async initializeAttemptProgress(input: NewExplorationAttemptProgress): Promise<ExplorationAttemptProgress> {
    const existing = this.progress.get(input.attemptId);
    if (existing !== undefined) return existing;
    const now = this.now();
    const created: ExplorationAttemptProgress = {
      ...input,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.progress.set(input.attemptId, created);
    return created;
  }

  async compareAndSetAttemptProgress(update: ExplorationProgressUpdate): Promise<ExplorationProgressUpdateResult> {
    const current = this.progress.get(update.attemptId);
    if (current === undefined || current.version !== update.expectedVersion) {
      return { status: "conflict", current };
    }
    if (update.checkpoint !== undefined) {
      const existing = this.checkpoints.get(update.attemptId) ?? [];
      this.checkpoints.set(update.attemptId, [...existing, update.checkpoint]);
    }
    const next: ExplorationAttemptProgress = {
      attemptId: current.attemptId,
      runId: current.runId,
      sourceBindingHash: current.sourceBindingHash,
      policyBindingHash: current.policyBindingHash,
      seedBindingHash: current.seedBindingHash,
      phase: update.phase,
      seedCursor: update.seedCursor,
      lastSafeStep: update.lastSafeStep,
      ...(update.lastSafeGraphFingerprint === undefined ? {} : { lastSafeGraphFingerprint: update.lastSafeGraphFingerprint }),
      remaining: update.remaining,
      ...(update.inFlightAction === undefined ? {} : { inFlightAction: update.inFlightAction }),
      ...(update.terminalReason === undefined ? {} : { terminalReason: update.terminalReason }),
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    };
    this.progress.set(update.attemptId, next);
    return { status: "updated", progress: next };
  }

  async liveCheckpointsForAttempt(attemptId: string): Promise<readonly ExplorationCheckpoint[]> {
    return this.checkpoints.get(attemptId) ?? [];
  }

  private now(): string {
    this.sequence += 1;
    return `2026-08-01T00:00:${this.sequence.toString().padStart(2, "0")}.000Z`;
  }
}

class CrashAfterSeedCursorStore extends InMemoryProgressStore {
  private crashed = false;

  override async compareAndSetAttemptProgress(update: ExplorationProgressUpdate): Promise<ExplorationProgressUpdateResult> {
    const result = await super.compareAndSetAttemptProgress(update);
    if (!this.crashed && update.seedCursor.nextSeedIndex > 0 && update.checkpoint === undefined) {
      this.crashed = true;
      throw new Error("process crashed after seed cursor commit");
    }
    return result;
  }
}

class CrashAfterSafeCheckpointStore extends InMemoryProgressStore {
  private crashed = false;

  override async compareAndSetAttemptProgress(update: ExplorationProgressUpdate): Promise<ExplorationProgressUpdateResult> {
    const result = await super.compareAndSetAttemptProgress(update);
    if (!this.crashed && update.checkpoint !== undefined && update.checkpoint.terminalReason === undefined) {
      this.crashed = true;
      throw new Error("process crashed after checkpoint commit");
    }
    return result;
  }
}

class CrashAfterInFlightStore extends InMemoryProgressStore {
  override async compareAndSetAttemptProgress(update: ExplorationProgressUpdate): Promise<ExplorationProgressUpdateResult> {
    const result = await super.compareAndSetAttemptProgress(update);
    if (update.phase === "action_in_flight") {
      throw new Error("process crashed with action in flight");
    }
    return result;
  }
}

class ConflictOnTerminalStore extends InMemoryProgressStore {
  override async compareAndSetAttemptProgress(update: ExplorationProgressUpdate): Promise<ExplorationProgressUpdateResult> {
    if (update.phase === "terminal") {
      return { status: "conflict", current: await this.loadAttemptProgress(update.attemptId) };
    }
    return super.compareAndSetAttemptProgress(update);
  }
}

class RecordingSeedReplay implements ExplorationSeedReplayPort {
  readonly ids: string[] = [];

  async replay(seed: RegressionSeed): Promise<RegressionJobResult> {
    this.ids.push(seed.plan.skillBundleId);
    return {
      skillBundleId: seed.plan.skillBundleId,
      repetitionsRun: 1,
      attempts: [{ status: "passed" }],
      status: "passed",
    };
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

const seedScope: SkillVerificationScope = {
  projectId: "proj-1",
  targetId: "web-cart",
  origin: "https://shop.example",
};

function seed(skillBundleId: string, state: ProcedureSkillVersion["state"] = "verified"): RegressionSeed {
  const payload: ProcedureSkillVersion = {
    skillId: `skill-${skillBundleId}`,
    version: 1,
    state,
    projectId: "proj-1",
    targetScope: { targetId: "web-cart", allowedOrigins: ["https://shop.example"] },
    parameters: [],
    steps: [
      {
        stepId: "step-1",
        intent: { kind: "click", target: { purpose: "add to cart" } },
        preconditions: [],
        checkpoint: [{ kind: "url_path", path: "/cart" }],
        recovery: "stop",
        sourceNodeId: "node-add",
      },
    ],
    sourceRecordingIds: ["rec-1"],
    observationSchemaEpoch: "pre-v1",
    locatorSchemaVersion: "semantic-locator/v1",
    compilerVersion: "skill-compiler/v1",
    contentSha256: `sha-${skillBundleId}`,
  };
  const bundle: SignedSkillBundle = {
    manifest: {
      bundleId: skillBundleId,
      skillId: payload.skillId,
      skillVersion: payload.version,
      schemaVersion: "skill-bundle/v1",
      compilerVersion: payload.compilerVersion,
      contentSha256: payload.contentSha256,
      signerKeyId: "0123456789abcdef0123456789abcdef",
      signatureAlgorithm: "Ed25519",
      signatureBase64: "AAAA",
      issuedAt: "2026-08-01T00:00:00.000Z",
    },
    payload,
  };
  return {
    plan: {
      skillBundleId,
      targetVersion: "2026.08.01",
      repetitions: 1,
      stopOnFirstFailure: true,
    },
    bundle,
    scope: seedScope,
  };
}

describe("ExplorationController", () => {
  it("refuses to explore a production environment", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = createController({
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
    const controller = createController({
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
    const controller = createController({
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
    const controller = createController({
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
    const controller = createController({
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
    const controller = createController({
      target,
      agent: new ScriptedAgent(() => ({ status: "stop", reason: "done" })),
      clock: new FakeClock(),
    });

    const result = await controller.run(job());

    expect(result.terminalReason).toBe("objective_satisfied");
    expect(target.executedActions()).toHaveLength(0);
  });

  it("never revisits a fingerprinted state beyond the policy limit", async () => {
    // The target always reports the same state, so the second observation is a revisit.
    const target = new ScriptedTarget([fixedGraph(), fixedGraph(), fixedGraph()]);
    const controller = createController({
      target,
      agent: new ScriptedAgent(() => act(clickAdd)),
      clock: new FakeClock(),
    });

    const result = await controller.run(job({ policy: policy({ maximumStateVisits: 1 }) }));

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
    const controller = createController({
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
    const controller = createController({
      target,
      agent,
      clock: new FakeClock(),
    });

    await controller.run(job());

    expect(agent.contexts[0]?.remainingBudget.remainingSteps).toBe(7);
    expect(agent.contexts[0]?.allowedActionKinds).toContain("click");
  });

  it("executes configured verified seed skills before novel exploration", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const agent = new ScriptedAgent(() => ({ status: "stop", reason: "done" }));
    const seedReplay = new RecordingSeedReplay();
    const controller = createController({
      target,
      agent,
      seedReplay,
      clock: new FakeClock(),
    });

    const result = await controller.run(job({
      policy: policy({ seedSkillBundleIds: ["bundle-a", "bundle-b"] }),
      seedSkills: [seed("bundle-a"), seed("bundle-b")],
    }));

    expect(seedReplay.ids).toEqual(["bundle-a", "bundle-b"]);
    expect(agent.contexts).toHaveLength(1);
    expect(result.seedReplays.map((replay) => replay.skillBundleId)).toEqual(["bundle-a", "bundle-b"]);
    expect(result.terminalReason).toBe("objective_satisfied");
  });

  it("resumes from durable seed cursor without replaying an acknowledged seed", async () => {
    const store = new CrashAfterSeedCursorStore();
    const firstSeedReplay = new RecordingSeedReplay();
    const first = createController({
      target: new ScriptedTarget([fixedGraph()]),
      agent: new ScriptedAgent(() => ({ status: "stop", reason: "done" })),
      seedReplay: firstSeedReplay,
      progressStore: store,
    });

    await expect(first.run(job({
      attemptId: "attempt-seed-resume",
      policy: policy({ seedSkillBundleIds: ["bundle-a"] }),
      seedSkills: [seed("bundle-a")],
    }))).rejects.toThrow(/seed cursor commit/);
    expect(firstSeedReplay.ids).toEqual([]);

    const resumedSeedReplay = new RecordingSeedReplay();
    const resumed = createController({
      target: new ScriptedTarget([fixedGraph()]),
      agent: new ScriptedAgent(() => ({ status: "stop", reason: "done" })),
      seedReplay: resumedSeedReplay,
      progressStore: store,
    });

    const result = await resumed.run(job({
      attemptId: "attempt-seed-resume",
      policy: policy({ seedSkillBundleIds: ["bundle-a"] }),
      seedSkills: [seed("bundle-a")],
    }));

    expect(result.terminalReason).toBe("objective_satisfied");
    expect(resumedSeedReplay.ids).toEqual([]);
  });

  it("resumes from durable progress without replaying acknowledged safe work", async () => {
    const crashingStore = new CrashAfterSafeCheckpointStore();
    const firstTarget = new ScriptedTarget([distinctGraph(), distinctGraph()]);
    const firstAgent = new ScriptedAgent((context) =>
      act({ kind: "click", nodeId: context.graph.nodes[0]?.id ?? "missing", reason: "first" }),
    );
    const first = createController({
      target: firstTarget,
      agent: firstAgent,
      progressStore: crashingStore,
      clock: new FakeClock(),
    });

    await expect(first.run(job({ attemptId: "attempt-resume" }))).rejects.toThrow(/checkpoint commit/);
    expect(firstTarget.executedActions()).toHaveLength(1);

    const resumedTarget = new ScriptedTarget([distinctGraph()]);
    const resumedAgent = new ScriptedAgent(() => ({ status: "stop", reason: "done" }));
    const resumed = createController({
      target: resumedTarget,
      agent: resumedAgent,
      progressStore: crashingStore,
      clock: new FakeClock(),
    });

    const resumedResult = await resumed.run(job({ attemptId: "attempt-resume" }));

    expect(resumedResult.terminalReason).toBe("objective_satisfied");
    expect(resumedResult.stepsExecuted).toBe(1);
    expect(resumedTarget.executedActions()).toHaveLength(0);
    expect(resumedAgent.contexts[0]?.remainingBudget.remainingSteps).toBe(6);
  });

  it("uses the policy maximum state visits instead of a hard-coded one-visit cap", async () => {
    const target = new ScriptedTarget([fixedGraph(), fixedGraph(), fixedGraph()]);
    const controller = createController({
      target,
      agent: new ScriptedAgent(() => act(clickAdd)),
      clock: new FakeClock(),
    });

    const result = await controller.run(job({ policy: policy({ maximumSteps: 2, maximumStateVisits: 2 }) }));

    expect(target.executedActions()).toHaveLength(2);
    expect(result.terminalReason).toBe("state_repeated");
  });

  it("spends recovery budget only for deterministic environment recovery", async () => {
    const target = new RecoveringTarget([fixedGraph()]);
    const controller = createController({
      target,
      agent: new ScriptedAgent(() => ({ status: "stop", reason: "done" })),
      clock: new FakeClock(),
    });

    const result = await controller.run(job({ policy: policy({ maximumRecoveries: 1 }) }));

    expect(result.terminalReason).toBe("objective_satisfied");
    expect(target.recoveries).toBe(1);
  });

  it("rejects out-of-origin observations before model actions dispatch", async () => {
    const target = new ScriptedTarget([graphAt("https://evil.example/product")]);
    const agent = new ScriptedAgent(() => act(clickAdd));
    const controller = createController({
      target,
      agent,
      clock: new FakeClock(),
    });

    const result = await controller.run(job());

    expect(result.terminalReason).toBe("policy_denied");
    expect(result.errorCode).toBe("OriginViolation");
    expect(agent.contexts).toHaveLength(0);
    expect(target.executedActions()).toHaveLength(0);
  });

  it("rejects out-of-origin navigation proposals before dispatch", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = createController({
      target,
      agent: new ScriptedAgent(() => act({ kind: "navigate", path: "https://evil.example/", reason: "leave" })),
      clock: new FakeClock(),
    });

    const result = await controller.run(job());

    expect(result.terminalReason).toBe("policy_denied");
    expect(result.errorCode).toBe("OriginViolation");
    expect(target.executedActions()).toHaveLength(0);
  });

  it("maps model invocation failures to a stable terminal error before dispatch", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = createController({
      target,
      agent: { async nextAction() { throw new Error("provider timeout"); } },
      clock: new FakeClock(),
    });

    const result = await controller.run(job());

    expect(result.terminalReason).toBe("error");
    expect(result.errorCode).toBe("ExplorationModelUnavailable");
    expect(target.executedActions()).toHaveLength(0);
  });

  it("maps failed recovery attempts to a stable terminal error", async () => {
    const target = new RecoveringTarget([fixedGraph()]);
    target.failuresBeforeRecovery = 2;
    const controller = createController({
      target,
      agent: new ScriptedAgent(() => ({ status: "stop", reason: "done" })),
      clock: new FakeClock(),
    });

    const result = await controller.run(job({ policy: policy({ maximumRecoveries: 1 }) }));

    expect(result.terminalReason).toBe("error");
    expect(result.errorCode).toBe("EnvironmentRecoveryFailed");
    expect(target.recoveries).toBe(1);
  });

  it("fails closed when finite model usage is unavailable", async () => {
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = createController({
      target,
      agent: { async nextAction() { return { decision: act(clickAdd) }; } },
      clock: new FakeClock(),
    });

    const result = await controller.run(job());

    expect(result.terminalReason).toBe("error");
    expect(result.errorCode).toBe("ModelUsageUnavailable");
    expect(target.executedActions()).toHaveLength(0);
  });

  it("fails closed when terminal progress cannot be persisted", async () => {
    const store = new ConflictOnTerminalStore();
    const target = new ScriptedTarget([fixedGraph()]);
    const controller = createController({
      target,
      agent: new ScriptedAgent(() => ({ status: "stop", reason: "done" })),
      progressStore: store,
    });

    const result = await controller.run(job({ attemptId: "attempt-terminal-conflict" }));

    expect(result.terminalReason).toBe("error");
    expect(result.errorCode).toBe("ExplorationTerminalPersistenceFailed");
    expect((await store.loadAttemptProgress("attempt-terminal-conflict"))?.phase).toBe("exploring");
  });

  it("persists action_in_flight and refuses automatic replay after an unknown action outcome", async () => {
    const store = new CrashAfterInFlightStore();
    const firstTarget = new ScriptedTarget([fixedGraph()]);
    const first = createController({
      target: firstTarget,
      agent: new ScriptedAgent(() => act(clickAdd)),
      progressStore: store,
      clock: new FakeClock(),
    });

    await expect(first.run(job({ attemptId: "attempt-unknown" }))).rejects.toThrow(/in flight/);
    expect(firstTarget.executedActions()).toHaveLength(0);
    expect((await store.loadAttemptProgress("attempt-unknown"))?.phase).toBe("action_in_flight");

    const secondTarget = new ScriptedTarget([fixedGraph()]);
    const second = createController({
      target: secondTarget,
      agent: new ScriptedAgent(() => act(clickAdd)),
      progressStore: store,
      clock: new FakeClock(),
    });

    const secondResult = await second.run(job({ attemptId: "attempt-unknown" }));

    expect(secondResult.terminalReason).toBe("error");
    expect(secondResult.errorCode).toBe("ActionOutcomeUnknown");
    expect(secondTarget.executedActions()).toHaveLength(0);
    expect((await store.loadAttemptProgress("attempt-unknown"))?.phase).toBe("terminal");
  });
});
