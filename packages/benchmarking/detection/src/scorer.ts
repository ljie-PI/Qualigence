import { canonicalJson, sha256Hex } from "@qualigence/skill";
import {
  BenchmarkError,
  groundTruthSha256,
  manifestSha256,
  referenceProfileSha256,
  type DetectionBenchmarkManifest,
  type DetectionFailureCode,
  type FindingConfidence,
  type GroundTruth,
  type GroundTruthDefect,
} from "./manifest.js";
import type {
  DetectionBenchmarkReport,
  DetectionMetrics,
  DetectionRatio,
} from "./report.js";

/** A single detection result: the defect a run claims, with its confidence. */
export interface DetectionFinding {
  readonly defectId: string;
  readonly confidence: FindingConfidence;
}

/**
 * One immutable attempt: exactly one scenario executed at one repetition by one
 * profile. `profileSha256` is the provenance fingerprint of the profile that
 * produced the attempt; the scorer compares it against the frozen manifest
 * Reference Profile hash and refuses to label a mismatched run as `reference`.
 */
export interface BenchmarkAttempt {
  readonly attemptId: string;
  readonly profileSha256: string;
  readonly scenarioId: string;
  readonly mode: "normal" | "fault";
  readonly repetition: number;
  readonly findings: readonly DetectionFinding[];
}

/** Options that never influence the score, only the report envelope. */
export interface ScoreOptions {
  readonly createdAt?: string;
  /** Hash of policy, seed and fixture/scenario inputs bound by the runner. */
  readonly inputSha256?: string;
  /** Per-attempt binding hashes supplied by the runner for durable audit. */
  readonly attemptBindingSha256s?: readonly string[];
}

/** A frozen sentinel so an omitted timestamp keeps the report deterministic. */
const DETERMINISTIC_CREATED_AT = "1970-01-01T00:00:00.000Z";

function ratio(numerator: number, denominator: number): DetectionRatio {
  const value = denominator === 0 ? 1 : numerator / denominator;
  return { numerator, denominator, value };
}

function defectKey(scenarioId: string, defectId: string): string {
  return `${scenarioId}\u0000${defectId}`;
}

/**
 * Deterministically score a set of benchmark attempts against the frozen
 * manifest and ground truth. Requires a complete attempt matrix (every scenario
 * at every repetition, all from a single profile). The returned report is a pure
 * function of its inputs: metrics, gate and hashes never depend on wall-clock
 * time or randomness.
 */
export function scoreBenchmark(
  manifest: DetectionBenchmarkManifest,
  attempts: readonly BenchmarkAttempt[],
  truth: GroundTruth,
  options: ScoreOptions = {},
): DetectionBenchmarkReport {
  assertCompleteAttemptMatrix(manifest, attempts);
  const profileHash = assertSingleProfile(attempts);
  assertGroundTruthConsistent(manifest, truth);

  const metrics = computeMetrics(manifest, attempts, truth);
  const failureCodes = evaluateThresholds(manifest, metrics);

  const referenceHash = referenceProfileSha256(manifest.referenceProfile);
  const profileStatus = profileHash === referenceHash ? "reference" : "unverified";
  // An Unverified run can never be promoted to a passed release gate.
  const gateStatus =
    profileStatus === "unverified" ? "unverified" : failureCodes.length === 0 ? "passed" : "failed";

  const manifestHash = manifestSha256(manifest);
  const truthHash = groundTruthSha256(truth);
  const attemptIds = attempts.map((attempt) => attempt.attemptId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const inputSha256 = options.inputSha256 ?? sha256Hex(canonicalJson({ manifestHash, profileHash, truthHash }));
  const attemptBindingSha256s = [...(options.attemptBindingSha256s ?? attemptIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const reportId = sha256Hex(
    canonicalJson({ manifestHash, profileHash, truthHash, inputSha256, attemptIds, attemptBindingSha256s }),
  );

  return {
    reportId,
    benchmarkVersion: manifest.benchmarkVersion,
    manifestSha256: manifestHash,
    profileSha256: profileHash,
    groundTruthSha256: truthHash,
    inputSha256,
    attemptBindingSha256s,
    profileStatus,
    attemptIds,
    metrics,
    gate: { status: gateStatus, failureCodes },
    createdAt: options.createdAt ?? DETERMINISTIC_CREATED_AT,
  };
}

function assertCompleteAttemptMatrix(
  manifest: DetectionBenchmarkManifest,
  attempts: readonly BenchmarkAttempt[],
): void {
  const repetitions = manifest.referenceProfile.repetitions;
  const scenarioModes = new Map(manifest.scenarios.map((scenario) => [scenario.scenarioId, scenario.mode]));
  const expected = new Set<string>();
  for (const scenario of manifest.scenarios) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      expected.add(`${scenario.scenarioId}\u0000${repetition}`);
    }
  }

  const seen = new Set<string>();
  for (const attempt of attempts) {
    const mode = scenarioModes.get(attempt.scenarioId);
    if (mode === undefined) {
      throw new BenchmarkError(
        "BenchmarkAttemptMatrixIncomplete",
        `Attempt "${attempt.attemptId}" references unknown scenario "${attempt.scenarioId}".`,
      );
    }
    if (attempt.mode !== mode) {
      throw new BenchmarkError(
        "BenchmarkAttemptMatrixIncomplete",
        `Attempt "${attempt.attemptId}" has mode "${attempt.mode}" but scenario "${attempt.scenarioId}" is "${mode}".`,
      );
    }
    if (attempt.repetition < 1 || attempt.repetition > repetitions || !Number.isInteger(attempt.repetition)) {
      throw new BenchmarkError(
        "BenchmarkAttemptMatrixIncomplete",
        `Attempt "${attempt.attemptId}" repetition ${attempt.repetition} is outside 1..${repetitions}.`,
      );
    }
    const key = `${attempt.scenarioId}\u0000${attempt.repetition}`;
    if (seen.has(key)) {
      throw new BenchmarkError(
        "BenchmarkAttemptMatrixIncomplete",
        `Duplicate attempt for scenario "${attempt.scenarioId}" repetition ${attempt.repetition}.`,
      );
    }
    seen.add(key);
  }

  if (seen.size !== expected.size) {
    throw new BenchmarkError(
      "BenchmarkAttemptMatrixIncomplete",
      `Expected ${expected.size} attempts (scenarios x repetitions) but received ${seen.size}.`,
    );
  }
}

function assertSingleProfile(attempts: readonly BenchmarkAttempt[]): string {
  const first = attempts[0];
  if (first === undefined) {
    throw new BenchmarkError("BenchmarkAttemptMatrixIncomplete", "No attempts were supplied to score.");
  }
  for (const attempt of attempts) {
    if (attempt.profileSha256 !== first.profileSha256) {
      throw new BenchmarkError(
        "ReferenceProfileMismatch",
        "All attempts in a benchmark run must share one profile fingerprint.",
      );
    }
  }
  return first.profileSha256;
}

function assertGroundTruthConsistent(
  manifest: DetectionBenchmarkManifest,
  truth: GroundTruth,
): void {
  if (truth.benchmarkVersion !== manifest.benchmarkVersion) {
    throw new BenchmarkError(
      "GroundTruthMismatch",
      `Ground truth version "${truth.benchmarkVersion}" does not match manifest "${manifest.benchmarkVersion}".`,
    );
  }
  const scenarioIds = new Set(manifest.scenarios.map((scenario) => scenario.scenarioId));
  for (const defect of truth.defects) {
    if (!scenarioIds.has(defect.scenarioId)) {
      throw new BenchmarkError(
        "GroundTruthMismatch",
        `Ground truth defect "${defect.defectId}" references unknown scenario "${defect.scenarioId}".`,
      );
    }
  }
}

function computeMetrics(
  manifest: DetectionBenchmarkManifest,
  attempts: readonly BenchmarkAttempt[],
  truth: GroundTruth,
): DetectionMetrics {
  const attemptsByScenario = new Map<string, BenchmarkAttempt[]>();
  for (const attempt of attempts) {
    const list = attemptsByScenario.get(attempt.scenarioId) ?? [];
    list.push(attempt);
    attemptsByScenario.set(attempt.scenarioId, list);
  }

  // A known defect is "detected" if any attempt of its scenario reports a
  // finding matching scenarioId + defectId (confidence-independent for recall).
  const detectedDefects = new Set<string>();
  for (const attempt of attempts) {
    for (const finding of attempt.findings) {
      detectedDefects.add(defectKey(attempt.scenarioId, finding.defectId));
    }
  }
  const isDetected = (defect: GroundTruthDefect): boolean =>
    detectedDefects.has(defectKey(defect.scenarioId, defect.defectId));

  // Known-bug recall over every seeded defect.
  const knownDefects = truth.defects;
  const knownHit = knownDefects.filter(isDetected).length;
  const knownBugRecall = ratio(knownHit, knownDefects.length);

  // P0 recall — any miss is release-blocking.
  const p0Defects = knownDefects.filter((defect) => defect.severity === "P0");
  const p0Hit = p0Defects.filter(isDetected).length;
  const p0Recall = ratio(p0Hit, p0Defects.length);

  // The set of known (scenarioId+defectId) pairs, for precision classification.
  const knownDefectKeys = new Set(knownDefects.map((defect) => defectKey(defect.scenarioId, defect.defectId)));

  // Finding precision over every high-confidence finding across all attempts.
  let highConfidenceTotal = 0;
  let highConfidenceTrue = 0;
  for (const attempt of attempts) {
    for (const finding of attempt.findings) {
      if (finding.confidence !== "high") {
        continue;
      }
      highConfidenceTotal += 1;
      if (knownDefectKeys.has(defectKey(attempt.scenarioId, finding.defectId))) {
        highConfidenceTrue += 1;
      }
    }
  }
  const findingPrecision = ratio(highConfidenceTrue, highConfidenceTotal);

  // Stable reproduction rate over (stable defect x repetition) slots.
  let stableSlots = 0;
  let stableReproduced = 0;
  for (const defect of knownDefects) {
    if (!defect.stable) {
      continue;
    }
    const scenarioAttempts = attemptsByScenario.get(defect.scenarioId) ?? [];
    for (const attempt of scenarioAttempts) {
      stableSlots += 1;
      if (attempt.findings.some((finding) => finding.defectId === defect.defectId)) {
        stableReproduced += 1;
      }
    }
  }
  const stableReproductionRate = ratio(stableReproduced, stableSlots);

  // High-confidence false positives per normal mission.
  const highConfidenceFalsePositivesByNormalMission: Record<string, number> = {};
  for (const scenario of manifest.scenarios) {
    if (scenario.mode !== "normal") {
      continue;
    }
    let falsePositives = 0;
    for (const attempt of attemptsByScenario.get(scenario.scenarioId) ?? []) {
      for (const finding of attempt.findings) {
        if (finding.confidence !== "high") {
          continue;
        }
        if (!knownDefectKeys.has(defectKey(scenario.scenarioId, finding.defectId))) {
          falsePositives += 1;
        }
      }
    }
    highConfidenceFalsePositivesByNormalMission[scenario.scenarioId] = falsePositives;
  }

  return {
    p0Recall,
    knownBugRecall,
    findingPrecision,
    stableReproductionRate,
    highConfidenceFalsePositivesByNormalMission,
  };
}

function evaluateThresholds(
  manifest: DetectionBenchmarkManifest,
  metrics: DetectionMetrics,
): readonly DetectionFailureCode[] {
  const thresholds = manifest.thresholds;
  const failures: DetectionFailureCode[] = [];

  if (metrics.p0Recall.value < thresholds.p0RecallMinimum) {
    failures.push("P0RecallBelowMinimum");
  }
  if (metrics.knownBugRecall.value < thresholds.knownBugRecallMinimum) {
    failures.push("KnownBugRecallBelowMinimum");
  }
  if (metrics.findingPrecision.value < thresholds.findingPrecisionMinimum) {
    failures.push("FindingPrecisionBelowMinimum");
  }
  if (metrics.stableReproductionRate.value < thresholds.stableReproductionRateMinimum) {
    failures.push("StableReproductionRateBelowMinimum");
  }
  const maxFp = thresholds.maximumHighConfidenceFalsePositivesPerNormalMission;
  const exceeded = Object.values(metrics.highConfidenceFalsePositivesByNormalMission).some(
    (count) => count > maxFp,
  );
  if (exceeded) {
    failures.push("HighConfidenceFalsePositivesExceeded");
  }

  return failures;
}
