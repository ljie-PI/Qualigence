import type { RecordingSession } from "@qualigence/recording";
import type { SignedSkillBundle } from "../domain/skill-bundle.js";
import type {
  ProcedureSkillVersion,
  SkillEvaluation,
  SkillState,
} from "../domain/skill-types.js";

/** A revocation entry appended when a Skill version must no longer be dispatched. */
export interface SkillRevocation {
  readonly revocationId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly reason: string;
  readonly revokedAt: string;
}

export interface SaveSkillVersionInput {
  readonly version: ProcedureSkillVersion;
  readonly expectedVersion: number;
  readonly sourceRecording: RecordingSession;
}

/**
 * The persistence port for Recordings and Skills. Implementations persist
 * immutable version snapshots, evaluations and signed Bundles with optimistic
 * concurrency; revocations are append-only and signing private keys are never
 * stored.
 */
export interface SkillRepository {
  saveRecording(recording: RecordingSession): Promise<void>;
  loadRecording(recordingId: string): Promise<RecordingSession | undefined>;

  saveSkillVersion(input: SaveSkillVersionInput): Promise<void>;
  version(
    skillId: string,
    version: number,
  ): Promise<ProcedureSkillVersion | undefined>;
  latestVersion(skillId: string): Promise<ProcedureSkillVersion | undefined>;
  versionsInState(
    skillId: string,
    state: SkillState,
  ): Promise<readonly ProcedureSkillVersion[]>;

  saveEvaluation(evaluation: SkillEvaluation): Promise<void>;
  evaluations(
    skillId: string,
    version: number,
  ): Promise<readonly SkillEvaluation[]>;

  saveBundle(bundle: SignedSkillBundle): Promise<void>;
  bundle(
    skillId: string,
    version: number,
  ): Promise<SignedSkillBundle | undefined>;

  revoke(revocation: SkillRevocation): Promise<void>;
  isRevoked(skillId: string, version: number): Promise<boolean>;
}
