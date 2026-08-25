import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createScenarioWalkTestDoubleAgentFactory,
  loadBenchmark,
  runBenchmark,
} from "@qualigence/benchmark-runner";
import {
  referenceProfileSha256,
  type ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";
import { SqliteBenchmarkStore, SqliteRuntime } from "@qualigence/sqlite-runtime";

const BENCHMARK_DIR = join(process.cwd(), "benchmarks", "detection-v1");

describe("detection benchmark unverified profile gate", () => {
  it("labels a BYO profile unverified and never marks the release gate passed", async () => {
    const loaded = await loadBenchmark(BENCHMARK_DIR);
    // A BYO profile differs from the frozen reference profile, so its canonical
    // hash cannot match the manifest's Reference Profile fingerprint.
    const byoProfile: ReferenceModelProfile = {
      ...loaded.manifest.referenceProfile,
      profileId: "byo-team-profile",
      modelId: "byo-model-9000",
    };

    const outcome = await withBenchmarkStore(async (store) => runBenchmark({
      manifest: loaded.manifest,
      groundTruth: loaded.groundTruth,
      scenarios: loaded.scenarios,
      profile: byoProfile,
      agentFactory: createScenarioWalkTestDoubleAgentFactory(),
      store,
    }));

    // Even though a BYO run may detect every seeded bug, it can never claim an
    // official Reference-Profile pass — provenance is derived, not asserted.
    expect(outcome.report.profileStatus).toBe("unverified");
    expect(outcome.report.gate.status).toBe("unverified");
    expect(outcome.report.gate.status).not.toBe("passed");
    expect(outcome.exitCode).toBe(1);

    // The detection metrics are still computed and reported for the BYO run.
    expect(outcome.report.metrics.knownBugRecall.value).toBe(1);
    // The report's profile fingerprint is the BYO profile, not the reference.
    expect(outcome.report.profileSha256).not.toBe(
      referenceProfileSha256(loaded.manifest.referenceProfile),
    );
  });

  it("rejects presenting a BYO run as reference by deriving provenance in the scorer", async () => {
    const loaded = await loadBenchmark(BENCHMARK_DIR);
    const byoProfile: ReferenceModelProfile = {
      ...loaded.manifest.referenceProfile,
      promptVersion: "prompt/attacker-edited",
    };

    const outcome = await withBenchmarkStore(async (store) => runBenchmark({
      manifest: loaded.manifest,
      groundTruth: loaded.groundTruth,
      scenarios: loaded.scenarios,
      profile: byoProfile,
      agentFactory: createScenarioWalkTestDoubleAgentFactory(),
      store,
    }));

    // Attempting to run under a tampered profile cannot forge a reference label.
    expect(outcome.report.profileStatus).not.toBe("reference");
    expect(outcome.report.gate.status).not.toBe("passed");
  });
});

async function withBenchmarkStore<T>(
  callback: (store: SqliteBenchmarkStore) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-benchmark-"));
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
