import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioDefinition } from "@qualigence/benchmark-runner";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
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
  defects: [{ scenarioId: "checkout-bug", defectId: "bug-1", severity: "P0", stable: true }],
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

describe("exploration restart/resume acceptance", () => {
  it("resumes from the last durable safe checkpoint after a benchmark process exits", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".tmp-exploration-resume-"));
    const databaseFile = join(dir, "benchmark.db");
    const scriptFile = join(dir, "restart-child.mjs");
    const runId = runIdFor(manifest, profile, groundTruth, [scenario]);
    const attemptId = attemptIdFor(manifest, profile, groundTruth, [scenario], "checkout-bug", 1);
    try {
      await writeFile(scriptFile, childScript(), "utf8");

      const interrupted = await runChild(scriptFile, databaseFile, "crash");
      expect(interrupted.code).toBe(42);
      expect(interrupted.stderr).toContain("simulated process interruption after acknowledged safe checkpoint");

      let runtime = await SqliteRuntime.open({ filename: databaseFile, busyTimeoutMs: 5_000 });
      try {
        const store = new SqliteBenchmarkStore(runtime);
        expect(await store.attemptsForRun(runId)).toEqual([]);
        expect(await store.liveCheckpointsForAttempt(attemptId)).toEqual([
          expect.objectContaining({ step: 1 }),
        ]);
      } finally {
        await runtime.close();
      }

      const resumed = await runChild(scriptFile, databaseFile, "resume");
      expect(resumed).toMatchObject({ code: 0 });
      expect(resumed.stdout).toContain("resume-ok");

      runtime = await SqliteRuntime.open({ filename: databaseFile, busyTimeoutMs: 5_000 });
      try {
        const store = new SqliteBenchmarkStore(runtime);
        const progress = await store.loadAttemptProgress(attemptId);
        expect(progress).toMatchObject({
          phase: "terminal",
          terminalReason: "objective_satisfied",
          lastSafeStep: 1,
        });
        await expect(store.attemptsForRun(runId)).resolves.toEqual([
          expect.objectContaining({ attemptId, findings: [{ defectId: "bug-1", confidence: "high" }] }),
        ]);
      } finally {
        await runtime.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function runChild(
  scriptFile: string,
  databaseFile: string,
  mode: "crash" | "resume",
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptFile, databaseFile, mode], {
      cwd: process.cwd(),
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function childScript(): string {
  return `
import { createScenarioWalkTestDoubleAgentFactory, runBenchmark } from ${JSON.stringify("@qualigence/benchmark-runner")};
import { SqliteBenchmarkStore, SqliteRuntime } from ${JSON.stringify("@qualigence/sqlite-runtime")};
const manifest = ${JSON.stringify(manifest)};
const groundTruth = ${JSON.stringify(groundTruth)};
const scenarios = ${JSON.stringify([scenario])};
class CrashAfterSafeCheckpointStore {
  crashed = false;
  constructor(delegate) { this.delegate = delegate; }
  saveRun(run) { return this.delegate.saveRun(run); }
  appendAttempt(runId, attempt) { return this.delegate.appendAttempt(runId, attempt); }
  attemptsForRun(runId) { return this.delegate.attemptsForRun(runId); }
  saveReport(runId, report) { return this.delegate.saveReport(runId, report); }
  loadAttemptProgress(attemptId) { return this.delegate.loadAttemptProgress(attemptId); }
  initializeAttemptProgress(progress) { return this.delegate.initializeAttemptProgress(progress); }
  liveCheckpointsForAttempt(attemptId) { return this.delegate.liveCheckpointsForAttempt(attemptId); }
  async compareAndSetAttemptProgress(update) {
    const result = await this.delegate.compareAndSetAttemptProgress(update);
    if (!this.crashed && update.checkpoint !== undefined && update.checkpoint.terminalReason === undefined) {
      this.crashed = true;
      throw new Error("simulated process interruption after acknowledged safe checkpoint");
    }
    return result;
  }
}
const [, , databaseFile, mode] = process.argv;
const runtime = await SqliteRuntime.open({ filename: databaseFile, busyTimeoutMs: 5000 });
try {
  const store = new SqliteBenchmarkStore(runtime);
  await runBenchmark({
    manifest,
    groundTruth,
    scenarios,
    agentFactory: createScenarioWalkTestDoubleAgentFactory(),
    store: mode === "crash" ? new CrashAfterSafeCheckpointStore(store) : store,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  console.log(mode === "crash" ? "unexpected-success" : "resume-ok");
  process.exitCode = mode === "crash" ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = mode === "crash" ? 42 : 1;
} finally {
  await runtime.close();
}
`;
}

function runIdFor(
  inputManifest: DetectionBenchmarkManifest,
  inputProfile: ReferenceModelProfile,
  inputTruth: GroundTruth,
  inputScenarios: readonly ScenarioDefinition[],
): string {
  const bindings = runBindings(inputManifest, inputProfile, inputTruth, inputScenarios);
  return createHash("sha256").update(bindings.inputSha256, "utf8").digest("hex");
}

function attemptIdFor(
  inputManifest: DetectionBenchmarkManifest,
  inputProfile: ReferenceModelProfile,
  inputTruth: GroundTruth,
  inputScenarios: readonly ScenarioDefinition[],
  scenarioId: string,
  repetition: number,
): string {
  const bindings = runBindings(inputManifest, inputProfile, inputTruth, inputScenarios);
  const manifestScenario = inputManifest.scenarios.find((entry) => entry.scenarioId === scenarioId);
  const scenarioDefinition = inputScenarios.find((entry) => entry.scenarioId === scenarioId);
  if (manifestScenario === undefined || scenarioDefinition === undefined) {
    throw new Error(`Unknown scenario ${scenarioId}`);
  }
  const sourceBindingHash = canonicalPayloadHash({
    benchmarkVersion: inputManifest.benchmarkVersion,
    manifestSha256: manifestSha256(inputManifest),
    profileSha256: bindings.profileHash,
    groundTruthSha256: groundTruthSha256(inputTruth),
    scenario: manifestScenario,
    scenarioDefinition,
    repetition,
  });
  const attemptBindingHash = canonicalPayloadHash({
    runId: bindings.runId,
    sourceBindingHash,
    policyBindingHash: bindings.policyBindingHash,
    seedBindingHash: bindings.seedBindingHash,
    scenarioId,
    repetition,
  });
  return `${bindings.runId}:${attemptBindingHash}`;
}

function runBindings(
  inputManifest: DetectionBenchmarkManifest,
  inputProfile: ReferenceModelProfile,
  inputTruth: GroundTruth,
  inputScenarios: readonly ScenarioDefinition[],
): {
  readonly inputSha256: string;
  readonly runId: string;
  readonly profileHash: string;
  readonly policyBindingHash: string;
  readonly seedBindingHash: string;
} {
  const actualProfile = {
    ...inputProfile,
    profileId: `${inputProfile.profileId}:edit-time-test-double`,
    providerId: "qualigence-edit-time-test-double",
    modelId: "scenario-walk-agent",
    promptVersion: `${inputProfile.promptVersion}:scenario-walk-agent`,
  };
  const policy = {
    seedSkillBundleIds: [],
    allowedActionKinds: ["navigate", "click", "input"],
    allowedOrigins: allowedOriginsFor(inputScenarios),
    maximumSteps: inputProfile.maximumSteps,
    maximumWallClockMs: inputProfile.maximumWallClockMs,
    maximumModelTokens: inputProfile.maximumModelTokens,
    maximumStateVisits: inputProfile.maximumSteps,
    maximumRecoveries: 0,
    riskCeiling: "RecoverableMutation",
  };
  const policyBindingHash = canonicalPayloadHash(policy);
  const seedBindingHash = canonicalPayloadHash({
    policySeedSkillBundleIds: policy.seedSkillBundleIds,
    seeds: [],
  });
  const profileHash = referenceProfileSha256(actualProfile);
  const inputSha256 = canonicalPayloadHash({
    manifestSha256: manifestSha256(inputManifest),
    profileSha256: profileHash,
    groundTruthSha256: groundTruthSha256(inputTruth),
    policyBindingHash,
    seedBindingHash,
    scenarioDefinitions: inputScenarios,
  });
  const runId = createHash("sha256").update(inputSha256, "utf8").digest("hex");
  return { inputSha256, runId, profileHash, policyBindingHash, seedBindingHash };
}

function allowedOriginsFor(inputScenarios: readonly ScenarioDefinition[]): readonly string[] {
  const origins = new Set<string>();
  for (const inputScenario of inputScenarios) {
    for (const state of inputScenario.states) {
      origins.add(new URL(state.url).origin);
    }
    if (inputScenario.seedUrl !== undefined) {
      origins.add(new URL(inputScenario.seedUrl).origin);
    }
  }
  return [...origins].sort();
}
