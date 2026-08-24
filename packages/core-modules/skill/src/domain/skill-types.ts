import type { SemanticTarget } from "@qualigence/application-model";
import type { IntentStep } from "@qualigence/recording";

export type { SemanticTarget };
export type { IntentStep };

/**
 * The immutable lifecycle states of a Procedure Skill version. Transitions are
 * forward-only: `draft → candidate → verified → promoted`, with `deprecated`
 * reachable from any non-deprecated state. A verified/promoted version is never
 * reverted to candidate — a new modification creates a new version instead.
 */
export type SkillState =
  | "draft"
  | "candidate"
  | "verified"
  | "promoted"
  | "deprecated";

/** The Target versions and origins a Skill is scoped to run against. */
export interface TargetScope {
  readonly targetId: string;
  readonly minimumTargetVersion?: string;
  readonly maximumTargetVersion?: string;
  readonly allowedOrigins: readonly string[];
}

export type SkillParameterSensitivity =
  | "public"
  | "internal"
  | "sensitive"
  | "secret";

/** A named, sensitivity-tagged Skill input. Values are always referenced by `valueRef`. */
export interface SkillParameter {
  readonly name: string;
  readonly valueRef: string;
  readonly required: boolean;
  readonly sensitivity: SkillParameterSensitivity;
}

/** A semantic assertion used as a precondition or checkpoint. Never a selector. */
export type SkillAssertion =
  | { readonly kind: "node_present"; readonly target: SemanticTarget }
  | {
      readonly kind: "node_text";
      readonly target: SemanticTarget;
      readonly expected: string;
    }
  | { readonly kind: "claim_satisfied"; readonly claimId: string }
  | { readonly kind: "url_path"; readonly path: string };

export type SkillStepRecovery = "stop" | "reobserve";

/** A single executable Skill step, resolved by semantics at replay time. */
export interface SkillStep {
  readonly stepId: string;
  readonly intent: IntentStep;
  readonly preconditions: readonly SkillAssertion[];
  readonly checkpoint: readonly SkillAssertion[];
  readonly recovery: SkillStepRecovery;
  /** Provenance only — the source node the step was recorded against; never used as a replay locator. */
  readonly sourceNodeId: string;
}

export type ObservationSchemaEpoch = "pre-v1" | "v1";

/**
 * A persisted, immutable Procedure Skill version snapshot. `version` doubles as
 * the aggregate's optimistic-concurrency token; `contentSha256` is a stable
 * digest of the compiled content used for Bundle integrity.
 */
export interface ProcedureSkillVersion {
  readonly skillId: string;
  readonly version: number;
  readonly state: SkillState;
  readonly projectId: string;
  readonly targetScope: TargetScope;
  readonly parameters: readonly SkillParameter[];
  readonly steps: readonly [SkillStep, ...SkillStep[]];
  readonly sourceRecordingIds: readonly [string, ...string[]];
  readonly observationSchemaEpoch: ObservationSchemaEpoch;
  readonly locatorSchemaVersion: string;
  readonly compilerVersion: string;
  readonly contentSha256: string;
}

/**
 * A Candidate payload produced by the deterministic {@link SkillCompiler}. It
 * carries the compiled content; identity (`skillId`, `projectId`, `targetScope`)
 * comes from the draft the candidate is applied to.
 */
export interface SkillCandidate {
  readonly parameters: readonly SkillParameter[];
  readonly steps: readonly [SkillStep, ...SkillStep[]];
  readonly sourceRecordingIds: readonly [string, ...string[]];
  readonly observationSchemaEpoch: ObservationSchemaEpoch;
  readonly locatorSchemaVersion: string;
  readonly compilerVersion: string;
  readonly contentSha256: string;
}

/** The outcome of one replay oracle during verification. */
export interface OracleResult {
  readonly oracle: string;
  readonly status: "passed" | "failed";
  readonly detail?: string;
}

/** An immutable verification evaluation produced by the {@link SkillVerifier}. */
export interface SkillEvaluation {
  readonly evaluationId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly oracles: readonly [OracleResult, ...OracleResult[]];
  readonly outcome: "passed" | "failed";
  readonly signatureValid: boolean;
  readonly createdAt: string;
}

export type SkillErrorCode =
  | "SkillVersionConflict"
  | "SkillIdempotencyConflict"
  | "SkillNotFound"
  | "SkillNotDraft"
  | "SkillNotCandidate"
  | "SkillNotVerified"
  | "SkillVerificationFailed"
  | "SkillSignatureInvalid"
  | "SkillBundleMissing"
  | "SkillAlreadyDeprecated"
  | "SkillStateReversal";

export class SkillError extends Error {
  readonly code: SkillErrorCode;

  constructor(
    code: SkillErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "SkillError";
    this.code = code;
  }
}

export function skillError(
  code: SkillErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): SkillError {
  return new SkillError(code, message, details);
}
