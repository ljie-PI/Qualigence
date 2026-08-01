import type {
  DetectionFailureCode,
  GateStatus,
  ProfileStatus,
} from "./manifest.js";

/** A single ratio metric with its exact numerator/denominator for auditing. */
export interface DetectionRatio {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number;
}

/** The full frozen metric breakdown produced by the scorer. */
export interface DetectionMetrics {
  readonly p0Recall: DetectionRatio;
  readonly knownBugRecall: DetectionRatio;
  readonly findingPrecision: DetectionRatio;
  readonly stableReproductionRate: DetectionRatio;
  readonly highConfidenceFalsePositivesByNormalMission: Readonly<Record<string, number>>;
}

/** The gate verdict plus the specific thresholds that were not met. */
export interface DetectionGate {
  readonly status: GateStatus;
  readonly failureCodes: readonly DetectionFailureCode[];
}

/**
 * The immutable, hash-linked Detection Benchmark report. `profileStatus` is
 * always derived by the scorer from the actual run profile hash versus the
 * frozen manifest Reference Profile hash — a caller can never present it. An
 * `unverified` run therefore can never carry a `passed` gate.
 */
export interface DetectionBenchmarkReport {
  readonly reportId: string;
  readonly benchmarkVersion: string;
  readonly manifestSha256: string;
  readonly profileSha256: string;
  readonly groundTruthSha256: string;
  readonly profileStatus: ProfileStatus;
  readonly attemptIds: readonly string[];
  readonly metrics: DetectionMetrics;
  readonly gate: DetectionGate;
  readonly createdAt: string;
}
