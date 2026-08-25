import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createScenarioWalkTestDoubleAgentFactory,
  runBenchmark,
  type ScenarioDefinition,
} from "@qualigence/benchmark-runner";
import {
  DEFAULT_DETECTION_THRESHOLDS,
  type DetectionBenchmarkManifest,
  type GroundTruth,
  type ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";
import { SqliteBenchmarkStore, SqliteRuntime } from "@qualigence/sqlite-runtime";

const profile: ReferenceModelProfile = {
  profileId: "sqlite-reference-profile",
  providerId: "openai-compatible",
  modelId: "qualigence-reference-detector-1",
  promptVersion: "prompt/2026-08-01",
  policyBundleSha256: "1".repeat(64),
  skillPackSha256: "2".repeat(64),
  browserVersion: "chromium/fixture",
  fixtureVersions: { checkout: "checkout/1.0.0" },
  maximumSteps: 5,
  maximumWallClockMs: 60_000,
  maximumModelTokens: 10_000,
  repetitions: 2,
};

const manifest: DetectionBenchmarkManifest = {
  schemaVersion: "detection-benchmark/v1",
  benchmarkVersion: "sqlite-benchmark-store-test",
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
  thresholds: DEFAULT_DETECTION_THRESHOLDS,
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

describe("SQLite benchmark store contract", () => {
  it("durably resumes/scans the complete hash-bound attempt matrix without duplicating attempts", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-sqlite-benchmark-contract-"));
    const filename = join(dir, "benchmark.db");
    try {
      const firstRuntime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
      const firstStore = new SqliteBenchmarkStore(firstRuntime);
      const first = await runBenchmark({
        manifest,
        groundTruth,
        scenarios: [scenario],
        agentFactory: createScenarioWalkTestDoubleAgentFactory(),
        store: firstStore,
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      await firstRuntime.close();

      const secondRuntime = await SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
      try {
        const secondStore = new SqliteBenchmarkStore(secondRuntime);
        const second = await runBenchmark({
          manifest,
          groundTruth,
          scenarios: [scenario],
          agentFactory: createScenarioWalkTestDoubleAgentFactory(),
          store: secondStore,
          createdAt: "2026-08-01T00:00:00.000Z",
        });

        const attempts = await secondStore.attemptsForRun(first.runId);
        expect(attempts).toHaveLength(profile.repetitions);
        expect(second.report).toEqual(first.report);
        expect(second.report.profileStatus).toBe("unverified");
        expect(second.report.gate.status).toBe("unverified");
        expect(second.report.inputSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(second.report.attemptBindingSha256s).toHaveLength(profile.repetitions);
        expect(new Set(second.report.attemptBindingSha256s).size).toBe(profile.repetitions);
      } finally {
        await secondRuntime.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
