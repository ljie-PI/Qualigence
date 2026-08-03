import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadBenchmark,
  runBenchmark,
  type ScenarioDefinition,
} from "@qualigence/benchmark-runner";
import {
  type DetectionBenchmarkManifest,
  type GroundTruth,
  type GroundTruthDefect,
  type ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";
import { SqliteBenchmarkStore, SqliteRuntime } from "@qualigence/sqlite-runtime";

const BENCHMARK_DIR = join(process.cwd(), "benchmarks", "detection-v1");

describe("detection benchmark reference profile gate", () => {
  it("passes the release gate for the frozen reference profile against the known-good fixtures", async () => {
    const loaded = await loadBenchmark(BENCHMARK_DIR);

    const outcome = await runBenchmark({
      manifest: loaded.manifest,
      groundTruth: loaded.groundTruth,
      scenarios: loaded.scenarios,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.profileStatus).toBe("reference");
    expect(outcome.report.gate.status).toBe("passed");
    expect(outcome.report.gate.failureCodes).toEqual([]);

    // All five frozen reference thresholds are met.
    expect(outcome.report.metrics.p0Recall.value).toBe(1);
    expect(outcome.report.metrics.knownBugRecall.value).toBe(1);
    expect(outcome.report.metrics.findingPrecision.value).toBe(1);
    expect(outcome.report.metrics.stableReproductionRate.value).toBe(1);
    for (const count of Object.values(
      outcome.report.metrics.highConfidenceFalsePositivesByNormalMission,
    )) {
      expect(count).toBeLessThanOrEqual(1);
    }
  });

  it("scores deterministically: identical inputs produce identical reports", async () => {
    const loaded = await loadBenchmark(BENCHMARK_DIR);
    const config = {
      manifest: loaded.manifest,
      groundTruth: loaded.groundTruth,
      scenarios: loaded.scenarios,
      createdAt: "2026-08-01T00:00:00.000Z",
    };

    const first = await runBenchmark(config);
    const second = await runBenchmark(config);

    expect(second.report).toEqual(first.report);
  });

  it("fails the gate with KnownBugRecallBelowMinimum when the reference profile misses seeded bugs", async () => {
    // A fixture that surfaces only 3 of 5 seeded defects: even at full budget the
    // reference profile cannot detect the two silent bugs, so recall falls below
    // the frozen 0.8 minimum. The profile still matches the manifest reference,
    // so the run is scored as `reference` and the gate genuinely fails.
    const profile = referenceProfile({ profileId: "reference-below-recall" });
    const manifest: DetectionBenchmarkManifest = {
      schemaVersion: "detection-benchmark/v1",
      benchmarkVersion: "below-recall",
      referenceProfile: profile,
      scenarios: [
        {
          scenarioId: "cart-known-bugs",
          fixtureId: "cart",
          fixtureVersion: "cart/1.0.0",
          mode: "fault",
          missionRef: "scenarios/cart-known-bugs.json",
          groundTruthRef: "ground-truth/cart.json",
          expectedDefectIds: ["d1", "d2", "d3", "d4", "d5"],
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
      benchmarkVersion: "below-recall",
      defects: [
        defect("cart-known-bugs", "d1", { severity: "P1" }),
        defect("cart-known-bugs", "d2"),
        defect("cart-known-bugs", "d3"),
        defect("cart-known-bugs", "d4"),
        defect("cart-known-bugs", "d5"),
      ],
    };
    // The fixture only surfaces d1, d2 and d3 — d4 and d5 have no observable signal.
    const scenario: ScenarioDefinition = {
      scenarioId: "cart-known-bugs",
      mode: "fault",
      seedUrl: "https://shop.fixture.local/a",
      states: [
        {
          id: "a",
          url: "https://shop.fixture.local/a",
          title: "A",
          nodes: [
            { id: "a-defect", role: "text", text: "bug one", confidence: 1 },
            { id: "go-b", role: "link", name: "next", confidence: 1 },
          ],
          advanceNodeId: "go-b",
          signals: [{ defectId: "d1", confidence: "high" }],
        },
        {
          id: "b",
          url: "https://shop.fixture.local/b",
          title: "B",
          nodes: [
            { id: "b-defect", role: "text", text: "bug two", confidence: 1 },
            { id: "go-c", role: "link", name: "next", confidence: 1 },
          ],
          advanceNodeId: "go-c",
          signals: [{ defectId: "d2", confidence: "high" }],
        },
        {
          id: "c",
          url: "https://shop.fixture.local/c",
          title: "C",
          nodes: [{ id: "c-defect", role: "text", text: "bug three", confidence: 1 }],
          advanceNodeId: null,
          signals: [{ defectId: "d3", confidence: "high" }],
        },
      ],
    };

    const outcome = await runBenchmark({ manifest, groundTruth, scenarios: [scenario] });

    expect(outcome.report.profileStatus).toBe("reference");
    expect(outcome.report.gate.status).toBe("failed");
    expect(outcome.report.gate.failureCodes).toContain("KnownBugRecallBelowMinimum");
    expect(outcome.report.metrics.knownBugRecall.value).toBeCloseTo(0.6, 5);
    expect(outcome.exitCode).toBe(1);
  });

  it("persists the run, append-only attempts and hash-linked report durably", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-benchmark-"));
    const filename = join(dir, "benchmark.db");
    try {
      const loaded = await loadBenchmark(BENCHMARK_DIR);
      const runtime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
      const store = new SqliteBenchmarkStore(runtime);

      const outcome = await runBenchmark({
        manifest: loaded.manifest,
        groundTruth: loaded.groundTruth,
        scenarios: loaded.scenarios,
        store,
      });
      await runtime.close();

      // Re-open the database and confirm every attempt and the report survive.
      const reopened = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
      const reopenedStore = new SqliteBenchmarkStore(reopened);
      const attempts = await reopenedStore.attemptsForRun(outcome.runId);
      const expectedAttempts =
        loaded.manifest.scenarios.length * loaded.manifest.referenceProfile.repetitions;
      expect(attempts).toHaveLength(expectedAttempts);

      const storedReport = await reopenedStore.reportForRun(outcome.runId);
      expect(storedReport?.reportId).toBe(outcome.report.reportId);
      expect(storedReport?.profileStatus).toBe("reference");
      await reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function referenceProfile(overrides: Partial<ReferenceModelProfile> = {}): ReferenceModelProfile {
  return {
    profileId: "detection-reference-v1",
    providerId: "qualigence-deterministic",
    modelId: "qualigence-reference-detector-1",
    promptVersion: "prompt/2026-08-01",
    policyBundleSha256: "1".repeat(64),
    skillPackSha256: "2".repeat(64),
    browserVersion: "deterministic-target/1.0.0",
    fixtureVersions: { cart: "cart/1.0.0" },
    maximumSteps: 40,
    maximumWallClockMs: 1_800_000,
    maximumModelTokens: 200_000,
    repetitions: 2,
    ...overrides,
  };
}

function defect(
  scenarioId: string,
  defectId: string,
  overrides: Partial<GroundTruthDefect> = {},
): GroundTruthDefect {
  return { scenarioId, defectId, severity: "P1", stable: true, ...overrides };
}
