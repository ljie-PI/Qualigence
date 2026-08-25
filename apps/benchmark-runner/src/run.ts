import { createHash } from "node:crypto";
import {
  referenceProfileSha256,
  groundTruthSha256,
  manifestSha256,
  scoreBenchmark,
  BenchmarkError,
  assertGroundTruthConsistent,
  type BenchmarkAttempt,
  type DetectionBenchmarkManifest,
  type DetectionBenchmarkReport,
  type GroundTruth,
  type ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";
import {
  ExplorationController,
  type ExplorationAgentPort,
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
  reportForRun?(runId: string): Promise<DetectionBenchmarkReport | undefined>;
}

export type BenchmarkAgentProvenance = "model-provider" | "edit-time-test-double";

/** Context supplied when constructing the proposer for one benchmark attempt. */
export interface BenchmarkAgentInput {
  readonly manifest: DetectionBenchmarkManifest;
  readonly profile: ReferenceModelProfile;
  readonly scenario: DetectionBenchmarkManifest["scenarios"][number];
  readonly scenarioDefinition: ScenarioDefinition;
  readonly repetition: number;
  readonly runId: string;
  readonly attemptId: string;
  readonly sourceBindingHash: string;
  readonly policyBindingHash: string;
  readonly seedBindingHash: string;
}

/**
 * The only approved seam for benchmark exploration proposals. Release runs use
 * `model-provider`; deterministic walkers must be explicitly injected as an
 * `edit-time-test-double`, which forces the run/report to remain unverified.
 */
export interface BenchmarkAgentFactory {
  readonly provenance: BenchmarkAgentProvenance;
  createAgent(input: BenchmarkAgentInput): ExplorationAgentPort;
}

/** The immutable configuration of one benchmark run. */
export interface BenchmarkRunConfig {
  readonly manifest: DetectionBenchmarkManifest;
  readonly groundTruth: GroundTruth;
  readonly scenarios: readonly ScenarioDefinition[];
  /** The profile actually used; defaults to the manifest Reference Profile. */
  readonly profile?: ReferenceModelProfile;
  /** Explicit source of exploration proposals; there is no release fallback. */
  readonly agentFactory?: BenchmarkAgentFactory;
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

function deriveRunId(inputSha256: string): string {
  return createHash("sha256")
    .update(inputSha256, "utf8")
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

function assertFixtureVersionBound(
  profile: ReferenceModelProfile,
  scenario: DetectionBenchmarkManifest["scenarios"][number],
): void {
  const profileFixtureVersion = profile.fixtureVersions[scenario.fixtureId];
  if (profileFixtureVersion !== scenario.fixtureVersion) {
    throw new BenchmarkError(
      "BenchmarkManifestInvalid",
      `Scenario "${scenario.scenarioId}" fixture "${scenario.fixtureId}" version "${scenario.fixtureVersion}" ` +
        `does not match Reference Profile fixture version "${profileFixtureVersion ?? "<missing>"}".`,
    );
  }
}

function inputBindingHashFor(input: {
  readonly manifestHash: string;
  readonly profileHash: string;
  readonly truthHash: string;
  readonly policyBindingHash: string;
  readonly seedBindingHash: string;
  readonly scenarios: readonly ScenarioDefinition[];
}): string {
  return canonicalPayloadHash({
    manifestSha256: input.manifestHash,
    profileSha256: input.profileHash,
    groundTruthSha256: input.truthHash,
    policyBindingHash: input.policyBindingHash,
    seedBindingHash: input.seedBindingHash,
    scenarioDefinitions: input.scenarios,
  });
}

function attemptBindingHashFor(input: {
  readonly runId: string;
  readonly sourceBindingHash: string;
  readonly policyBindingHash: string;
  readonly seedBindingHash: string;
  readonly scenarioId: string;
  readonly repetition: number;
}): string {
  return canonicalPayloadHash(input);
}

function attemptIdFor(runId: string, attemptBindingHash: string): string {
  return `${runId}:${attemptBindingHash}`;
}

function profileForProvenance(
  profile: ReferenceModelProfile,
  agentFactory: BenchmarkAgentFactory,
): ReferenceModelProfile {
  if (agentFactory.provenance === "model-provider") {
    return profile;
  }
  return {
    ...profile,
    profileId: `${profile.profileId}:edit-time-test-double`,
    providerId: "qualigence-edit-time-test-double",
    modelId: "scenario-walk-agent",
    promptVersion: `${profile.promptVersion}:scenario-walk-agent`,
  };
}

function requireAgentFactory(agentFactory: BenchmarkAgentFactory | undefined): BenchmarkAgentFactory {
  if (agentFactory === undefined) {
    throw new BenchmarkError(
      "ReferenceProfileMismatch",
      "Detection Benchmark release runs require an explicit model-provider agent factory; " +
        "ScenarioWalkAgent is only allowed as an injected edit-time test double and can never produce a verified Reference Profile report.",
    );
  }
  return agentFactory;
}

function assertExistingAttemptProgress(input: {
  readonly progress: ExplorationAttemptProgress | undefined;
  readonly attemptId: string;
  readonly runId: string;
  readonly sourceBindingHash: string;
  readonly policyBindingHash: string;
  readonly seedBindingHash: string;
}): void {
  const {
    progress,
    attemptId,
    runId,
    sourceBindingHash,
    policyBindingHash,
    seedBindingHash,
  } = input;
  if (progress === undefined) {
    throw new BenchmarkError(
      "BenchmarkAttemptMatrixIncomplete",
      `Benchmark attempt "${attemptId}" has a durable attempt record without live exploration progress.`,
    );
  }
  if (
    progress.runId !== runId ||
    progress.sourceBindingHash !== sourceBindingHash ||
    progress.policyBindingHash !== policyBindingHash ||
    progress.seedBindingHash !== seedBindingHash ||
    progress.phase !== "terminal" ||
    progress.terminalReason === "error"
  ) {
    throw new BenchmarkError(
      "BenchmarkAttemptMatrixIncomplete",
      `Benchmark attempt "${attemptId}" does not match its durable exploration progress binding.`,
    );
  }
}

function assertPersistedAttemptMatches(
  persisted: BenchmarkAttempt | undefined,
  expected: BenchmarkAttempt,
): BenchmarkAttempt {
  if (persisted === undefined) {
    throw new BenchmarkError(
      "BenchmarkAttemptMatrixIncomplete",
      `Benchmark attempt "${expected.attemptId}" was not durably persisted after execution.`,
    );
  }
  if (
    persisted.profileSha256 !== expected.profileSha256 ||
    persisted.scenarioId !== expected.scenarioId ||
    persisted.mode !== expected.mode ||
    persisted.repetition !== expected.repetition ||
    canonicalPayloadHash(persisted.findings) !== canonicalPayloadHash(expected.findings)
  ) {
    throw new BenchmarkError(
      "BenchmarkAttemptMatrixIncomplete",
      `Benchmark attempt "${expected.attemptId}" conflicts with the durable store binding.`,
    );
  }
  return persisted;
}

function assertNoUnexpectedPersistedAttempts(
  persistedAttempts: ReadonlyMap<string, BenchmarkAttempt>,
  expectedAttemptIds: ReadonlySet<string>,
): void {
  for (const attemptId of persistedAttempts.keys()) {
    if (!expectedAttemptIds.has(attemptId)) {
      throw new BenchmarkError(
        "BenchmarkAttemptMatrixIncomplete",
        `Benchmark run contains unexpected attempt "${attemptId}" outside the manifest scenario/repetition matrix.`,
      );
    }
  }
}

function assertReportMatches(
  persisted: DetectionBenchmarkReport | undefined,
  expected: DetectionBenchmarkReport,
): DetectionBenchmarkReport {
  if (persisted === undefined) {
    throw new BenchmarkError(
      "BenchmarkAttemptMatrixIncomplete",
      `Benchmark report "${expected.reportId}" was not durably persisted after scoring.`,
    );
  }
  if (
    persisted.reportId !== expected.reportId ||
    persisted.manifestSha256 !== expected.manifestSha256 ||
    persisted.profileSha256 !== expected.profileSha256 ||
    persisted.groundTruthSha256 !== expected.groundTruthSha256 ||
    persisted.inputSha256 !== expected.inputSha256
  ) {
    throw new BenchmarkError(
      "BenchmarkAttemptMatrixIncomplete",
      `Benchmark run already has a conflicting durable report for "${expected.reportId}".`,
    );
  }
  return persisted;
}

interface AttemptPlan {
  readonly scenario: DetectionBenchmarkManifest["scenarios"][number];
  readonly definition: ScenarioDefinition;
  readonly repetition: number;
  readonly sourceBindingHash: string;
  readonly attemptBindingHash: string;
  readonly attemptId: string;
}

function attemptMap(attempts: readonly BenchmarkAttempt[]): Map<string, BenchmarkAttempt> {
  return new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
}

/** Explicit edit-time test double for focused tests; never yields a reference profile hash. */
export function createScenarioWalkTestDoubleAgentFactory(): BenchmarkAgentFactory {
  return {
    provenance: "edit-time-test-double",
    createAgent: () => new ScenarioWalkAgent(),
  };
}

/**
 * Drive bounded exploration sessions against the manifest's scenario fixtures,
 * score the detection results with the frozen scorer and produce a durable,
 * hash-linked report. Every release attempt must be proposed by the explicit
 * model-provider/agent seam; deterministic walkers are allowed only as injected
 * edit-time doubles and are forced to `unverified` provenance.
 */
export async function runBenchmark(config: BenchmarkRunConfig): Promise<BenchmarkRunOutcome> {
  const { manifest, groundTruth } = config;
  assertGroundTruthConsistent(manifest, groundTruth);
  const agentFactory = requireAgentFactory(config.agentFactory);
  const requestedProfile = config.profile ?? manifest.referenceProfile;
  const actualProfile = profileForProvenance(requestedProfile, agentFactory);
  const profileHash = referenceProfileSha256(actualProfile);
  const manifestHash = manifestSha256(manifest);
  const truthHash = groundTruthSha256(groundTruth);
  const createdAt = config.createdAt ?? "1970-01-01T00:00:00.000Z";

  const scenariosById = new Map(config.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const policy = explorationPolicyFor(requestedProfile, config.scenarios);
  const policyBindingHash = policyBindingHashFor(policy);
  const seedBindingHash = seedBindingHashFor(policy);
  const inputSha256 = inputBindingHashFor({
    manifestHash,
    profileHash,
    truthHash,
    policyBindingHash,
    seedBindingHash,
    scenarios: config.scenarios,
  });
  const runId = deriveRunId(inputSha256);

  const attemptPlans: AttemptPlan[] = [];
  const expectedAttemptIds = new Set<string>();
  const attemptBindingSha256s: string[] = [];
  for (const scenario of manifest.scenarios) {
    assertFixtureVersionBound(requestedProfile, scenario);
    const definition = scenariosById.get(scenario.scenarioId);
    if (definition === undefined) {
      throw new BenchmarkError(
        "BenchmarkManifestInvalid",
        `No scenario fixture supplied for manifest scenario "${scenario.scenarioId}".`,
      );
    }
    for (let repetition = 1; repetition <= requestedProfile.repetitions; repetition += 1) {
      const sourceBindingHash = sourceBindingHashFor({
        manifest,
        manifestScenario: scenario,
        scenarioDefinition: definition,
        profileHash,
        truthHash,
        repetition,
      });
      const attemptBindingHash = attemptBindingHashFor({
        runId,
        sourceBindingHash,
        policyBindingHash,
        seedBindingHash,
        scenarioId: scenario.scenarioId,
        repetition,
      });
      const attemptId = attemptIdFor(runId, attemptBindingHash);
      expectedAttemptIds.add(attemptId);
      attemptBindingSha256s.push(attemptBindingHash);
      attemptPlans.push({
        scenario,
        definition,
        repetition,
        sourceBindingHash,
        attemptBindingHash,
        attemptId,
      });
    }
  }

  await config.store.saveRun({
    runId,
    benchmarkVersion: manifest.benchmarkVersion,
    manifestSha256: manifestHash,
    profileSha256: profileHash,
    groundTruthSha256: truthHash,
    createdAt,
  });

  const attempts: BenchmarkAttempt[] = [];
  let persistedAttempts = attemptMap(await config.store.attemptsForRun(runId));
  assertNoUnexpectedPersistedAttempts(persistedAttempts, expectedAttemptIds);
  for (const plan of attemptPlans) {
    const { scenario, definition, repetition, sourceBindingHash, attemptId } = plan;
    const existingAttempt = persistedAttempts.get(attemptId);
    const progress = await config.store.loadAttemptProgress(attemptId);
    if (existingAttempt !== undefined) {
      assertExistingAttemptProgress({
        progress,
        attemptId,
        runId,
        sourceBindingHash,
        policyBindingHash,
        seedBindingHash,
      });
      assertPersistedAttemptMatches(existingAttempt, {
        attemptId,
        profileSha256: profileHash,
        scenarioId: scenario.scenarioId,
        mode: scenario.mode,
        repetition,
        findings: existingAttempt.findings,
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
    const agent = agentFactory.createAgent({
      manifest,
      profile: requestedProfile,
      scenario,
      scenarioDefinition: definition,
      repetition,
      runId,
      attemptId,
      sourceBindingHash,
      policyBindingHash,
      seedBindingHash,
    });
    const controller = new ExplorationController({
      target,
      agent,
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
    if (result.terminalReason === "error") {
      throw new BenchmarkError(
        "BenchmarkAttemptMatrixIncomplete",
        `Benchmark attempt "${attemptId}" ended with exploration error ${result.errorCode ?? "UnknownExplorationError"}.`,
      );
    }
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

    const persisted: PersistedAttempt = {
      attempt,
      terminalReason: result.terminalReason,
      checkpoints: result.checkpoints,
      createdAt,
    };
    await config.store.appendAttempt(runId, persisted);
    persistedAttempts = attemptMap(await config.store.attemptsForRun(runId));
    attempts.push(assertPersistedAttemptMatches(persistedAttempts.get(attemptId), attempt));
  }
  assertNoUnexpectedPersistedAttempts(persistedAttempts, expectedAttemptIds);

  const report = scoreBenchmark(manifest, attempts, groundTruth, {
    createdAt,
    inputSha256,
    attemptBindingSha256s: attemptBindingSha256s.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  });

  const existingReport = await config.store.reportForRun?.(runId);
  const durableReport = existingReport === undefined
    ? report
    : assertReportMatches(existingReport, report);
  if (existingReport === undefined) {
    await config.store.saveReport(runId, report);
    const persistedReport = await config.store.reportForRun?.(runId);
    if (persistedReport !== undefined) {
      assertReportMatches(persistedReport, report);
    }
  }

  const exitCode = durableReport.gate.status === "passed" ? 0 : 1;
  return { exitCode, runId, report: durableReport };
}
