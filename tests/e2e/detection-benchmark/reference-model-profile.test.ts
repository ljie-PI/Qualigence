import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createReferenceModelAgentFactory,
  loadBenchmark,
  runBenchmark,
} from "@qualigence/benchmark-runner";
import { SqliteBenchmarkStore, SqliteRuntime } from "@qualigence/sqlite-runtime";

const BENCHMARK_DIR = join(process.cwd(), "benchmarks", "detection-v1");

describe("real Detection Benchmark Reference Model Profile acceptance", () => {
  it("runs every scenario/repetition with the configured real provider and persists a verified report", { timeout: 1_900_000 }, async () => {
    const loaded = await loadBenchmark(BENCHMARK_DIR);
    const dir = await mkdtemp(join(process.cwd(), ".tmp-reference-model-profile-"));
    const runtime = await SqliteRuntime.open({
      filename: join(dir, "benchmark.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      const store = new SqliteBenchmarkStore(runtime);
      const outcome = await runBenchmark({
        manifest: loaded.manifest,
        groundTruth: loaded.groundTruth,
        scenarios: loaded.scenarios,
        agentFactory: createReferenceModelAgentFactory(loaded.manifest.referenceProfile),
        store,
        createdAt: "2026-08-01T00:00:00.000Z",
      });

      const expectedAttempts = loaded.manifest.scenarios.length * loaded.manifest.referenceProfile.repetitions;
      const persistedAttempts = await store.attemptsForRun(outcome.runId);
      const persistedReport = await store.reportForRun(outcome.runId);

      expect(persistedAttempts).toHaveLength(expectedAttempts);
      expect(outcome.report.attemptIds).toHaveLength(expectedAttempts);
      expect(outcome.report.attemptBindingSha256s).toHaveLength(expectedAttempts);
      expect(new Set(outcome.report.attemptIds).size).toBe(expectedAttempts);
      expect(new Set(outcome.report.attemptBindingSha256s).size).toBe(expectedAttempts);
      expect(outcome.report.profileStatus).toBe("reference");
      expect(outcome.report.gate.status).toBe("passed");
      expect(outcome.report.gate.failureCodes).toEqual([]);
      expect(outcome.report.metrics.p0Recall.value).toBe(1);
      expect(outcome.report.metrics.knownBugRecall.value).toBeGreaterThanOrEqual(0.8);
      expect(outcome.report.metrics.findingPrecision.value).toBeGreaterThanOrEqual(0.6);
      expect(outcome.report.metrics.stableReproductionRate.value).toBeGreaterThanOrEqual(0.7);
      for (const count of Object.values(outcome.report.metrics.highConfidenceFalsePositivesByNormalMission)) {
        expect(count).toBeLessThanOrEqual(1);
      }
      expect(persistedReport).toEqual(outcome.report);
      expect(outcome.exitCode).toBe(0);
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
