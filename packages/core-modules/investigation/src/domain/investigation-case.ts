import type { IntentStep } from "@qualigence/mission";
import {
  InvestigationBudgetLedger,
  type BudgetDimension,
  type InvestigationBudget,
  type InvestigationBudgetUsage,
} from "./investigation-budget.js";
import type {
  ReproductionAttempt,
  ReproductionAttemptDraft,
} from "./reproduction-attempt.js";

export type InvestigationStatus =
  | "candidate"
  | "investigating"
  | "reproducing"
  | "confirmed"
  | "refuted"
  | "flaky"
  | "needs_human"
  | "resolved"
  | "regression_verified";

/**
 * A confirmed, reproducible bug with a deterministic root-cause narrative. Built
 * only after the confirmation confidence threshold is met and at least one
 * referenced attempt actually reproduced the Finding.
 */
export interface BugEpisode {
  readonly episodeId: string;
  readonly caseId: string;
  readonly findingId: string;
  readonly confirmedAttemptIds: readonly [string, ...string[]];
  readonly expectedClaims: readonly string[];
  readonly observedFacts: readonly string[];
  readonly minimalSteps: readonly IntentStep[];
  readonly environment: Readonly<Record<string, string>>;
  readonly evidenceRefs: readonly string[];
  readonly confidence: number;
}

/** The caller-supplied portion of a BugEpisode; `caseId`/`findingId` are stamped. */
export interface BugEpisodeDraft {
  readonly episodeId: string;
  readonly confirmedAttemptIds: readonly [string, ...string[]];
  readonly expectedClaims: readonly string[];
  readonly observedFacts: readonly string[];
  readonly minimalSteps: readonly IntentStep[];
  readonly environment: Readonly<Record<string, string>>;
  readonly evidenceRefs: readonly string[];
  readonly confidence: number;
}

/** The human-review context assembled when an investigation exits to Needs Human. */
export interface HumanHandoff {
  readonly caseId: string;
  readonly bestHypothesis: string;
  readonly attemptIds: readonly string[];
  readonly lastDivergence?: string;
  readonly keyEvidenceRefs: readonly string[];
  readonly suggestedActions: readonly string[];
  readonly limitationCodes: readonly string[];
}

/** The caller-supplied portion of a handoff when a human escalation is requested. */
export interface HumanHandoffDraft {
  readonly bestHypothesis: string;
  readonly lastDivergence?: string;
  readonly keyEvidenceRefs: readonly string[];
  readonly suggestedActions: readonly string[];
  readonly limitationCodes: readonly string[];
}

export type InvestigationErrorCode =
  | "InvestigationVersionConflict"
  | "InvestigationIllegalTransition"
  | "InvestigationBudgetExhausted"
  | "InvestigationConfirmationRejected"
  | "InvestigationAttemptUnknown";

export class InvestigationError extends Error {
  readonly code: InvestigationErrorCode;

  constructor(code: InvestigationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "InvestigationError";
    this.code = code;
  }
}

export function investigationError(
  code: InvestigationErrorCode,
  message: string,
): InvestigationError {
  return new InvestigationError(code, message);
}

export interface InvestigationCommandBase {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export type StartInvestigationCommand = InvestigationCommandBase;

/** Issues (or, from `reproducing`, revises) the active reproduction plan. */
export type StartReproductionCommand = InvestigationCommandBase;

export interface AppendAttemptCommand extends InvestigationCommandBase {
  readonly attempt: ReproductionAttemptDraft;
}

export interface ConfirmBugCommand extends InvestigationCommandBase {
  readonly episode: BugEpisodeDraft;
}

export interface RefuteCommand extends InvestigationCommandBase {
  readonly reason: string;
}

export interface MarkFlakyCommand extends InvestigationCommandBase {
  readonly reason: string;
}

export interface EscalateToHumanCommand extends InvestigationCommandBase {
  readonly handoff: HumanHandoffDraft;
}

export interface ResolveCommand extends InvestigationCommandBase {
  readonly disposition: string;
}

export type VerifyRegressionCommand = InvestigationCommandBase;

/** The immutable result of applying one command to the aggregate. */
export interface InvestigationTransition {
  readonly caseId: string;
  readonly fromStatus: InvestigationStatus;
  readonly toStatus: InvestigationStatus;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly planRevision: number;
  readonly usage: InvestigationBudgetUsage;
  readonly appendedAttempt?: ReproductionAttempt;
  readonly bugEpisode?: BugEpisode;
  readonly handoff?: HumanHandoff;
  readonly exhaustedDimensions?: readonly BudgetDimension[];
}

export interface InvestigationOpenInput {
  readonly caseId: string;
  readonly findingId: string;
  readonly projectId: string;
  readonly budget: InvestigationBudget;
}

/** Forward-only ordering used to reject lifecycle reversals. */
const FORWARD_ORDER: Record<InvestigationStatus, number> = {
  candidate: 0,
  investigating: 1,
  reproducing: 2,
  confirmed: 3,
  refuted: 3,
  flaky: 3,
  needs_human: 3,
  resolved: 4,
  regression_verified: 5,
};

/**
 * The Investigation aggregate: an in-progress, budget-bounded root-cause
 * investigation of a Finding. Every transition is a single-writer,
 * expected-version optimistic-concurrency command carrying an idempotency key —
 * there is no last-writer-wins. Reproduction Attempts are append-only; a model
 * never runs inside the aggregate, and no repository is touched here. Terminal
 * outcomes (`confirmed` → BugEpisode, `needs_human` → HumanHandoff) are produced
 * only by deterministic rules.
 */
export class InvestigationCase {
  private readonly attempts: ReproductionAttempt[] = [];
  private readonly transitions = new Map<string, InvestigationTransition>();

  private constructor(
    private readonly caseId_: string,
    private readonly findingId_: string,
    private readonly projectId_: string,
    private readonly ledger: InvestigationBudgetLedger,
    private readonly confirmationThreshold_: number,
    private version_: number,
    private status_: InvestigationStatus,
    private planRevision_: number,
    private bugEpisode_: BugEpisode | undefined,
    private handoff_: HumanHandoff | undefined,
  ) {}

  static open(input: InvestigationOpenInput): InvestigationCase {
    return new InvestigationCase(
      input.caseId,
      input.findingId,
      input.projectId,
      InvestigationBudgetLedger.open(input.budget),
      input.budget.confirmationConfidenceThreshold,
      1,
      "candidate",
      0,
      undefined,
      undefined,
    );
  }

  /** Rehydrate a persisted case with its append-only attempts and usage. */
  static restore(input: {
    readonly caseId: string;
    readonly findingId: string;
    readonly projectId: string;
    readonly budget: InvestigationBudget;
    readonly usage: InvestigationBudgetUsage;
    readonly version: number;
    readonly status: InvestigationStatus;
    readonly planRevision: number;
    readonly attempts: readonly ReproductionAttempt[];
    readonly bugEpisode?: BugEpisode;
    readonly handoff?: HumanHandoff;
  }): InvestigationCase {
    const restored = new InvestigationCase(
      input.caseId,
      input.findingId,
      input.projectId,
      InvestigationBudgetLedger.restore(input.budget, input.usage),
      input.budget.confirmationConfidenceThreshold,
      input.version,
      input.status,
      input.planRevision,
      input.bugEpisode,
      input.handoff,
    );
    restored.attempts.push(...input.attempts);
    return restored;
  }

  get caseId(): string {
    return this.caseId_;
  }

  get findingId(): string {
    return this.findingId_;
  }

  get projectId(): string {
    return this.projectId_;
  }

  status(): InvestigationStatus {
    return this.status_;
  }

  currentVersion(): number {
    return this.version_;
  }

  planRevision(): number {
    return this.planRevision_;
  }

  usage(): InvestigationBudgetUsage {
    return this.ledger.usage();
  }

  reproductionAttempts(): readonly ReproductionAttempt[] {
    return [...this.attempts];
  }

  bugEpisode(): BugEpisode | undefined {
    return this.bugEpisode_;
  }

  handoff(): HumanHandoff | undefined {
    return this.handoff_;
  }

  startInvestigation(command: StartInvestigationCommand): InvestigationTransition {
    return this.simpleTransition(command, "candidate", "investigating");
  }

  startReproduction(command: StartReproductionCommand): InvestigationTransition {
    const replay = this.replay(command);
    if (replay !== undefined) {
      return replay;
    }
    if (this.status_ !== "investigating" && this.status_ !== "reproducing") {
      throw this.illegalTransition("reproducing");
    }
    this.assertExpectedVersion(command.expectedVersion);
    const consumed = this.ledger.consumePlanRevision();
    this.planRevision_ += 1;
    if (consumed.exhausted) {
      return this.commitNeedsHuman(command, consumed.exhaustedDimensions, undefined);
    }
    return this.commit(command, "reproducing", {});
  }

  appendAttempt(command: AppendAttemptCommand): InvestigationTransition {
    const replay = this.replay(command);
    if (replay !== undefined) {
      return replay;
    }
    if (this.status_ !== "reproducing") {
      throw this.illegalTransition("reproducing");
    }
    this.assertExpectedVersion(command.expectedVersion);

    const attempt: ReproductionAttempt = {
      attemptId: command.attempt.attemptId,
      caseId: this.caseId_,
      ordinal: this.attempts.length + 1,
      planRevision: this.planRevision_,
      environmentRef: command.attempt.environmentRef,
      startedAt: command.attempt.startedAt,
      completedAt: command.attempt.completedAt,
      outcome: command.attempt.outcome,
      ...(command.attempt.divergenceStepId === undefined
        ? {}
        : { divergenceStepId: command.attempt.divergenceStepId }),
      evidenceRefs: [...command.attempt.evidenceRefs],
      budgetConsumed: command.attempt.budgetConsumed,
    };
    this.attempts.push(attempt);
    const consumed = this.ledger.consumeAttempt(attempt);

    // Budget exhaustion transitions to Needs Human, but never overrides a
    // reproduction that succeeded — that attempt is a confirmation opportunity a
    // deterministic confirm() may still act on.
    if (consumed.exhausted && attempt.outcome !== "reproduced") {
      return this.commitNeedsHuman(command, consumed.exhaustedDimensions, attempt);
    }
    return this.commit(command, "reproducing", { appendedAttempt: attempt });
  }

  confirm(command: ConfirmBugCommand): InvestigationTransition {
    const replay = this.replay(command);
    if (replay !== undefined) {
      return replay;
    }
    if (this.status_ !== "reproducing") {
      throw this.illegalTransition("confirmed");
    }
    this.assertExpectedVersion(command.expectedVersion);

    const threshold = this.confirmationThreshold();
    if (command.episode.confidence < threshold) {
      throw investigationError(
        "InvestigationConfirmationRejected",
        `Confidence ${command.episode.confidence} is below the confirmation threshold ${threshold}.`,
      );
    }
    const reproduced = new Set(
      this.attempts
        .filter((attempt) => attempt.outcome === "reproduced")
        .map((attempt) => attempt.attemptId),
    );
    const confirmedReproduced = command.episode.confirmedAttemptIds.some((id) =>
      reproduced.has(id),
    );
    if (!confirmedReproduced) {
      throw investigationError(
        "InvestigationConfirmationRejected",
        "A BugEpisode requires at least one confirmed attempt that actually reproduced.",
      );
    }
    for (const id of command.episode.confirmedAttemptIds) {
      if (!this.attempts.some((attempt) => attempt.attemptId === id)) {
        throw investigationError(
          "InvestigationAttemptUnknown",
          `Confirmed attempt ${id} is not part of this investigation.`,
        );
      }
    }

    const episode: BugEpisode = {
      episodeId: command.episode.episodeId,
      caseId: this.caseId_,
      findingId: this.findingId_,
      confirmedAttemptIds: command.episode.confirmedAttemptIds,
      expectedClaims: command.episode.expectedClaims,
      observedFacts: command.episode.observedFacts,
      minimalSteps: command.episode.minimalSteps,
      environment: command.episode.environment,
      evidenceRefs: command.episode.evidenceRefs,
      confidence: command.episode.confidence,
    };
    this.bugEpisode_ = episode;
    return this.commit(command, "confirmed", { bugEpisode: episode });
  }

  refute(command: RefuteCommand): InvestigationTransition {
    return this.simpleTransition(command, "reproducing", "refuted");
  }

  markFlaky(command: MarkFlakyCommand): InvestigationTransition {
    return this.simpleTransition(command, "reproducing", "flaky");
  }

  /** Deterministically escalate an ambiguous investigation to human review. */
  escalateToHuman(command: EscalateToHumanCommand): InvestigationTransition {
    const replay = this.replay(command);
    if (replay !== undefined) {
      return replay;
    }
    if (this.status_ !== "investigating" && this.status_ !== "reproducing") {
      throw this.illegalTransition("needs_human");
    }
    this.assertExpectedVersion(command.expectedVersion);
    const handoff = this.buildHandoff(command.handoff, []);
    this.handoff_ = handoff;
    return this.commit(command, "needs_human", { handoff });
  }

  resolve(command: ResolveCommand): InvestigationTransition {
    const replay = this.replay(command);
    if (replay !== undefined) {
      return replay;
    }
    if (
      this.status_ !== "confirmed" &&
      this.status_ !== "refuted" &&
      this.status_ !== "flaky" &&
      this.status_ !== "needs_human"
    ) {
      throw this.illegalTransition("resolved");
    }
    this.assertExpectedVersion(command.expectedVersion);
    return this.commit(command, "resolved", {});
  }

  verifyRegression(command: VerifyRegressionCommand): InvestigationTransition {
    return this.simpleTransition(command, "resolved", "regression_verified");
  }

  private confirmationThreshold(): number {
    return this.confirmationThreshold_;
  }

  private simpleTransition(
    command: InvestigationCommandBase,
    requiredStatus: InvestigationStatus,
    toStatus: InvestigationStatus,
  ): InvestigationTransition {
    const replay = this.replay(command);
    if (replay !== undefined) {
      return replay;
    }
    if (this.status_ !== requiredStatus) {
      throw this.illegalTransition(toStatus);
    }
    this.assertExpectedVersion(command.expectedVersion);
    return this.commit(command, toStatus, {});
  }

  private commitNeedsHuman(
    command: InvestigationCommandBase,
    exhaustedDimensions: readonly BudgetDimension[],
    attempt: ReproductionAttempt | undefined,
  ): InvestigationTransition {
    const handoff = this.buildHandoff(
      {
        bestHypothesis:
          "Investigation exhausted its budget before a confident confirmation.",
        keyEvidenceRefs: attempt?.evidenceRefs ?? [],
        suggestedActions: ["Assign a human reviewer to inspect the attempts."],
        limitationCodes: exhaustedDimensions.map(
          (dimension) => `budget_exhausted:${dimension}`,
        ),
        ...(attempt?.divergenceStepId === undefined
          ? {}
          : { lastDivergence: attempt.divergenceStepId }),
      },
      exhaustedDimensions,
    );
    this.handoff_ = handoff;
    return this.commit(command, "needs_human", {
      handoff,
      exhaustedDimensions,
      ...(attempt === undefined ? {} : { appendedAttempt: attempt }),
    });
  }

  private buildHandoff(
    draft: HumanHandoffDraft,
    exhaustedDimensions: readonly BudgetDimension[],
  ): HumanHandoff {
    const limitationCodes =
      draft.limitationCodes.length > 0
        ? draft.limitationCodes
        : exhaustedDimensions.map((dimension) => `budget_exhausted:${dimension}`);
    return {
      caseId: this.caseId_,
      bestHypothesis: draft.bestHypothesis,
      attemptIds: this.attempts.map((attempt) => attempt.attemptId),
      ...(draft.lastDivergence === undefined
        ? {}
        : { lastDivergence: draft.lastDivergence }),
      keyEvidenceRefs: [...draft.keyEvidenceRefs],
      suggestedActions: [...draft.suggestedActions],
      limitationCodes: [...limitationCodes],
    };
  }

  private commit(
    command: InvestigationCommandBase,
    toStatus: InvestigationStatus,
    extras: {
      readonly appendedAttempt?: ReproductionAttempt;
      readonly bugEpisode?: BugEpisode;
      readonly handoff?: HumanHandoff;
      readonly exhaustedDimensions?: readonly BudgetDimension[];
    },
  ): InvestigationTransition {
    const fromStatus = this.status_;
    const transition: InvestigationTransition = {
      caseId: this.caseId_,
      fromStatus,
      toStatus,
      version: this.version_ + 1,
      idempotencyKey: command.idempotencyKey,
      planRevision: this.planRevision_,
      usage: this.ledger.usage(),
      ...(extras.appendedAttempt === undefined
        ? {}
        : { appendedAttempt: extras.appendedAttempt }),
      ...(extras.bugEpisode === undefined
        ? {}
        : { bugEpisode: extras.bugEpisode }),
      ...(extras.handoff === undefined ? {} : { handoff: extras.handoff }),
      ...(extras.exhaustedDimensions === undefined
        ? {}
        : { exhaustedDimensions: extras.exhaustedDimensions }),
    };
    this.version_ = transition.version;
    this.status_ = toStatus;
    this.transitions.set(command.idempotencyKey, transition);
    return transition;
  }

  private replay(
    command: InvestigationCommandBase,
  ): InvestigationTransition | undefined {
    return this.transitions.get(command.idempotencyKey);
  }

  private assertExpectedVersion(expectedVersion: number): void {
    if (expectedVersion !== this.version_) {
      throw investigationError(
        "InvestigationVersionConflict",
        `Expected version ${expectedVersion} but case ${this.caseId_} is at version ${this.version_}.`,
      );
    }
  }

  private illegalTransition(toStatus: InvestigationStatus): InvestigationError {
    return investigationError(
      "InvestigationIllegalTransition",
      `Case ${this.caseId_} is ${this.status_}; a transition to ${toStatus} is not legal.`,
    );
  }
}
