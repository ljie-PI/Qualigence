import type { RecordingSession } from "@qualigence/recording";
import {
  SkillCompilerError,
  type SkillCandidate,
  type SkillEvaluation,
  type SkillInductionProposal,
} from "@qualigence/skill";
import { SkillCompiler } from "@qualigence/skill";

/** An immutable reference to the pre-v1 Skill version being recompiled. */
export interface PreV1SkillReference {
  readonly skillId: string;
  readonly projectId: string;
  readonly version: number;
  readonly targetScope: {
    readonly targetId: string;
    readonly allowedOrigins: readonly string[];
  };
  readonly contentSha256: string;
  readonly observationSchemaEpoch: "pre-v1" | "v1";
  readonly locatorSchemaVersion: string;
  readonly compilerVersion: string;
}

/**
 * A pre-v1 Skill migration asset: the immutable source Recording and induction
 * Proposal that produced the pre-v1 Skill, plus a reference to that Skill's
 * persisted version. The recompiler never mutates any of these.
 */
export interface PreV1SkillAsset {
  readonly assetId: string;
  readonly recording: RecordingSession;
  readonly proposal: SkillInductionProposal;
  readonly previous: PreV1SkillReference;
}

/**
 * The reverification port. It takes the freshly recompiled v1 candidate and runs
 * the standard signing + replay + verification path (the same oracles a normal
 * Skill promotion uses), returning an immutable {@link SkillEvaluation}. The
 * recompiler never signs or replays itself — it delegates to the existing,
 * audited verification pipeline so a recompiled Skill is held to the same bar.
 */
export interface RecompiledSkillReverifier {
  verify(input: {
    readonly candidate: SkillCandidate;
    readonly previous: PreV1SkillReference;
  }): Promise<SkillEvaluation>;
}

export type RecompileStatus = "migrated" | "needs_human" | "deprecated" | "failed";

/** The immutable outcome of recompiling one pre-v1 Skill against migrated data. */
export interface RecompileOutcome {
  readonly assetId: string;
  readonly status: RecompileStatus;
  readonly reasonCode?: string;
  readonly candidate?: SkillCandidate;
  readonly evaluation?: SkillEvaluation;
  /** The pre-v1 content digest, echoed unchanged to prove source immutability. */
  readonly sourceContentSha256: string;
  readonly computedContentSha256?: string;
}

export type SkillSourceVerification =
  | {
      readonly status: "valid";
      readonly sourceContentSha256: string;
    }
  | {
      readonly status: "failed";
      readonly outcome: RecompileOutcome;
    };

/**
 * Recompile a pre-v1 Skill against its migrated (v1-projected) source and
 * reverify it. A deterministic compile failure (unsupported action/schema, a
 * leaked selector, an incomplete recording) is `deprecated`; a candidate that
 * compiles but no longer replays identically — a missing/ambiguous locator or a
 * diverged trace — is `needs_human`; a candidate that passes every oracle is a
 * `migrated` Verified v1. The pre-v1 Skill bytes are never touched.
 */
export class SkillRecompiler {
  constructor(
    private readonly reverifier: RecompiledSkillReverifier,
    private readonly compiler: SkillCompiler = new SkillCompiler(),
  ) {}

  verifySource(asset: PreV1SkillAsset): SkillSourceVerification {
    let preV1Candidate: SkillCandidate;
    try {
      preV1Candidate = this.compiler.compile(asset.recording, asset.proposal);
    } catch (error) {
      if (error instanceof SkillCompilerError) {
        return {
          status: "failed",
          outcome: {
            assetId: asset.assetId,
            status: "deprecated",
            reasonCode: error.code,
            sourceContentSha256: asset.previous.contentSha256,
          },
        };
      }
      throw error;
    }

    if (preV1Candidate.contentSha256 !== asset.previous.contentSha256) {
      return {
        status: "failed",
        outcome: {
          assetId: asset.assetId,
          status: "failed",
          reasonCode: "MigrationSourceChanged",
          sourceContentSha256: asset.previous.contentSha256,
          computedContentSha256: preV1Candidate.contentSha256,
        },
      };
    }

    return { status: "valid", sourceContentSha256: preV1Candidate.contentSha256 };
  }

  async recompile(asset: PreV1SkillAsset): Promise<RecompileOutcome> {
    const sourceVerification = this.verifySource(asset);
    if (sourceVerification.status === "failed") {
      return sourceVerification.outcome;
    }

    const v1Recording = migrateRecordingToV1(asset.recording);

    let candidate: SkillCandidate;
    try {
      candidate = this.compiler.compile(v1Recording, asset.proposal);
    } catch (error) {
      if (error instanceof SkillCompilerError) {
        return {
          assetId: asset.assetId,
          status: "deprecated",
          reasonCode: error.code,
          sourceContentSha256: asset.previous.contentSha256,
        };
      }
      throw error;
    }

    const evaluation = await this.reverifier.verify({
      candidate,
      previous: asset.previous,
    });

    if (evaluation.outcome === "passed") {
      return {
        assetId: asset.assetId,
        status: "migrated",
        candidate,
        evaluation,
        sourceContentSha256: asset.previous.contentSha256,
      };
    }

    return {
      assetId: asset.assetId,
      ...classifyFailedEvaluation(evaluation),
      candidate,
      evaluation,
      sourceContentSha256: asset.previous.contentSha256,
    };
  }
}

/**
 * Re-tag an immutable pre-v1 Recording as v1 for recompilation. The historical
 * Recording is never mutated: this returns a new session whose semantics are
 * unchanged (same intents, resolved semantic nodes and checkpoints) but whose
 * observation epoch is now `v1`, so the recompiled Skill is stamped v1.
 */
export function migrateRecordingToV1(
  recording: RecordingSession,
): RecordingSession {
  return { ...recording, observationSchemaEpoch: "v1" };
}

function classifyFailedEvaluation(evaluation: SkillEvaluation): {
  readonly status: RecompileStatus;
  readonly reasonCode: string;
} {
  const failed = new Set(
    evaluation.oracles
      .filter((oracle) => oracle.status === "failed")
      .map((oracle) => oracle.oracle),
  );

  // A locator that no longer resolves (exact/semantic replay) needs a human to
  // re-ground the Skill; it is not something the migrator may silently discard.
  if (failed.has("exact-trace-replay") || failed.has("semantic-tolerant-replay")) {
    return { status: "needs_human", reasonCode: "SkillRecompileFailed" };
  }

  // Signature or precondition failures are deterministic incompatibilities.
  return { status: "deprecated", reasonCode: "SkillRecompileFailed" };
}
