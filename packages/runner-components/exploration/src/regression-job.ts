import type { RegressionJobPlan } from "@qualigence/mission";
import type {
  SignedSkillBundle,
  SkillReplayResult,
  SkillVerificationScope,
} from "@qualigence/skill";
import type { ReplayTarget, SkillReplayController } from "@qualigence/skill-replay";

/** A Verified Skill seed to replay for regression confirmation. */
export interface RegressionSeed {
  readonly plan: RegressionJobPlan;
  readonly bundle: SignedSkillBundle;
  readonly scope: SkillVerificationScope;
}

/** The aggregate outcome of a regression job across all its repetitions. */
export interface RegressionJobResult {
  readonly skillBundleId: string;
  readonly repetitionsRun: number;
  readonly attempts: readonly SkillReplayResult[];
  readonly status: "passed" | "failed";
}

/**
 * Runs a Verified Skill as a regression seed by replaying its signed Bundle a
 * fixed number of times through the existing LS-08 {@link SkillReplayController}
 * (signature-first, semantics-only). Regression is deterministic: a fresh Target
 * is created per repetition, and `stopOnFirstFailure` halts before the next
 * replay. The runner adds no new replay semantics — it only orchestrates
 * repetitions and aggregates the pass/fail outcome.
 */
export class RegressionJobRunner {
  constructor(private readonly controller: SkillReplayController) {}

  async run(
    seed: RegressionSeed,
    targetFactory: () => ReplayTarget,
  ): Promise<RegressionJobResult> {
    const attempts: SkillReplayResult[] = [];
    let status: "passed" | "failed" = "passed";

    for (let repetition = 0; repetition < seed.plan.repetitions; repetition += 1) {
      const result = await this.controller.run(seed.bundle, targetFactory(), seed.scope);
      attempts.push(result);
      if (result.status !== "passed") {
        status = "failed";
        if (seed.plan.stopOnFirstFailure) {
          break;
        }
      }
    }

    return {
      skillBundleId: seed.plan.skillBundleId,
      repetitionsRun: attempts.length,
      attempts,
      status,
    };
  }
}
