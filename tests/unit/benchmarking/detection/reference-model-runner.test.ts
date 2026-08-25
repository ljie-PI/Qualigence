import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createReferenceModelAgentFactory,
  createScenarioWalkTestDoubleAgentFactory,
  runBenchmark,
  type BenchmarkAgentFactory,
  type BenchmarkStore,
  type ScenarioDefinition,
} from "@qualigence/benchmark-runner";
import {
  DEFAULT_DETECTION_THRESHOLDS,
  type DetectionBenchmarkManifest,
  type GroundTruth,
  type ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";
import { SqliteBenchmarkStore, SqliteRuntime } from "@qualigence/sqlite-runtime";

const referenceProfile: ReferenceModelProfile = {
  profileId: "reference-test-profile",
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
  repetitions: 1,
};

const manifest: DetectionBenchmarkManifest = {
  schemaVersion: "detection-benchmark/v1",
  benchmarkVersion: "reference-agent-test",
  referenceProfile,
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
    { scenarioId: "checkout-bug", defectId: "bug-1", severity: "P0", stable: true },
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

describe("Detection Benchmark Reference Model runner", () => {
  it("rejects missing real provider credentials when constructing the Reference Model agent", () => {
    expect(() => createReferenceModelAgentFactory(referenceProfile, {})).toThrow(
      /Reference Model provider credentials are unavailable/,
    );
  });

  it("does not fall back to the deterministic ScenarioWalkAgent when no model-agent factory is provided", async () => {
    await withStore(async (store) => {
      await expect(runBenchmark({
        manifest,
        groundTruth,
        scenarios: [scenario],
        store,
        createdAt: "2026-08-01T00:00:00.000Z",
      })).rejects.toMatchObject({ code: "ReferenceProfileMismatch" });
    });
  });

  it("rejects manifest/Ground Truth mismatch before run, attempt, fixture or provider effects", async () => {
    const effects: string[] = [];
    const mismatchedTruth: GroundTruth = { benchmarkVersion: manifest.benchmarkVersion, defects: [] };
    const store: BenchmarkStore = {
      async saveRun() {
        effects.push("saveRun");
      },
      async appendAttempt() {
        effects.push("appendAttempt");
      },
      async attemptsForRun() {
        effects.push("attemptsForRun");
        return [];
      },
      async saveReport() {
        effects.push("saveReport");
      },
      async loadAttemptProgress() {
        effects.push("loadAttemptProgress");
        return undefined;
      },
      async initializeAttemptProgress(progress) {
        effects.push("initializeAttemptProgress");
        return {
          ...progress,
          version: 1,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
      },
      async compareAndSetAttemptProgress() {
        effects.push("compareAndSetAttemptProgress");
        return { status: "conflict" };
      },
      async liveCheckpointsForAttempt() {
        effects.push("liveCheckpointsForAttempt");
        return [];
      },
    };
    const agentFactory: BenchmarkAgentFactory = {
      provenance: "model-provider",
      createAgent() {
        effects.push("createAgent");
        return {
          async nextAction() {
            effects.push("nextAction");
            return { decision: { status: "stop", reason: "not reached" }, tokensUsed: 1 };
          },
        };
      },
    };

    await expect(runBenchmark({
      manifest,
      groundTruth: mismatchedTruth,
      scenarios: [scenario],
      agentFactory,
      store,
      createdAt: "2026-08-01T00:00:00.000Z",
    })).rejects.toMatchObject({
      code: "GroundTruthMismatch",
      message: expect.stringContaining("missing from Ground Truth: bug-1"),
    });
    expect(effects).toEqual([]);
  });

  it("runs every repetition through the configured model-agent seam", async () => {
    await withStore(async (store) => {
      const repeatedManifest = {
        ...manifest,
        referenceProfile: { ...manifest.referenceProfile, repetitions: 2 },
      };
      const invocations: string[] = [];
      const modelProviderAgentFactory: BenchmarkAgentFactory = {
        provenance: "model-provider",
        createAgent: (input) => ({
          async nextAction(context) {
            invocations.push(`${input.profile.providerId}:${input.profile.modelId}:${input.repetition}:${context.graph.graphId}`);
            const link = context.graph.nodes.find((node) => node.role === "link");
            if (link === undefined) {
              return { decision: { status: "stop", reason: "done" }, tokensUsed: 1 };
            }
            return {
              decision: {
                status: "act",
                action: { kind: "click", nodeId: link.id, reason: "advance" },
                reason: "advance",
              },
              tokensUsed: 1,
            };
          },
        }),
      };

      const outcome = await runBenchmark({
        manifest: repeatedManifest,
        groundTruth,
        scenarios: [scenario],
        agentFactory: modelProviderAgentFactory,
        store,
        createdAt: "2026-08-01T00:00:00.000Z",
      });

      expect(outcome.exitCode).toBe(0);
      expect(outcome.report.profileStatus).toBe("reference");
      expect(outcome.report.gate.status).toBe("passed");
      expect(outcome.report.attemptIds).toHaveLength(2);
      expect(invocations).toContain("openai-compatible:qualigence-reference-detector-1:1:checkout-bug:product");
      expect(invocations).toContain("openai-compatible:qualigence-reference-detector-1:2:checkout-bug:product");
    });
  });

  it("forces the explicit ScenarioWalkAgent edit-time test double to produce only an unverified report", async () => {
    await withStore(async (store) => {
      const outcome = await runBenchmark({
        manifest,
        groundTruth,
        scenarios: [scenario],
        agentFactory: createScenarioWalkTestDoubleAgentFactory(),
        store,
        createdAt: "2026-08-01T00:00:00.000Z",
      });

      expect(outcome.exitCode).toBe(1);
      expect(outcome.report.profileStatus).toBe("unverified");
      expect(outcome.report.gate.status).toBe("unverified");
      expect(outcome.report.gate.status).not.toBe("passed");
      expect(outcome.report.inputSha256).toMatch(/^[0-9a-f]{64}$/);
      const [attemptBindingSha256] = outcome.report.attemptBindingSha256s;
      const [attemptId] = outcome.report.attemptIds;
      expect(attemptBindingSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(attemptId).toContain(attemptBindingSha256);
    });
  });
});

async function withStore<T>(callback: (store: SqliteBenchmarkStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-reference-runner-"));
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
