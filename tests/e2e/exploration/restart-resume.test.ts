import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runBenchmark,
  type BenchmarkStore,
  type ScenarioDefinition,
} from "@qualigence/benchmark-runner";
import {
  groundTruthSha256,
  manifestSha256,
  referenceProfileSha256,
  type DetectionBenchmarkManifest,
  type GroundTruth,
  type ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";
import { SqliteBenchmarkStore, SqliteRuntime } from "@qualigence/sqlite-runtime";

const profile: ReferenceModelProfile = {
  profileId: "restart-resume-profile",
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
  benchmarkVersion: "restart-resume-benchmark",
  referenceProfile: profile,
  scenarios: [{
    scenarioId: "checkout-bug",
    fixtureId: "checkout",
    fixtureVersion: "checkout/1.0.0",
    mode: "fault",
    missionRef: "scenarios/checkout-bug.json",
    groundTruthRef: "ground-truth/checkout.json",
    expectedDefectIds: ["bug-1"],
  }],
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
  defects: [{ scenarioId: "checkout-bug", defectId: "bug-1", severity: "P1", stable: true }],
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

class CrashAfterSafeCheckpointStore implements BenchmarkStore {
  private crashed = false;

  constructor(private readonly delegate: SqliteBenchmarkStore) {}

  saveRun: BenchmarkStore["saveRun"] = (run) => this.delegate.saveRun(run);
  appendAttempt: BenchmarkStore["appendAttempt"] = (runId, attempt) => this.delegate.appendAttempt(runId, attempt);
  attemptsForRun: BenchmarkStore["attemptsForRun"] = (runId) => this.delegate.attemptsForRun(runId);
  saveReport: BenchmarkStore["saveReport"] = (runId, report) => this.delegate.saveReport(runId, report);
  loadAttemptProgress: BenchmarkStore["loadAttemptProgress"] = (attemptId) => this.delegate.loadAttemptProgress(attemptId);
  initializeAttemptProgress: BenchmarkStore["initializeAttemptProgress"] = (progress) => this.delegate.initializeAttemptProgress(progress);
  liveCheckpointsForAttempt: BenchmarkStore["liveCheckpointsForAttempt"] = (attemptId) => this.delegate.liveCheckpointsForAttempt(attemptId);

  compareAndSetAttemptProgress: BenchmarkStore["compareAndSetAttemptProgress"] = async (update) => {
    const result = await this.delegate.compareAndSetAttemptProgress(update);
    if (!this.crashed && update.checkpoint !== undefined && update.checkpoint.terminalReason === undefined) {
      this.crashed = true;
      throw new Error("simulated process interruption after acknowledged safe checkpoint");
    }
    return result;
  };
}

describe("exploration restart/resume acceptance", () => {
  it("resumes from the last durable safe checkpoint after reopening the process store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qualigence-exploration-resume-"));
    const databaseFile = join(dir, "benchmark.db");
    const runId = runIdFor(manifest, profile, groundTruth);
    const attemptId = `${runId}:checkout-bug:1`;
    try {
      const firstRuntime = await SqliteRuntime.open({ filename: databaseFile, busyTimeoutMs: 5_000 });
      try {
        const firstStore = new SqliteBenchmarkStore(firstRuntime);
        await expect(runBenchmark({
          manifest,
          groundTruth,
          scenarios: [scenario],
          store: new CrashAfterSafeCheckpointStore(firstStore),
          createdAt: "2026-08-01T00:00:00.000Z",
        })).rejects.toThrow(/acknowledged safe checkpoint/);
        expect(await firstStore.attemptsForRun(runId)).toEqual([]);
        expect(await firstStore.liveCheckpointsForAttempt(attemptId)).toEqual([
          expect.objectContaining({ step: 1 }),
        ]);
      } finally {
        await firstRuntime.close();
      }

      const secondRuntime = await SqliteRuntime.open({ filename: databaseFile, busyTimeoutMs: 5_000 });
      try {
        const secondStore = new SqliteBenchmarkStore(secondRuntime);
        const resumed = await runBenchmark({
          manifest,
          groundTruth,
          scenarios: [scenario],
          store: secondStore,
          createdAt: "2026-08-01T00:00:00.000Z",
        });

        expect(resumed.exitCode).toBe(0);
        const progress = await secondStore.loadAttemptProgress(attemptId);
        expect(progress).toMatchObject({
          phase: "terminal",
          terminalReason: "objective_satisfied",
          lastSafeStep: 1,
        });
        await expect(secondStore.attemptsForRun(runId)).resolves.toEqual([
          expect.objectContaining({ attemptId, findings: [{ defectId: "bug-1", confidence: "high" }] }),
        ]);
      } finally {
        await secondRuntime.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function runIdFor(
  inputManifest: DetectionBenchmarkManifest,
  inputProfile: ReferenceModelProfile,
  inputTruth: GroundTruth,
): string {
  return createHash("sha256")
    .update(`${manifestSha256(inputManifest)}\u0000${referenceProfileSha256(inputProfile)}\u0000${groundTruthSha256(inputTruth)}`, "utf8")
    .digest("hex");
}
