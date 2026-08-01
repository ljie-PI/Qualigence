export {
  BenchmarkError,
  DEFAULT_DETECTION_THRESHOLDS,
  DETECTION_BENCHMARK_SCHEMA_VERSION,
  groundTruthSha256,
  manifestSha256,
  parseGroundTruth,
  parseManifest,
  referenceProfileSha256,
} from "./manifest.js";

export type {
  BenchmarkErrorCode,
  BenchmarkScenario,
  DefectSeverity,
  DetectionBenchmarkManifest,
  DetectionFailureCode,
  DetectionThresholds,
  FindingConfidence,
  GateStatus,
  GroundTruth,
  GroundTruthDefect,
  ProfileStatus,
  ReferenceModelProfile,
} from "./manifest.js";

export { scoreBenchmark } from "./scorer.js";

export type {
  BenchmarkAttempt,
  DetectionFinding,
  ScoreOptions,
} from "./scorer.js";

export type {
  DetectionBenchmarkReport,
  DetectionGate,
  DetectionMetrics,
  DetectionRatio,
} from "./report.js";
