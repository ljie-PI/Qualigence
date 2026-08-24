import type { RecordingSession } from "@qualigence/recording";
import type { SignedSkillBundle } from "../domain/skill-bundle.js";
import type {
  ProcedureSkillVersion,
  SkillEvaluation,
  SkillState,
} from "../domain/skill-types.js";

export type SkillLifecycleOperation = "promote" | "deprecate";

export interface SkillLifecycleActorContext {
  readonly actorId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

export interface SkillLifecycleCommandBase {
  readonly skillId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actor: SkillLifecycleActorContext;
  readonly occurredAt: string;
}

export interface PromoteSkillLifecycleCommand extends SkillLifecycleCommandBase {
  readonly operation: "promote";
  readonly requiredOracles: readonly string[];
}

export interface DeprecateSkillLifecycleCommand extends SkillLifecycleCommandBase {
  readonly operation: "deprecate";
  readonly reason: string;
}

export type SkillLifecycleCommand =
  | PromoteSkillLifecycleCommand
  | DeprecateSkillLifecycleCommand;

export interface SkillLifecycleAuditEvent {
  readonly auditId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly operation: SkillLifecycleOperation;
  readonly decision: "allowed" | "rejected";
  readonly actor: SkillLifecycleActorContext;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export type SkillLifecycleReplayResult =
  | { readonly status: "not_found" }
  | { readonly status: "replayed"; readonly result: ProcedureSkillVersion }
  | { readonly status: "conflict"; readonly resultVersion: number };

export interface CommitSkillLifecycleCommandInput {
  readonly command: SkillLifecycleCommand;
  readonly commandHash: string;
  readonly previousVersion: ProcedureSkillVersion;
  readonly result: ProcedureSkillVersion;
  readonly audit: SkillLifecycleAuditEvent;
  readonly revocation?: SkillRevocation;
}

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
  versions(skillId: string): Promise<readonly ProcedureSkillVersion[]>;
  latestVersions(): Promise<readonly ProcedureSkillVersion[]>;

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

  replayLifecycleCommand(
    idempotencyKey: string,
    commandHash: string,
  ): Promise<SkillLifecycleReplayResult>;
  commitLifecycleCommand(
    input: CommitSkillLifecycleCommandInput,
  ): Promise<ProcedureSkillVersion>;
  lifecycleAuditEvents(
    skillId: string,
  ): Promise<readonly SkillLifecycleAuditEvent[]>;
}
