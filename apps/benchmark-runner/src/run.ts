import { createHash } from "node:crypto";
import {
  referenceProfileSha256,
  groundTruthSha256,
  manifestSha256,
  scoreBenchmark,
  BenchmarkError,
  type BenchmarkAttempt,
  type DetectionBenchmarkManifest,
  type DetectionBenchmarkReport,
  type GroundTruth,
  type ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";
import {
  ExplorationController,
  type ExplorationProgressStore,
  type MonotonicClock,
} from "@qualigence/exploration";
import type {
  ExplorationAttemptProgress,
  ExplorationPolicy,
} from "@qualigence/mission";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";
import type {
  BenchmarkRunRecord,
  PersistedAttempt,
} from "@qualigence/sqlite-runtime";
import {
  ScenarioExplorationTarget,
  ScenarioWalkAgent,
  type ScenarioDefinition,
} from "./scenario.js";

/** The durable store the runner writes live progress, attempts and reports through. */
export interface BenchmarkStore extends ExplorationProgressStore {
  saveRun(run: BenchmarkRunRecord): Promise<void>;
  appendAttempt(runId: string, attempt: PersistedAttempt): Promise<void>;
  attemptsForRun(runId: string): Promise<readonly BenchmarkAttempt[]>;
  saveReport(runId: string, report: DetectionBenchmarkReport): Promise<void>;
}

/** The immutable configuration of one benchmark run. */
export interface BenchmarkRunConfig {
  readonly manifest: DetectionBenchmarkManifest;
  readonly groundTruth: GroundTruth;
  readonly scenarios: readonly ScenarioDefinition[];
  /** The profile actually used; defaults to the manifest Reference Profile. */
  readonly profile?: ReferenceModelProfile;
  readonly store: BenchmarkStore;
  readonly createdAt?: string;
}

/** The outcome of a benchmark run: exit code, run id and scored report. */
export interface BenchmarkRunOutcome {
  readonly exitCode: number;
  readonly runId: string;
  readonly report: DetectionBenchmarkReport;
}

/** A monotonic clock frozen at zero so budget accounting stays deterministic. */
const FROZEN_CLOCK: MonotonicClock = { now: () => 0 };

function explorationPolicyFor(
  profile: ReferenceModelProfile,
  scenarios: readonly ScenarioDefinition[],
): ExplorationPolicy {
  return {
    seedSkillBundleIds: [],
    allowedActionKinds: ["navigate", "click", "input"],
    allowedOrigins: allowedOriginsFor(scenarios),
    maximumSteps: profile.maximumSteps,
    maximumWallClockMs: profile.maximumWallClockMs,
    maximumModelTokens: profile.maximumModelTokens,
    maximumStateVisits: profile.maximumSteps,
    maximumRecoveries: 0,
    riskCeiling: "RecoverableMutation",
  };
}

function allowedOriginsFor(scenarios: readonly ScenarioDefinition[]): readonly string[] {
  const origins = new Set<string>();
  for (const scenario of scenarios) {
    for (const state of scenario.states) {
      origins.add(new URL(state.url).origin);
    }
    if (scenario.seedUrl !== undefined) {
      origins.add(new URL(scenario.seedUrl).origin);
    }
  }
  return [...origins].sort();
}

function deriveRunId(manifestHash: string, profileHash: string, truthHash: string): string {
  return createHash("sha256")
    .update(`${manifestHash}\u0000${profileHash}\u0000${truthHash}`, "utf8")
    .digest("hex");
}

function sourceBindingHashFor(input: {
  readonly manifest: DetectionBenchmarkManifest;
  readonly manifestScenario: DetectionBenchmarkManifest["scenarios"][number];
  readonly scenarioDefinition: ScenarioDefinition;
  readonly profileHash: string;
  readonly truthHash: string;
  readonly repetition: number;
}): string {
  return canonicalPayloadHash({
    benchmarkVersion: input.manifest.benchmarkVersion,
    manifestSha256: manifestSha256(input.manifest),
    profileSha256: input.profileHash,
    groundTruthSha256: input.truthHash,
    scenario: input.manifestScenario,
    scenarioDefinition: input.scenarioDefinition,
    repetition: input.repetition,
  });
}

function policyBindingHashFor(policy: ExplorationPolicy): string {
  return canonicalPayloadHash(policy);
}

function seedBindingHashFor(policy: ExplorationPolicy): string {
  return canonicalPayloadHash({
    policySeedSkillBundleIds: policy.seedSkillBundleIds,
    seeds: [],
  });
}

function assertExistingAttemptProgress(input: {
  readonly progress: ExplorationAttemptProgress | undefined;
  readonly attemptId: string;
  readonly runId: string;
  readonly sourceBindingHash: string;
  readonly policy: ExplorationPolicy;
}): void {
  const { progress, attemptId, runId, sourceBindingHash, policy } = input;
  if (progress === undefined) {
    throw new BenchmarkError(
      "BenchmarkAttemptMatrixIncomplete",
      `Benchmark attempt "${attemptId}" has a durable attempt record without live exploration progress.`,
    );
  }
  if (
    progress.runId !== runId ||
    progress.sourceBindingHash !== sourceBindingHash ||
    progress.policyBindingHash !== policyBindingHashFor(policy) ||
    progress.seedBindingHash !== seedBindingHashFor(policy) ||
    progress.phase !== "terminal"
  ) {
    throw new BenchmarkError(
      "BenchmarkAttemptMatrixIncomplete",
      `Benchmark attempt "${attemptId}" does not match its durable exploration progress binding.`,
    );
  }
}

/**
 * Drive real bounded exploration sessions against the manifest's scenario
 * fixtures, score the detection results with the frozen Task-3 scorer and
 * produce a durable, hash-linked report. Every scenario is run at every
 * repetition (no best-run selection); attempts are deterministic, backed by live
 * progress rows, and appended before scoring. The exit code is `0` only when the
 * gate passes — an Unverified or failed run always exits non-zero.
 */
export async function runBenchmark(config: BenchmarkRunConfig): Promise<BenchmarkRunOutcome> {
  const { manifest, groundTruth } = config;
  const profile = config.profile ?? manifest.referenceProfile;
  const profileHash = referenceProfileSha256(profile);
  const manifestHash = manifestSha256(manifest);
  const truthHash = groundTruthSha256(groundTruth);
  const runId = deriveRunId(manifestHash, profileHash, truthHash);
  const createdAt = config.createdAt ?? "1970-01-01T00:00:00.000Z";

  const scenariosById = new Map(config.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const policy = explorationPolicyFor(profile, config.scenarios);

  await config.store.saveRun({
    runId,
    benchmarkVersion: manifest.benchmarkVersion,
    manifestSha256: manifestHash,
    profileSha256: profileHash,
    groundTruthSha256: truthHash,
    createdAt,
  });

  const attempts: BenchmarkAttempt[] = [];
  const persistedAttempts = new Map(
    (await config.store.attemptsForRun(runId)).map((attempt) => [attempt.attemptId, attempt]),
  );
  for (const scenario of manifest.scenarios) {
    const definition = scenariosById.get(scenario.scenarioId);
    if (definition === undefined) {
      throw new BenchmarkError(
        "BenchmarkManifestInvalid",
        `No scenario fixture supplied for manifest scenario "${scenario.scenarioId}".`,
      );
    }
    for (let repetition = 1; repetition <= profile.repetitions; repetition += 1) {
      const attemptId = `${runId}:${scenario.scenarioId}:${repetition}`;
      const existingAttempt = persistedAttempts.get(attemptId);
      const sourceBindingHash = sourceBindingHashFor({
        manifest,
        manifestScenario: scenario,
        scenarioDefinition: definition,
        profileHash,
        truthHash,
        repetition,
      });
      const progress = await config.store.loadAttemptProgress(attemptId);
      if (existingAttempt !== undefined) {
        assertExistingAttemptProgress({
          progress,
          attemptId,
          runId,
          sourceBindingHash,
          policy,
        });
        attempts.push(existingAttempt);
        continue;
      }
      if (progress?.phase === "terminal") {
        throw new BenchmarkError(
          "BenchmarkAttemptMatrixIncomplete",
          `Benchmark attempt "${attemptId}" reached terminal progress but has no durable attempt record.`,
        );
      }

      const target = new ScenarioExplorationTarget(definition, progress?.lastSafeStep ?? 0);
      const controller = new ExplorationController({
        target,
        agent: new ScenarioWalkAgent(),
        progressStore: config.store,
        clock: FROZEN_CLOCK,
      });
      const result = await controller.run({
        runId,
        attemptId,
        sourceBindingHash,
        policy,
        environment: "test",
      });
      const findings = target.collectFindings().map((signal) => ({
        defectId: signal.defectId,
        confidence: signal.confidence,
      }));
      const attempt: BenchmarkAttempt = {
        attemptId,
        profileSha256: profileHash,
        scenarioId: scenario.scenarioId,
        mode: scenario.mode,
        repetition,
        findings,
      };
      attempts.push(attempt);

      const persisted: PersistedAttempt = {
        attempt,
        terminalReason: result.terminalReason,
        checkpoints: result.checkpoints,
        createdAt,
      };
      await config.store.appendAttempt(runId, persisted);
    }
  }

  const report = scoreBenchmark(manifest, attempts, groundTruth, { createdAt });

  await config.store.saveReport(runId, report);

  const exitCode = report.gate.status === "passed" ? 0 : 1;
  return { exitCode, runId, report };
}
