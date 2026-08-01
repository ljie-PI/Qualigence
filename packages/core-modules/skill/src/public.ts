export {
  SkillError,
  skillError,
} from "./domain/skill-types.js";

export type {
  IntentStep,
  ObservationSchemaEpoch,
  OracleResult,
  ProcedureSkillVersion,
  SemanticTarget,
  SkillAssertion,
  SkillCandidate,
  SkillErrorCode,
  SkillEvaluation,
  SkillParameter,
  SkillParameterSensitivity,
  SkillState,
  SkillStep,
  SkillStepRecovery,
  TargetScope,
} from "./domain/skill-types.js";

export {
  TestSkill,
  skillCommand,
} from "./domain/test-skill.js";

export type {
  DeprecateSkillCommand,
  MarkCandidateCommand,
  PromoteSkillCommand,
  SkillCommandBase,
  SkillDraftInput,
  SkillTransition,
  VerifySkillCommand,
} from "./domain/test-skill.js";

export {
  bundlePayloadContentSha256,
  canonicalJson,
  canonicalSigningPayload,
  sha256Hex,
  skillContentSha256,
} from "./domain/skill-bundle.js";

export type {
  CanonicalJsonValue,
  SignedSkillBundle,
  SkillBundleManifest,
  UnsignedSkillBundle,
} from "./domain/skill-bundle.js";

export { SkillSigningError } from "./ports/skill-signer.js";

export type {
  SkillSignatureVerification,
  SkillSigner,
  SkillVerificationScope,
} from "./ports/skill-signer.js";

export type {
  SaveSkillVersionInput,
  SkillRepository,
  SkillRevocation,
} from "./ports/skill-repository.js";

export type {
  ProposedSkillStep,
  SkillInductionProposal,
} from "./domain/proposal.js";

export {
  LOCATOR_SCHEMA_VERSION,
  SKILL_COMPILER_VERSION,
  SkillCompiler,
  SkillCompilerError,
} from "./application/skill-compiler.js";

export type { SkillCompilerErrorCode } from "./application/skill-compiler.js";
