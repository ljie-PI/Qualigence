import { canonicalJson, sha256Hex } from "@qualigence/skill";

/** The frozen schema identifier for Detection Benchmark manifests. */
export const DETECTION_BENCHMARK_SCHEMA_VERSION = "detection-benchmark/v1" as const;

/** Severity of a seeded ground-truth defect. `P0` defects are release-blocking. */
export type DefectSeverity = "P0" | "P1" | "P2";

/** Confidence a detection result assigns to a claimed defect. */
export type FindingConfidence = "low" | "medium" | "high";

/** Whether a scored run used the frozen Reference Profile or a BYO profile. */
export type ProfileStatus = "reference" | "unverified";

/** The gate verdict. `unverified` can never be promoted to `passed`. */
export type GateStatus = "passed" | "failed" | "unverified";

/** The stable failure codes emitted when a threshold is not met. */
export type DetectionFailureCode =
  | "P0RecallBelowMinimum"
  | "KnownBugRecallBelowMinimum"
  | "FindingPrecisionBelowMinimum"
  | "StableReproductionRateBelowMinimum"
  | "HighConfidenceFalsePositivesExceeded";

/**
 * The frozen, version-pinned identity of the Reference Profile. Every field that
 * can change a detection outcome is captured so that two runs are only comparable
 * when they share a byte-identical profile. The canonical hash of this object is
 * what distinguishes a Reference run from an Unverified (BYO) run.
 */
export interface ReferenceModelProfile {
  readonly profileId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly policyBundleSha256: string;
  readonly skillPackSha256: string;
  readonly browserVersion: string;
  readonly fixtureVersions: Readonly<Record<string, string>>;
  readonly maximumSteps: number;
  readonly maximumWallClockMs: number;
  readonly maximumModelTokens: number;
  readonly repetitions: number;
}

/** One immutable benchmark scenario over a fixture, in normal or fault mode. */
export interface BenchmarkScenario {
  readonly scenarioId: string;
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly mode: "normal" | "fault";
  readonly missionRef: string;
  readonly groundTruthRef: string;
  readonly expectedDefectIds: readonly string[];
}

/** The five frozen release thresholds. Values match the Design Spec exactly. */
export interface DetectionThresholds {
  readonly p0RecallMinimum: 1;
  readonly knownBugRecallMinimum: 0.8;
  readonly findingPrecisionMinimum: 0.6;
  readonly stableReproductionRateMinimum: 0.7;
  readonly maximumHighConfidenceFalsePositivesPerNormalMission: 1;
}

/** The frozen default thresholds shared by every Detection Benchmark v1 run. */
export const DEFAULT_DETECTION_THRESHOLDS: DetectionThresholds = {
  p0RecallMinimum: 1,
  knownBugRecallMinimum: 0.8,
  findingPrecisionMinimum: 0.6,
  stableReproductionRateMinimum: 0.7,
  maximumHighConfidenceFalsePositivesPerNormalMission: 1,
};

/** The complete, immutable Detection Benchmark manifest. */
export interface DetectionBenchmarkManifest {
  readonly schemaVersion: "detection-benchmark/v1";
  readonly benchmarkVersion: string;
  readonly referenceProfile: ReferenceModelProfile;
  readonly scenarios: readonly BenchmarkScenario[];
  readonly thresholds: DetectionThresholds;
}

/** One seeded, known-correct defect at a known location within a scenario. */
export interface GroundTruthDefect {
  readonly scenarioId: string;
  readonly defectId: string;
  readonly severity: DefectSeverity;
  readonly stable: boolean;
}

/** The frozen ground truth: every known defect the benchmark can detect. */
export interface GroundTruth {
  readonly benchmarkVersion: string;
  readonly defects: readonly GroundTruthDefect[];
}

/** Error codes raised while validating or scoring a benchmark. */
export type BenchmarkErrorCode =
  | "BenchmarkManifestInvalid"
  | "GroundTruthMismatch"
  | "ReferenceProfileMismatch"
  | "BenchmarkAttemptMatrixIncomplete";

/** A typed, non-generic error for every benchmark validation/scoring failure. */
export class BenchmarkError extends Error {
  constructor(
    readonly code: BenchmarkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BenchmarkError";
  }
}

/** The canonical SHA-256 of the Reference Profile — the provenance fingerprint. */
export function referenceProfileSha256(profile: ReferenceModelProfile): string {
  return sha256Hex(canonicalJson(profile));
}

/** The canonical SHA-256 of the whole manifest. */
export function manifestSha256(manifest: DetectionBenchmarkManifest): string {
  return sha256Hex(canonicalJson(manifest));
}

/** The canonical SHA-256 of the ground truth. */
export function groundTruthSha256(truth: GroundTruth): string {
  return sha256Hex(canonicalJson(truth));
}

function fail(code: BenchmarkErrorCode, message: string): never {
  throw new BenchmarkError(code, message);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function requireString(record: Record<string, unknown>, key: string, code: BenchmarkErrorCode, ctx: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(code, `${ctx} is missing required string field "${key}".`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, code: BenchmarkErrorCode, ctx: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(code, `${ctx} is missing required non-negative number field "${key}".`);
  }
  return value;
}

function asRecord(value: unknown, code: BenchmarkErrorCode, ctx: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code, `${ctx} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseReferenceProfile(value: unknown): ReferenceModelProfile {
  const record = asRecord(value, "BenchmarkManifestInvalid", "referenceProfile");
  const fixtureVersionsRaw = asRecord(record["fixtureVersions"], "BenchmarkManifestInvalid", "referenceProfile.fixtureVersions");
  const fixtureVersions: Record<string, string> = {};
  for (const [key, entry] of Object.entries(fixtureVersionsRaw)) {
    if (typeof entry !== "string" || entry.length === 0) {
      fail("BenchmarkManifestInvalid", `referenceProfile.fixtureVersions["${key}"] must be a non-empty string.`);
    }
    fixtureVersions[key] = entry;
  }
  const policyBundleSha256 = requireString(record, "policyBundleSha256", "BenchmarkManifestInvalid", "referenceProfile");
  const skillPackSha256 = requireString(record, "skillPackSha256", "BenchmarkManifestInvalid", "referenceProfile");
  if (!isSha256(policyBundleSha256)) {
    fail("BenchmarkManifestInvalid", "referenceProfile.policyBundleSha256 must be a 64-character hex digest.");
  }
  if (!isSha256(skillPackSha256)) {
    fail("BenchmarkManifestInvalid", "referenceProfile.skillPackSha256 must be a 64-character hex digest.");
  }
  const repetitions = requireNumber(record, "repetitions", "BenchmarkManifestInvalid", "referenceProfile");
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    fail("BenchmarkManifestInvalid", "referenceProfile.repetitions must be a positive integer.");
  }
  return {
    profileId: requireString(record, "profileId", "BenchmarkManifestInvalid", "referenceProfile"),
    providerId: requireString(record, "providerId", "BenchmarkManifestInvalid", "referenceProfile"),
    modelId: requireString(record, "modelId", "BenchmarkManifestInvalid", "referenceProfile"),
    promptVersion: requireString(record, "promptVersion", "BenchmarkManifestInvalid", "referenceProfile"),
    policyBundleSha256,
    skillPackSha256,
    browserVersion: requireString(record, "browserVersion", "BenchmarkManifestInvalid", "referenceProfile"),
    fixtureVersions,
    maximumSteps: requireNumber(record, "maximumSteps", "BenchmarkManifestInvalid", "referenceProfile"),
    maximumWallClockMs: requireNumber(record, "maximumWallClockMs", "BenchmarkManifestInvalid", "referenceProfile"),
    maximumModelTokens: requireNumber(record, "maximumModelTokens", "BenchmarkManifestInvalid", "referenceProfile"),
    repetitions,
  };
}

function parseScenario(value: unknown): BenchmarkScenario {
  const record = asRecord(value, "BenchmarkManifestInvalid", "scenario");
  const mode = requireString(record, "mode", "BenchmarkManifestInvalid", "scenario");
  if (mode !== "normal" && mode !== "fault") {
    fail("BenchmarkManifestInvalid", `scenario.mode must be "normal" or "fault", received "${mode}".`);
  }
  const expectedRaw = record["expectedDefectIds"];
  if (!Array.isArray(expectedRaw) || expectedRaw.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    fail("BenchmarkManifestInvalid", "scenario.expectedDefectIds must be an array of non-empty strings.");
  }
  const expectedDefectIds = [...(expectedRaw as string[])];
  const duplicateExpectedDefectId = firstDuplicate(expectedDefectIds);
  if (duplicateExpectedDefectId !== undefined) {
    fail(
      "BenchmarkManifestInvalid",
      `scenario.expectedDefectIds contains duplicate defect "${duplicateExpectedDefectId}".`,
    );
  }
  return {
    scenarioId: requireString(record, "scenarioId", "BenchmarkManifestInvalid", "scenario"),
    fixtureId: requireString(record, "fixtureId", "BenchmarkManifestInvalid", "scenario"),
    fixtureVersion: requireString(record, "fixtureVersion", "BenchmarkManifestInvalid", "scenario"),
    mode,
    missionRef: requireString(record, "missionRef", "BenchmarkManifestInvalid", "scenario"),
    groundTruthRef: requireString(record, "groundTruthRef", "BenchmarkManifestInvalid", "scenario"),
    expectedDefectIds,
  };
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function parseThresholds(value: unknown): DetectionThresholds {
  const record = asRecord(value, "BenchmarkManifestInvalid", "thresholds");
  const expected: Record<keyof DetectionThresholds, number> = {
    p0RecallMinimum: 1,
    knownBugRecallMinimum: 0.8,
    findingPrecisionMinimum: 0.6,
    stableReproductionRateMinimum: 0.7,
    maximumHighConfidenceFalsePositivesPerNormalMission: 1,
  };
  for (const [key, frozen] of Object.entries(expected)) {
    if (record[key] !== frozen) {
      fail(
        "BenchmarkManifestInvalid",
        `thresholds.${key} is frozen at ${frozen} for detection-benchmark/v1 but was ${String(record[key])}.`,
      );
    }
  }
  return DEFAULT_DETECTION_THRESHOLDS;
}

/**
 * Strictly parse and validate an untrusted manifest value (e.g. loaded from
 * JSON). Rejects any manifest missing the frozen schema version, a required
 * profile hash, budgets/repetitions, or the exact frozen thresholds. Returns a
 * fully-typed, immutable manifest.
 */
export function parseManifest(value: unknown): DetectionBenchmarkManifest {
  const record = asRecord(value, "BenchmarkManifestInvalid", "manifest");
  if (record["schemaVersion"] !== DETECTION_BENCHMARK_SCHEMA_VERSION) {
    fail(
      "BenchmarkManifestInvalid",
      `manifest.schemaVersion must be "${DETECTION_BENCHMARK_SCHEMA_VERSION}".`,
    );
  }
  const scenariosRaw = record["scenarios"];
  if (!Array.isArray(scenariosRaw) || scenariosRaw.length === 0) {
    fail("BenchmarkManifestInvalid", "manifest.scenarios must be a non-empty array.");
  }
  const scenarios = scenariosRaw.map((entry) => parseScenario(entry));
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.scenarioId)) {
      fail("BenchmarkManifestInvalid", `Duplicate scenarioId "${scenario.scenarioId}" in manifest.`);
    }
    seen.add(scenario.scenarioId);
  }
  return {
    schemaVersion: DETECTION_BENCHMARK_SCHEMA_VERSION,
    benchmarkVersion: requireString(record, "benchmarkVersion", "BenchmarkManifestInvalid", "manifest"),
    referenceProfile: parseReferenceProfile(record["referenceProfile"]),
    scenarios,
    thresholds: parseThresholds(record["thresholds"]),
  };
}

/**
 * Strictly parse and validate an untrusted ground-truth value. Rejects a missing
 * benchmark version, malformed defects or an unknown severity.
 */
export function parseGroundTruth(value: unknown): GroundTruth {
  const record = asRecord(value, "GroundTruthMismatch", "groundTruth");
  const defectsRaw = record["defects"];
  if (!Array.isArray(defectsRaw)) {
    fail("GroundTruthMismatch", "groundTruth.defects must be an array.");
  }
  const seenDefectKeys = new Set<string>();
  const defects = defectsRaw.map((entry) => {
    const defectRecord = asRecord(entry, "GroundTruthMismatch", "defect");
    const severity = requireString(defectRecord, "severity", "GroundTruthMismatch", "defect");
    if (severity !== "P0" && severity !== "P1" && severity !== "P2") {
      fail("GroundTruthMismatch", `defect.severity must be P0/P1/P2, received "${severity}".`);
    }
    const stable = defectRecord["stable"];
    if (typeof stable !== "boolean") {
      fail("GroundTruthMismatch", "defect.stable must be a boolean.");
    }
    const defect = {
      scenarioId: requireString(defectRecord, "scenarioId", "GroundTruthMismatch", "defect"),
      defectId: requireString(defectRecord, "defectId", "GroundTruthMismatch", "defect"),
      severity,
      stable,
    } satisfies GroundTruthDefect;
    const key = `${defect.scenarioId}\u0000${defect.defectId}`;
    if (seenDefectKeys.has(key)) {
      fail(
        "GroundTruthMismatch",
        `Duplicate ground-truth defect "${defect.defectId}" for scenario "${defect.scenarioId}".`,
      );
    }
    seenDefectKeys.add(key);
    return defect;
  });
  return {
    benchmarkVersion: requireString(record, "benchmarkVersion", "GroundTruthMismatch", "groundTruth"),
    defects,
  };
}

/**
 * Validate that the manifest's expected defects are exactly the seeded Ground
 * Truth defects that will be scored. This must run before any provider or
 * fixture attempt starts so an omitted known/P0 defect cannot turn into a
 * denominator-zero pass.
 */
export function assertGroundTruthConsistent(
  manifest: DetectionBenchmarkManifest,
  truth: GroundTruth,
): void {
  if (truth.benchmarkVersion !== manifest.benchmarkVersion) {
    throw new BenchmarkError(
      "GroundTruthMismatch",
      `Ground truth version "${truth.benchmarkVersion}" does not match manifest "${manifest.benchmarkVersion}".`,
    );
  }

  const scenariosById = new Map(manifest.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const truthDefectIdsByScenario = new Map<string, Set<string>>();
  for (const defect of truth.defects) {
    if (!scenariosById.has(defect.scenarioId)) {
      throw new BenchmarkError(
        "GroundTruthMismatch",
        `Ground truth defect "${defect.defectId}" references unknown scenario "${defect.scenarioId}".`,
      );
    }
    const defectIds = truthDefectIdsByScenario.get(defect.scenarioId) ?? new Set<string>();
    if (defectIds.has(defect.defectId)) {
      throw new BenchmarkError(
        "GroundTruthMismatch",
        `Duplicate ground-truth defect "${defect.defectId}" for scenario "${defect.scenarioId}".`,
      );
    }
    defectIds.add(defect.defectId);
    truthDefectIdsByScenario.set(defect.scenarioId, defectIds);
  }

  for (const scenario of manifest.scenarios) {
    const duplicateExpectedDefectId = firstDuplicate(scenario.expectedDefectIds);
    if (duplicateExpectedDefectId !== undefined) {
      throw new BenchmarkError(
        "BenchmarkManifestInvalid",
        `Scenario "${scenario.scenarioId}" expectedDefectIds contains duplicate defect "${duplicateExpectedDefectId}".`,
      );
    }
    const expected = new Set(scenario.expectedDefectIds);
    const actual = truthDefectIdsByScenario.get(scenario.scenarioId) ?? new Set<string>();
    const missing = [...expected].filter((defectId) => !actual.has(defectId)).sort();
    const unexpected = [...actual].filter((defectId) => !expected.has(defectId)).sort();
    if (missing.length > 0 || unexpected.length > 0) {
      throw new BenchmarkError(
        "GroundTruthMismatch",
        `Scenario "${scenario.scenarioId}" expectedDefectIds must exactly match Ground Truth defects` +
          ` (missing from Ground Truth: ${formatDefectList(missing)}; unexpected in Ground Truth: ${formatDefectList(unexpected)}).`,
      );
    }
  }
}

function formatDefectList(defectIds: readonly string[]): string {
  return defectIds.length === 0 ? "none" : defectIds.join(", ");
}
