import { describe, expect, it } from "vitest";
import {
  createScenarioWalkTestDoubleAgentFactory,
  runBenchmark,
  type BenchmarkStore,
  type ScenarioDefinition,
} from "@qualigence/benchmark-runner";
import type {
  BenchmarkAttempt,
  DetectionBenchmarkManifest,
  DetectionBenchmarkReport,
  GroundTruth,
  ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";
import type {
  ExplorationAttemptProgress,
  ExplorationCheckpoint,
} from "@qualigence/mission";
import type { BenchmarkRunRecord, PersistedAttempt } from "@qualigence/sqlite-runtime";
import type {
  ExplorationProgressUpdate,
  ExplorationProgressUpdateResult,
  NewExplorationAttemptProgress,
} from "@qualigence/exploration";

const profile: ReferenceModelProfile = {
  profileId: "reference-replay-profile",
  providerId: "qualigence-deterministic",
  modelId: "qualigence-reference-detector-1",
  promptVersion: "prompt/2026-08-01",
  policyBundleSha256: "1".repeat(64),
  skillPackSha256: "2".repeat(64),
  browserVersion: "deterministic-target/1.0.0",
  fixtureVersions: { checkout: "checkout/1.0.0" },
  maximumSteps: 5,
  maximumWallClockMs: 60_000,
  maximumModelTokens: 10_000,
  repetitions: 1,
};

const manifest: DetectionBenchmarkManifest = {
  schemaVersion: "detection-benchmark/v1",
  benchmarkVersion: "benchmark-input-binding-test",
  referenceProfile: profile,
  scenarios: [
    {
      scenarioId: "checkout-bug",
      fixtureId: "checkout",
      fixtureVersion: "checkout/1.0.0",
      mode: "fault",
      missionRef: "scenarios/checkout-bug.json",
      groundTruthRef: "ground-truth/checkout.json",
      expectedDefectIds: ["bug-1"],
    },
  ],
  thresholds: {
    p0RecallMinimum: 1,
    knownBugRecallMinimum: 0.8,
    findingPrecisionMinimum: 0.6,
    stableReproductionRateMinimum: 0.7,
    maximumHighConfidenceFalsePositivesPerNormalMission: 1,
  },
};

const groundTruth: GroundTruth = {
  benchmarkVersion: manifest.benchmarkVersion,
  defects: [
    { scenarioId: "checkout-bug", defectId: "bug-1", severity: "P1", stable: true },
  ],
};

function scenarioWithRawQueryValues(input: {
  readonly seed: string;
  readonly productSession: string;
  readonly cartSession: string;
}): ScenarioDefinition {
  return {
    scenarioId: "checkout-bug",
    mode: "fault",
    seedUrl: `https://checkout.fixture.local/product?seed=${input.seed}`,
    states: [
      {
        id: "product",
        url: `https://checkout.fixture.local/product?session=${input.productSession}`,
        title: "Product",
        nodes: [{ id: "go-cart", role: "link", name: "Cart", confidence: 1 }],
        advanceNodeId: "go-cart",
        signals: [],
      },
      {
        id: "cart",
        url: `https://checkout.fixture.local/cart?session=${input.cartSession}`,
        title: "Cart",
        nodes: [{ id: "bug", role: "text", text: "incorrect total", confidence: 1 }],
        advanceNodeId: null,
        signals: [{ defectId: "bug-1", confidence: "high" }],
      },
    ],
  };
}

class InMemoryBenchmarkStore implements BenchmarkStore {
  private readonly runs = new Map<string, BenchmarkRunRecord>();
  private readonly attempts = new Map<string, BenchmarkAttempt[]>();
  private readonly reports = new Map<string, DetectionBenchmarkReport>();
  private readonly progress = new Map<string, ExplorationAttemptProgress>();
  private readonly checkpoints = new Map<string, ExplorationCheckpoint[]>();

  async saveRun(run: BenchmarkRunRecord): Promise<void> {
    this.runs.set(run.runId, run);
  }

  async appendAttempt(runId: string, attempt: PersistedAttempt): Promise<void> {
    const existing = this.attempts.get(runId) ?? [];
    this.attempts.set(runId, [...existing, attempt.attempt]);
  }

  async attemptsForRun(runId: string): Promise<readonly BenchmarkAttempt[]> {
    return this.attempts.get(runId) ?? [];
  }

  async saveReport(runId: string, report: DetectionBenchmarkReport): Promise<void> {
    this.reports.set(runId, report);
  }

  async reportForRun(runId: string): Promise<DetectionBenchmarkReport | undefined> {
    return this.reports.get(runId);
  }

  async loadAttemptProgress(attemptId: string): Promise<ExplorationAttemptProgress | undefined> {
    return this.progress.get(attemptId);
  }

  async initializeAttemptProgress(input: NewExplorationAttemptProgress): Promise<ExplorationAttemptProgress> {
    const existing = this.progress.get(input.attemptId);
    if (existing !== undefined) {
      return existing;
    }
    const created: ExplorationAttemptProgress = {
      ...input,
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    this.progress.set(input.attemptId, created);
    return created;
  }

  async compareAndSetAttemptProgress(
    update: ExplorationProgressUpdate,
  ): Promise<ExplorationProgressUpdateResult> {
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
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    this.progress.set(update.attemptId, next);
    return { status: "updated", progress: next };
  }

  async liveCheckpointsForAttempt(attemptId: string): Promise<readonly ExplorationCheckpoint[]> {
    return this.checkpoints.get(attemptId) ?? [];
  }
}

async function runWithScenario(scenario: ScenarioDefinition) {
  return runBenchmark({
    manifest,
    groundTruth,
    scenarios: [scenario],
    store: new InMemoryBenchmarkStore(),
    agentFactory: createScenarioWalkTestDoubleAgentFactory(),
    createdAt: "2026-08-01T00:00:00.000Z",
  });
}

describe("benchmark replay input binding", () => {
  it("keeps run identity stable when only raw scenario URL query values change", async () => {
    const first = await runWithScenario(
      scenarioWithRawQueryValues({ seed: "alpha", productSession: "one", cartSession: "two" }),
    );
    const second = await runWithScenario(
      scenarioWithRawQueryValues({ seed: "beta", productSession: "three", cartSession: "four" }),
    );

    expect(second.runId).toBe(first.runId);
    expect(second.report.inputSha256).toBe(first.report.inputSha256);
    expect(second.report.attemptBindingSha256s).toEqual(first.report.attemptBindingSha256s);
  });
});
