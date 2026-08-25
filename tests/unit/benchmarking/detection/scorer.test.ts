import { describe, expect, it } from "vitest";
import {
  BenchmarkError,
  DEFAULT_DETECTION_THRESHOLDS,
  referenceProfileSha256,
  scoreBenchmark,
  type BenchmarkAttempt,
  type DetectionBenchmarkManifest,
  type DetectionFinding,
  type GroundTruth,
  type GroundTruthDefect,
  type ReferenceModelProfile,
} from "@qualigence/benchmarking-detection";

function profile(overrides: Partial<ReferenceModelProfile> = {}): ReferenceModelProfile {
  return {
    profileId: "reference-v1",
    providerId: "openai-compatible",
    modelId: "qualigence-detector-1",
    promptVersion: "prompt/2026-08-01",
    policyBundleSha256: "a".repeat(64),
    skillPackSha256: "b".repeat(64),
    browserVersion: "playwright/1.49.0",
    fixtureVersions: { cart: "cart/1.0.0" },
    maximumSteps: 40,
    maximumWallClockMs: 1_800_000,
    maximumModelTokens: 200_000,
    repetitions: 5,
    ...overrides,
  };
}

function manifest(
  scenarios: DetectionBenchmarkManifest["scenarios"],
  overrides: Partial<ReferenceModelProfile> = {},
): DetectionBenchmarkManifest {
  return {
    schemaVersion: "detection-benchmark/v1",
    benchmarkVersion: "detection-v1",
    referenceProfile: profile(overrides),
    scenarios,
    thresholds: DEFAULT_DETECTION_THRESHOLDS,
  };
}

function faultScenario(scenarioId: string, expectedDefectIds: readonly string[]): DetectionBenchmarkManifest["scenarios"][number] {
  return {
    scenarioId,
    fixtureId: "cart",
    fixtureVersion: "cart/1.0.0",
    mode: "fault",
    missionRef: `${scenarioId}-mission`,
    groundTruthRef: "ground-truth/cart.json",
    expectedDefectIds,
  };
}

function normalScenario(scenarioId: string): DetectionBenchmarkManifest["scenarios"][number] {
  return {
    scenarioId,
    fixtureId: "cart",
    fixtureVersion: "cart/1.0.0",
    mode: "normal",
    missionRef: `${scenarioId}-mission`,
    groundTruthRef: "ground-truth/cart.json",
    expectedDefectIds: [],
  };
}

function defect(
  scenarioId: string,
  defectId: string,
  overrides: Partial<GroundTruthDefect> = {},
): GroundTruthDefect {
  return {
    scenarioId,
    defectId,
    severity: "P1",
    stable: true,
    ...overrides,
  };
}

function truthOf(defects: readonly GroundTruthDefect[]): GroundTruth {
  return { benchmarkVersion: "detection-v1", defects };
}

function finding(defectId: string, confidence: DetectionFinding["confidence"] = "high"): DetectionFinding {
  return { defectId, confidence };
}

let attemptCounter = 0;

function attempt(
  scenarioId: string,
  mode: "normal" | "fault",
  repetition: number,
  findings: readonly DetectionFinding[],
  profileHash: string,
): BenchmarkAttempt {
  attemptCounter += 1;
  return {
    attemptId: `attempt-${attemptCounter}`,
    profileSha256: profileHash,
    scenarioId,
    mode,
    repetition,
    findings,
  };
}

/** Build a complete attempt matrix (every scenario x every repetition). */
function completeAttempts(
  m: DetectionBenchmarkManifest,
  findingsFor: (scenarioId: string, repetition: number) => readonly DetectionFinding[],
  profileHash: string = referenceProfileSha256(m.referenceProfile),
): BenchmarkAttempt[] {
  const attempts: BenchmarkAttempt[] = [];
  for (const scenario of m.scenarios) {
    for (let repetition = 1; repetition <= m.referenceProfile.repetitions; repetition += 1) {
      attempts.push(
        attempt(scenario.scenarioId, scenario.mode, repetition, findingsFor(scenario.scenarioId, repetition), profileHash),
      );
    }
  }
  return attempts;
}

describe("scoreBenchmark", () => {
  it("computes knownBugRecall as hit known defects over all known defects", () => {
    const m = manifest([faultScenario("cart-known-bugs", ["d1", "d2", "d3", "d4", "d5"])], { repetitions: 1 });
    const truth = truthOf([
      defect("cart-known-bugs", "d1"),
      defect("cart-known-bugs", "d2"),
      defect("cart-known-bugs", "d3"),
      defect("cart-known-bugs", "d4"),
      defect("cart-known-bugs", "d5"),
    ]);
    const attempts = completeAttempts(m, () => [finding("d1"), finding("d2"), finding("d3"), finding("d4")]);

    const report = scoreBenchmark(m, attempts, truth);

    expect(report.metrics.knownBugRecall).toEqual({ numerator: 4, denominator: 5, value: 0.8 });
  });

  it("computes findingPrecision as true high-confidence findings over all high-confidence findings", () => {
    const m = manifest([faultScenario("cart-known-bugs", ["d1", "d2", "d3", "d4"])], { repetitions: 1 });
    const truth = truthOf([
      defect("cart-known-bugs", "d1"),
      defect("cart-known-bugs", "d2"),
      defect("cart-known-bugs", "d3"),
      defect("cart-known-bugs", "d4"),
    ]);
    // 6 high-confidence findings, 4 of which match known defects, 2 are spurious.
    const attempts = completeAttempts(m, () => [
      finding("d1"),
      finding("d2"),
      finding("d3"),
      finding("d4"),
      finding("ghost-1"),
      finding("ghost-2"),
    ]);

    const report = scoreBenchmark(m, attempts, truth);

    expect(report.metrics.findingPrecision.numerator).toBe(4);
    expect(report.metrics.findingPrecision.denominator).toBe(6);
    expect(report.metrics.findingPrecision.value).toBeCloseTo(0.6666, 3);
  });

  it("computes stableReproductionRate over stable defect repetition slots", () => {
    // 2 stable defects x 5 repetitions = 10 slots; reproduce 7 of them.
    const m = manifest([faultScenario("cart-known-bugs", ["s1", "s2"])], { repetitions: 5 });
    const truth = truthOf([
      defect("cart-known-bugs", "s1", { stable: true }),
      defect("cart-known-bugs", "s2", { stable: true }),
    ]);
    // Reproduction plan producing exactly 7 hits across 10 slots:
    // s1 reproduces in reps 1-5 (5 hits); s2 reproduces in reps 1-2 (2 hits).
    const attempts = completeAttempts(m, (_scenario, repetition) => {
      const f: DetectionFinding[] = [finding("s1")];
      if (repetition <= 2) {
        f.push(finding("s2"));
      }
      return f;
    });

    const report = scoreBenchmark(m, attempts, truth);

    expect(report.metrics.stableReproductionRate).toEqual({ numerator: 7, denominator: 10, value: 0.7 });
  });

  it("rejects expected defects omitted from Ground Truth before denominator-zero scoring can pass", () => {
    const m = manifest([faultScenario("checkout-security", ["p0-security-bypass"])], { repetitions: 1 });
    const truth = truthOf([]);
    const attempts = completeAttempts(m, () => []);

    expect(() => scoreBenchmark(m, attempts, truth)).toThrow(
      expect.objectContaining({
        code: "GroundTruthMismatch",
        message: expect.stringContaining("missing from Ground Truth: p0-security-bypass"),
      }),
    );
  });

  it("rejects extra Ground Truth defects omitted from scenario expectedDefectIds", () => {
    const m = manifest([faultScenario("checkout-security", [])], { repetitions: 1 });
    const truth = truthOf([
      defect("checkout-security", "p0-security-bypass", { severity: "P0" }),
    ]);
    const attempts = completeAttempts(m, () => []);

    expect(() => scoreBenchmark(m, attempts, truth)).toThrow(
      expect.objectContaining({
        code: "GroundTruthMismatch",
        message: expect.stringContaining("unexpected in Ground Truth: p0-security-bypass"),
      }),
    );
  });

  it("fails the gate when Ground Truth has no P0 denominator to satisfy exact P0 recall", () => {
    const m = manifest([faultScenario("cart-known-bugs", ["d1"])], { repetitions: 1 });
    const truth = truthOf([defect("cart-known-bugs", "d1", { severity: "P1" })]);
    const attempts = completeAttempts(m, () => [finding("d1")]);

    const report = scoreBenchmark(m, attempts, truth);

    expect(report.metrics.p0Recall).toEqual({ numerator: 0, denominator: 0, value: 0 });
    expect(report.gate.status).toBe("failed");
    expect(report.gate.failureCodes).toContain("P0RecallBelowMinimum");
  });

  it("fails the gate when any P0 defect is missed regardless of other totals", () => {
    const m = manifest([faultScenario("cart-known-bugs", ["p0", "d2", "d3", "d4", "d5"])], { repetitions: 1 });
    const truth = truthOf([
      defect("cart-known-bugs", "p0", { severity: "P0" }),
      defect("cart-known-bugs", "d2"),
      defect("cart-known-bugs", "d3"),
      defect("cart-known-bugs", "d4"),
      defect("cart-known-bugs", "d5"),
    ]);
    // Miss the P0 defect but hit everything else (knownBugRecall = 0.8, still gate fails).
    const attempts = completeAttempts(m, () => [finding("d2"), finding("d3"), finding("d4"), finding("d5")]);

    const report = scoreBenchmark(m, attempts, truth);

    expect(report.metrics.p0Recall.value).toBe(0);
    expect(report.gate.status).toBe("failed");
    expect(report.gate.failureCodes).toContain("P0RecallBelowMinimum");
  });

  it("fails the gate when a normal mission has more than one high-confidence false positive", () => {
    const m = manifest([normalScenario("cart-normal")], { repetitions: 1 });
    const truth = truthOf([]);
    const attempts = completeAttempts(m, () => [finding("ghost-1"), finding("ghost-2")]);

    const report = scoreBenchmark(m, attempts, truth);

    expect(report.metrics.highConfidenceFalsePositivesByNormalMission["cart-normal"]).toBe(2);
    expect(report.gate.status).toBe("failed");
    expect(report.gate.failureCodes).toContain("HighConfidenceFalsePositivesExceeded");
  });

  it("passes the gate for a reference profile meeting every threshold", () => {
    const m = manifest([
      faultScenario("cart-known-bugs", ["p0", "d2", "d3", "d4", "d5"]),
      normalScenario("cart-normal"),
    ], { repetitions: 2 });
    const truth = truthOf([
      defect("cart-known-bugs", "p0", { severity: "P0", stable: true }),
      defect("cart-known-bugs", "d2", { stable: true }),
      defect("cart-known-bugs", "d3", { stable: true }),
      defect("cart-known-bugs", "d4", { stable: true }),
      defect("cart-known-bugs", "d5", { stable: true }),
    ]);
    const attempts = completeAttempts(m, (scenarioId) =>
      scenarioId === "cart-known-bugs"
        ? [finding("p0"), finding("d2"), finding("d3"), finding("d4"), finding("d5")]
        : [],
    );

    const report = scoreBenchmark(m, attempts, truth);

    expect(report.profileStatus).toBe("reference");
    expect(report.gate.status).toBe("passed");
    expect(report.gate.failureCodes).toEqual([]);
    expect(report.metrics.p0Recall.value).toBe(1);
    expect(report.metrics.knownBugRecall.value).toBe(1);
    expect(report.metrics.findingPrecision.value).toBe(1);
    expect(report.metrics.stableReproductionRate.value).toBe(1);
  });

  it("labels a non-reference profile as unverified and never marks the gate passed", () => {
    const m = manifest([faultScenario("cart-known-bugs", ["p0", "d2", "d3", "d4", "d5"])], { repetitions: 1 });
    const truth = truthOf([
      defect("cart-known-bugs", "p0", { severity: "P0", stable: true }),
      defect("cart-known-bugs", "d2", { stable: true }),
      defect("cart-known-bugs", "d3", { stable: true }),
      defect("cart-known-bugs", "d4", { stable: true }),
      defect("cart-known-bugs", "d5", { stable: true }),
    ]);
    // A BYO profile hash that does not match the manifest reference profile.
    const byoHash = "f".repeat(64);
    const attempts = completeAttempts(
      m,
      () => [finding("p0"), finding("d2"), finding("d3"), finding("d4"), finding("d5")],
      byoHash,
    );

    const report = scoreBenchmark(m, attempts, truth);

    expect(report.profileStatus).toBe("unverified");
    expect(report.gate.status).toBe("unverified");
    expect(report.gate.status).not.toBe("passed");
    expect(report.profileSha256).toBe(byoHash);
  });

  it("rejects an incomplete attempt matrix", () => {
    const m = manifest([faultScenario("cart-known-bugs", ["d1"])], { repetitions: 3 });
    const truth = truthOf([defect("cart-known-bugs", "d1")]);
    // Only one repetition supplied instead of three.
    const attempts = [
      attempt("cart-known-bugs", "fault", 1, [finding("d1")], referenceProfileSha256(m.referenceProfile)),
    ];

    expect(() => scoreBenchmark(m, attempts, truth)).toThrow(BenchmarkError);
  });

  it("is deterministic: identical inputs produce identical reports", () => {
    const m = manifest([
      faultScenario("cart-known-bugs", ["p0", "d2", "d3"]),
      normalScenario("cart-normal"),
    ], { repetitions: 2 });
    const truth = truthOf([
      defect("cart-known-bugs", "p0", { severity: "P0", stable: true }),
      defect("cart-known-bugs", "d2", { stable: true }),
      defect("cart-known-bugs", "d3", { stable: false }),
    ]);
    const attempts = completeAttempts(m, (scenarioId) =>
      scenarioId === "cart-known-bugs" ? [finding("p0"), finding("d2"), finding("d3")] : [],
    );

    const first = scoreBenchmark(m, attempts, truth);
    const second = scoreBenchmark(m, attempts, truth);

    expect(second).toEqual(first);
  });
});
