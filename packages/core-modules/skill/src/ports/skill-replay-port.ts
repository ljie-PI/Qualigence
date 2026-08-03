import type { SignedSkillBundle } from "../domain/skill-bundle.js";

/**
 * A single replay fixture the {@link SkillReplayPort} exercises. `kind` selects
 * the oracle dimension a fixture feeds:
 *  - `normal`: an unchanged target that must replay to `passed`.
 *  - `dom-variation`: reordered/slightly-changed DOM that must still `passed`.
 *  - `precondition-negative`: an unsatisfied precondition that must safely
 *    `blocked` with `PlanDiverged` before any action.
 */
export interface SkillReplayFixture {
  readonly name: string;
  readonly kind: "normal" | "dom-variation" | "precondition-negative";
}

export type SkillReplayResult =
  | { readonly status: "passed" }
  | { readonly status: "blocked"; readonly errorCode: string };

/** The port the {@link SkillVerifier} uses to replay a Bundle against a fixture. */
export interface SkillReplayPort {
  replay(
    bundle: SignedSkillBundle,
    fixture: SkillReplayFixture,
  ): Promise<SkillReplayResult>;
}
