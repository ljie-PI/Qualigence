import type {
  ObservationSchemaEpoch,
  ProcedureSkillVersion,
  SkillCandidate,
  SkillEvaluation,
  SkillState,
  TargetScope,
} from "./skill-types.js";
import { skillError } from "./skill-types.js";

export interface SkillDraftInput {
  readonly skillId: string;
  readonly projectId: string;
  readonly targetScope: TargetScope;
}

export interface SkillCommandBase {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface MarkCandidateCommand extends SkillCommandBase {
  readonly candidate: SkillCandidate;
}

export interface VerifySkillCommand extends SkillCommandBase {
  readonly evaluation: SkillEvaluation;
  readonly signatureValid: boolean;
}

export type PromoteSkillCommand = SkillCommandBase;

export interface DeprecateSkillCommand extends SkillCommandBase {
  readonly reason: string;
}

export interface SkillTransition {
  readonly skillId: string;
  readonly fromState: SkillState;
  readonly toState: SkillState;
  readonly version: number;
  readonly idempotencyKey: string;
}

const FORWARD_ORDER: Record<SkillState, number> = {
  draft: 0,
  candidate: 1,
  verified: 2,
  promoted: 3,
  deprecated: 4,
};

/**
 * The Procedure Skill aggregate. Every transition is a single-writer,
 * expected-version optimistic-concurrency command carrying an idempotency key;
 * there is no last-writer-wins. State advances forward only; a model never runs
 * inside the aggregate and no repository is touched here.
 */
export class TestSkill {
  private constructor(
    private readonly skillId_: string,
    private readonly projectId_: string,
    private readonly targetScope_: TargetScope,
    private version_: number,
    private state_: SkillState,
    private candidate: SkillCandidate | undefined,
    private evaluation: SkillEvaluation | undefined,
    private readonly transitions: Map<string, SkillTransition>,
  ) {}

  static draft(input: SkillDraftInput): TestSkill {
    return new TestSkill(
      input.skillId,
      input.projectId,
      input.targetScope,
      1,
      "draft",
      undefined,
      undefined,
      new Map(),
    );
  }

  get skillId(): string {
    return this.skillId_;
  }

  state(): SkillState {
    return this.state_;
  }

  currentVersion(): number {
    return this.version_;
  }

  /** The current compiled snapshot. Throws before a candidate has been compiled. */
  snapshot(): ProcedureSkillVersion {
    if (this.candidate === undefined) {
      throw skillError(
        "SkillNotCandidate",
        `Skill ${this.skillId_} has no compiled version yet.`,
      );
    }
    return this.buildVersion(this.candidate);
  }

  markCandidate(command: MarkCandidateCommand): SkillTransition {
    return this.transition(command, "draft", "candidate", () => {
      this.candidate = command.candidate;
    });
  }

  verify(command: VerifySkillCommand): SkillTransition {
    return this.transition(command, "candidate", "verified", () => {
      if (!command.signatureValid) {
        throw skillError(
          "SkillSignatureInvalid",
          `Skill ${this.skillId_} cannot be verified with an invalid signature.`,
        );
      }
      if (command.evaluation.outcome !== "passed") {
        throw skillError(
          "SkillVerificationFailed",
          `Skill ${this.skillId_} evaluation did not pass all oracles.`,
        );
      }
      this.evaluation = command.evaluation;
    });
  }

  promote(command: PromoteSkillCommand): SkillTransition {
    return this.transition(command, "verified", "promoted", () => {
      if (this.state_ !== "verified") {
        throw skillError(
          "SkillNotVerified",
          `Skill ${this.skillId_} must be verified before promotion.`,
        );
      }
    });
  }

  deprecate(command: DeprecateSkillCommand): SkillTransition {
    if (this.state_ === "deprecated") {
      const replay = this.replayIfIdempotent(command);
      if (replay !== undefined) {
        return replay;
      }
      throw skillError(
        "SkillAlreadyDeprecated",
        `Skill ${this.skillId_} is already deprecated.`,
      );
    }
    return this.applyTransition(command, this.state_, "deprecated");
  }

  private transition(
    command: SkillCommandBase,
    requiredState: SkillState,
    toState: SkillState,
    apply: () => void,
  ): SkillTransition {
    const replay = this.replayIfIdempotent(command);
    if (replay !== undefined) {
      return replay;
    }

    if (this.state_ !== requiredState) {
      throw this.illegalTransitionError(requiredState, toState);
    }
    this.assertExpectedVersion(command.expectedVersion);
    apply();
    return this.commit(command, toState);
  }

  private applyTransition(
    command: SkillCommandBase,
    fromState: SkillState,
    toState: SkillState,
  ): SkillTransition {
    this.assertExpectedVersion(command.expectedVersion);
    return this.commit(command, toState, fromState);
  }

  private commit(
    command: SkillCommandBase,
    toState: SkillState,
    fromStateOverride?: SkillState,
  ): SkillTransition {
    const fromState = fromStateOverride ?? this.state_;
    const transition: SkillTransition = {
      skillId: this.skillId_,
      fromState,
      toState,
      version: this.version_ + 1,
      idempotencyKey: command.idempotencyKey,
    };
    this.version_ = transition.version;
    this.state_ = toState;
    this.transitions.set(command.idempotencyKey, transition);
    return transition;
  }

  private replayIfIdempotent(
    command: SkillCommandBase,
  ): SkillTransition | undefined {
    return this.transitions.get(command.idempotencyKey);
  }

  private assertExpectedVersion(expectedVersion: number): void {
    if (expectedVersion !== this.version_) {
      throw skillError(
        "SkillVersionConflict",
        `Expected version ${expectedVersion} but skill ${this.skillId_} is at version ${this.version_}.`,
      );
    }
  }

  private illegalTransitionError(requiredState: SkillState, toState: SkillState) {
    if (FORWARD_ORDER[this.state_] >= FORWARD_ORDER[toState]) {
      return skillError(
        "SkillStateReversal",
        `Skill ${this.skillId_} is ${this.state_}; a transition to ${toState} would reverse the lifecycle.`,
      );
    }
    if (toState === "promoted") {
      return skillError(
        "SkillNotVerified",
        `Skill ${this.skillId_} must be verified before promotion.`,
      );
    }
    if (toState === "verified") {
      return skillError(
        "SkillNotCandidate",
        `Skill ${this.skillId_} must be a candidate before verification.`,
      );
    }
    return skillError(
      "SkillNotDraft",
      `Skill ${this.skillId_} must be a draft to become a candidate (was ${this.state_}).`,
    );
  }

  private buildVersion(candidate: SkillCandidate): ProcedureSkillVersion {
    return {
      skillId: this.skillId_,
      version: this.version_,
      state: this.state_,
      projectId: this.projectId_,
      targetScope: this.targetScope_,
      parameters: candidate.parameters,
      steps: candidate.steps,
      sourceRecordingIds: candidate.sourceRecordingIds,
      observationSchemaEpoch: candidate.observationSchemaEpoch,
      locatorSchemaVersion: candidate.locatorSchemaVersion,
      compilerVersion: candidate.compilerVersion,
      contentSha256: candidate.contentSha256,
    };
  }
}

export type { ObservationSchemaEpoch };

/** Convenience factory for a versioned command targeting the current version. */
export function skillCommand(
  expectedVersion: number,
  idempotencyKey: string,
): SkillCommandBase {
  return { expectedVersion, idempotencyKey };
}
