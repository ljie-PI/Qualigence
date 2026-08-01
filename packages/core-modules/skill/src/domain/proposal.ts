import type { IntentStep } from "@qualigence/recording";
import type { SkillAssertion, SkillParameter } from "./skill-types.js";

/**
 * The provider-neutral induction Proposal a model produces from a Recording. It
 * suggests parameters, semantic targets and checkpoints only — never an
 * executable selector, an allocated id, or a persisted artifact. Every step
 * references the source recorded step by ordinal.
 */
export interface SkillInductionProposal {
  readonly parameters: readonly SkillParameter[];
  readonly steps: readonly [ProposedSkillStep, ...ProposedSkillStep[]];
}

export interface ProposedSkillStep {
  readonly sourceRecordedStepOrdinal: number;
  readonly intent: IntentStep;
  readonly preconditions: readonly SkillAssertion[];
  readonly checkpoint: readonly SkillAssertion[];
  readonly recovery: "stop" | "reobserve";
}
