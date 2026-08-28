import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createScenarioWalkTestDoubleAgentFactory,
  runBenchmark,
  type BenchmarkStore,
  type ScenarioDefinition,
} from "@qualigence/benchmark-runner";
import {
  type DetectionBenchmarkManifest,
  type GroundTruth,
  type ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";
import type {
  ExplorationAttemptProgress,
  ExplorationCheckpoint,
} from "@qualigence/mission";
import { SqliteBenchmarkStore, SqliteRuntime } from "@qualigence/sqlite-runtime";

const profile: ReferenceModelProfile = {
  profileId: "reference-test-profile",
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
  benchmarkVersion: "benchmark-progress-test",
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

const scenario: ScenarioDefinition = {
  scenarioId: "checkout-bug",
  mode: "fault",
  states: [
    {
      id: "product",
      url: "https://checkout.fixture.local/product",
      title: "Product",
      nodes: [{ id: "go-cart", role: "link", name: "Cart", confidence: 1 }],
      advanceNodeId: "go-cart",
      signals: [],
    },
    {
      id: "cart",
      url: "https://checkout.fixture.local/cart",
      title: "Cart",
      nodes: [{ id: "bug", role: "text", text: "incorrect total", confidence: 1 }],
      advanceNodeId: null,
      signals: [{ defectId: "bug-1", confidence: "high" }],
    },
  ],
};

class DelegatingBenchmarkStore implements BenchmarkStore {
  constructor(protected readonly delegate: SqliteBenchmarkStore) {}

  saveRun: BenchmarkStore["saveRun"] = (run) => this.delegate.saveRun(run);
  appendAttempt: BenchmarkStore["appendAttempt"] = (runId, attempt) => this.delegate.appendAttempt(runId, attempt);
  attemptsForRun: BenchmarkStore["attemptsForRun"] = (runId) => this.delegate.attemptsForRun(runId);
  saveReport: BenchmarkStore["saveReport"] = (runId, report) => this.delegate.saveReport(runId, report);
  loadAttemptProgress: BenchmarkStore["loadAttemptProgress"] = (attemptId) => this.delegate.loadAttemptProgress(attemptId);
  initializeAttemptProgress: BenchmarkStore["initializeAttemptProgress"] = (progress) => this.delegate.initializeAttemptProgress(progress);
  liveCheckpointsForAttempt: BenchmarkStore["liveCheckpointsForAttempt"] = (attemptId) => this.delegate.liveCheckpointsForAttempt(attemptId);
  compareAndSetAttemptProgress: BenchmarkStore["compareAndSetAttemptProgress"] = (update) => this.delegate.compareAndSetAttemptProgress(update);
}

class CrashAfterSafeCheckpointStore extends DelegatingBenchmarkStore {
  private crashed = false;

  override compareAndSetAttemptProgress: BenchmarkStore["compareAndSetAttemptProgress"] = async (update) => {
    const result = await this.delegate.compareAndSetAttemptProgress(update);
    if (!this.crashed && update.checkpoint !== undefined && update.checkpoint.terminalReason === undefined) {
      this.crashed = true;
      throw new Error("simulated crash after durable safe checkpoint");
    }
    return result;
  };
}

class ConflictOnTerminalStore extends DelegatingBenchmarkStore {
  runId: string | undefined;

  override saveRun: BenchmarkStore["saveRun"] = async (run) => {
    this.runId = run.runId;
    await this.delegate.saveRun(run);
  };

  override compareAndSetAttemptProgress: BenchmarkStore["compareAndSetAttemptProgress"] = async (update) => {
    if (update.phase === "terminal") {
      return { status: "conflict", current: await this.delegate.loadAttemptProgress(update.attemptId) };
    }
    return this.delegate.compareAndSetAttemptProgress(update);
  };
}

describe("benchmark runner durable exploration progress", () => {
  it("resumes from live SQLite progress and persists terminal attempt evidence", async () => {
    await withStore(async (store) => {
      const crashing = new CrashAfterSafeCheckpointStore(store);
      await expect(runBenchmark({
        manifest,
        groundTruth,
        scenarios: [scenario],
        store: crashing,
        agentFactory: createScenarioWalkTestDoubleAgentFactory(),
        createdAt: "2026-08-01T00:00:00.000Z",
      })).rejects.toThrow(/durable safe checkpoint/);

      const resumed = await runBenchmark({
        manifest,
        groundTruth,
        scenarios: [scenario],
        store,
        agentFactory: createScenarioWalkTestDoubleAgentFactory(),
        createdAt: "2026-08-01T00:00:00.000Z",
      });

      expect(resumed.exitCode).toBe(1);
      expect(resumed.report).toMatchObject({
        profileStatus: "unverified",
        gate: { status: "unverified" },
      });
      const persistedAttempts = await store.attemptsForRun(resumed.runId);
      expect(persistedAttempts).toHaveLength(1);
      const attemptId = persistedAttempts[0]!.attemptId;
      const progress = await store.loadAttemptProgress(attemptId);
      expect(progress).toMatchObject({
        attemptId,
        runId: resumed.runId,
        phase: "terminal",
        lastSafeStep: 1,
        terminalReason: "objective_satisfied",
      } satisfies Partial<ExplorationAttemptProgress>);
      expect(progress?.sourceBindingHash).toMatch(/^[0-9a-f]{64}$/);
      const checkpoints = await store.liveCheckpointsForAttempt(attemptId);
      expect(checkpoints[0]).toMatchObject({ step: 1 });
      expect(checkpoints[0]?.terminalReason).toBeUndefined();
      expect(checkpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({ terminalReason: "objective_satisfied" }) as ExplorationCheckpoint,
      ]));
      expect(persistedAttempts).toEqual([
        expect.objectContaining({
          attemptId,
          findings: [{ defectId: "bug-1", confidence: "high" }],
        }),
      ]);
    });
  });

  it("does not append or score an attempt when terminal progress persistence fails", async () => {
    await withStore(async (store) => {
      const conflicting = new ConflictOnTerminalStore(store);
      await expect(runBenchmark({
        manifest,
        groundTruth,
        scenarios: [scenario],
        store: conflicting,
        agentFactory: createScenarioWalkTestDoubleAgentFactory(),
        createdAt: "2026-08-01T00:00:00.000Z",
      })).rejects.toMatchObject({ code: "BenchmarkAttemptMatrixIncomplete" });

      expect(conflicting.runId).toBeDefined();
      await expect(store.attemptsForRun(conflicting.runId!)).resolves.toEqual([]);
    });
  });

  it("reuses an existing terminal attempt only when matching live progress is present", async () => {
    await withStore(async (store) => {
      const first = await runBenchmark({
        manifest,
        groundTruth,
        scenarios: [scenario],
        store,
        agentFactory: createScenarioWalkTestDoubleAgentFactory(),
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      const firstAttempts = await store.attemptsForRun(first.runId);
      expect(firstAttempts).toHaveLength(1);
      const attemptId = firstAttempts[0]!.attemptId;
      const before = await store.loadAttemptProgress(attemptId);

      const second = await runBenchmark({
        manifest,
        groundTruth,
        scenarios: [scenario],
        store,
        agentFactory: createScenarioWalkTestDoubleAgentFactory(),
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      const after = await store.loadAttemptProgress(attemptId);

      expect(second.report).toEqual(first.report);
      expect(after?.version).toBe(before?.version);
    });
  });
});

async function withStore<T>(callback: (store: SqliteBenchmarkStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-benchmark-runner-"));
  const runtime = await SqliteRuntime.open({
    filename: join(dir, "benchmark.db"),
    busyTimeoutMs: 5_000,
  });
  try {
    return await callback(new SqliteBenchmarkStore(runtime));
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
}
