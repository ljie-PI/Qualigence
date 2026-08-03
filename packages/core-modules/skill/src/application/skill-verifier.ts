import type { Clock } from "@qualigence/shared-kernel";
import type { SignedSkillBundle } from "../domain/skill-bundle.js";
import type { OracleResult, SkillEvaluation } from "../domain/skill-types.js";
import type { SkillSignatureVerification } from "../ports/skill-signer.js";
import type {
  SkillReplayFixture,
  SkillReplayPort,
  SkillReplayResult,
} from "../ports/skill-replay-port.js";

/**
 * The four independent replay oracles a Procedure Skill must satisfy before it
 * can be verified. Every oracle is checked from a distinct angle so a single
 * lucky run cannot mask a regression.
 */
export const SKILL_REPLAY_ORACLES = {
  signatureIntegrity: "signature-integrity",
  exactTraceReplay: "exact-trace-replay",
  semanticTolerantReplay: "semantic-tolerant-replay",
  preconditionSafety: "precondition-safety",
} as const;

export const REQUIRED_REPLAY_ORACLES: readonly string[] = [
  SKILL_REPLAY_ORACLES.signatureIntegrity,
  SKILL_REPLAY_ORACLES.exactTraceReplay,
  SKILL_REPLAY_ORACLES.semanticTolerantReplay,
  SKILL_REPLAY_ORACLES.preconditionSafety,
];

export interface SkillVerifierDependencies {
  readonly replay: SkillReplayPort;
  readonly clock: Clock;
  readonly idFactory: () => string;
}

export interface VerifyBundleInput {
  readonly bundle: SignedSkillBundle;
  readonly signatureVerification: SkillSignatureVerification;
  readonly fixtures: readonly SkillReplayFixture[];
}

/**
 * The deterministic verifier. It replays a signed Bundle across a fixed battery
 * of fixtures and folds the results into four independent oracles plus the
 * signature-integrity oracle, producing an immutable {@link SkillEvaluation}.
 * The evaluation passes only when every oracle passes; it never runs a model,
 * mutates the aggregate, or persists anything.
 */
export class SkillVerifier {
  constructor(private readonly deps: SkillVerifierDependencies) {}

  async verify(input: VerifyBundleInput): Promise<SkillEvaluation> {
    const { bundle, signatureVerification, fixtures } = input;

    const results = await this.runFixtures(bundle, signatureVerification, fixtures);

    const signatureOracle = this.signatureOracle(signatureVerification);
    const exactOracle = this.exactTraceOracle(fixtures, results);
    const semanticOracle = this.semanticTolerantOracle(fixtures, results);
    const preconditionOracle = this.preconditionSafetyOracle(fixtures, results);

    const oracles: [OracleResult, ...OracleResult[]] = [
      signatureOracle,
      exactOracle,
      semanticOracle,
      preconditionOracle,
    ];
    const outcome = oracles.every((oracle) => oracle.status === "passed")
      ? "passed"
      : "failed";

    return {
      evaluationId: this.deps.idFactory(),
      skillId: bundle.manifest.skillId,
      skillVersion: bundle.manifest.skillVersion,
      oracles,
      outcome,
      signatureValid: signatureVerification.status === "valid",
      createdAt: this.deps.clock.now(),
    };
  }

  private async runFixtures(
    bundle: SignedSkillBundle,
    signatureVerification: SkillSignatureVerification,
    fixtures: readonly SkillReplayFixture[],
  ): Promise<Map<string, SkillReplayResult>> {
    const results = new Map<string, SkillReplayResult>();
    if (signatureVerification.status !== "valid") {
      // Never replay against a live target with an invalid signature.
      return results;
    }
    for (const fixture of fixtures) {
      results.set(fixture.name, await this.deps.replay.replay(bundle, fixture));
    }
    return results;
  }

  private signatureOracle(
    signatureVerification: SkillSignatureVerification,
  ): OracleResult {
    if (signatureVerification.status === "valid") {
      return { oracle: SKILL_REPLAY_ORACLES.signatureIntegrity, status: "passed" };
    }
    return {
      oracle: SKILL_REPLAY_ORACLES.signatureIntegrity,
      status: "failed",
      detail: signatureVerification.code,
    };
  }

  private exactTraceOracle(
    fixtures: readonly SkillReplayFixture[],
    results: ReadonlyMap<string, SkillReplayResult>,
  ): OracleResult {
    const normal = fixtures.filter((fixture) => fixture.kind === "normal");
    if (normal.length < 2) {
      return failed(
        SKILL_REPLAY_ORACLES.exactTraceReplay,
        "At least two normal replays are required.",
      );
    }
    const allPassed = normal.every(
      (fixture) => results.get(fixture.name)?.status === "passed",
    );
    return allPassed
      ? { oracle: SKILL_REPLAY_ORACLES.exactTraceReplay, status: "passed" }
      : failed(
          SKILL_REPLAY_ORACLES.exactTraceReplay,
          "A normal replay did not pass.",
        );
  }

  private semanticTolerantOracle(
    fixtures: readonly SkillReplayFixture[],
    results: ReadonlyMap<string, SkillReplayResult>,
  ): OracleResult {
    const variations = fixtures.filter(
      (fixture) => fixture.kind === "dom-variation",
    );
    if (variations.length < 1) {
      return failed(
        SKILL_REPLAY_ORACLES.semanticTolerantReplay,
        "At least one DOM-variation replay is required.",
      );
    }
    const allPassed = variations.every(
      (fixture) => results.get(fixture.name)?.status === "passed",
    );
    return allPassed
      ? { oracle: SKILL_REPLAY_ORACLES.semanticTolerantReplay, status: "passed" }
      : failed(
          SKILL_REPLAY_ORACLES.semanticTolerantReplay,
          "A DOM-variation replay did not relocate by semantics.",
        );
  }

  private preconditionSafetyOracle(
    fixtures: readonly SkillReplayFixture[],
    results: ReadonlyMap<string, SkillReplayResult>,
  ): OracleResult {
    const negatives = fixtures.filter(
      (fixture) => fixture.kind === "precondition-negative",
    );
    if (negatives.length < 1) {
      return failed(
        SKILL_REPLAY_ORACLES.preconditionSafety,
        "At least one precondition-negative replay is required.",
      );
    }
    const allSafe = negatives.every((fixture) => {
      const result = results.get(fixture.name);
      return result?.status === "blocked" && result.errorCode === "PlanDiverged";
    });
    return allSafe
      ? { oracle: SKILL_REPLAY_ORACLES.preconditionSafety, status: "passed" }
      : failed(
          SKILL_REPLAY_ORACLES.preconditionSafety,
          "A precondition-negative replay did not safely diverge.",
        );
  }
}

function failed(oracle: string, detail: string): OracleResult {
  return { oracle, status: "failed", detail };
}
