import type { SkillSignatureVerification } from "../ports/skill-signer.js";
import type {
  ProcedureSkillVersion,
  SkillEvaluation,
} from "../domain/skill-types.js";

export type PromotionRejectionCode =
  | "SkillNotVerified"
  | "SkillVerificationFailed"
  | "SkillSignatureInvalid";

export interface PromotionPolicyInput {
  readonly version: ProcedureSkillVersion;
  readonly evaluation: SkillEvaluation;
  readonly signatureVerification: SkillSignatureVerification;
  readonly requiredOracles: readonly string[];
}

export type PromotionDecision =
  | { readonly status: "approved" }
  | {
      readonly status: "rejected";
      readonly code: PromotionRejectionCode;
      readonly message: string;
    };

/**
 * The deterministic gate that decides whether a `verified` Skill version may be
 * promoted. It requires the version to be verified, its evaluation to have
 * passed every required replay oracle, and its Bundle signature to be valid.
 * There is no manual override that bypasses a failed replay or an invalid
 * signature.
 */
export class SkillPromotionPolicy {
  evaluate(input: PromotionPolicyInput): PromotionDecision {
    if (input.version.state !== "verified") {
      return reject(
        "SkillNotVerified",
        `Skill ${input.version.skillId} must be verified before promotion (was ${input.version.state}).`,
      );
    }

    if (input.signatureVerification.status !== "valid") {
      return reject(
        "SkillSignatureInvalid",
        "A Skill cannot be promoted without a valid Bundle signature.",
      );
    }

    if (input.evaluation.outcome !== "passed") {
      return reject(
        "SkillVerificationFailed",
        "A Skill cannot be promoted unless its replay evaluation passed.",
      );
    }

    if (!input.evaluation.signatureValid) {
      return reject(
        "SkillSignatureInvalid",
        "The recorded evaluation did not confirm a valid signature.",
      );
    }

    const passedOracles = new Set(
      input.evaluation.oracles
        .filter((oracle) => oracle.status === "passed")
        .map((oracle) => oracle.oracle),
    );
    for (const required of input.requiredOracles) {
      if (!passedOracles.has(required)) {
        return reject(
          "SkillVerificationFailed",
          `Required replay oracle "${required}" did not pass.`,
        );
      }
    }

    return { status: "approved" };
  }
}

function reject(
  code: PromotionRejectionCode,
  message: string,
): PromotionDecision {
  return { status: "rejected", code, message };
}
