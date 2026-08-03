import type {
  AggregateVersionReader,
  AppliedEffect,
  AppliedResultLedger,
  IntelligenceAggregateRef,
  IntelligenceCommandExecutor,
  IntelligenceJob,
  IntelligenceJobBudget,
  IntelligenceResult,
} from "@qualigence/intelligence";
import { IntelligenceResultApplier } from "@qualigence/intelligence";
import {
  InvestigationCase,
  InvestigationError,
  type BugEpisode,
  type HumanHandoff,
  type InvestigationStatus,
} from "../domain/investigation-case.js";
import type { InvestigationBudget } from "../domain/investigation-budget.js";
import type {
  ReproductionAttempt,
  ReproductionAttemptDraft,
} from "../domain/reproduction-attempt.js";
import {
  bugEpisodeDraftFromResult,
  buildBugAnalysisJob,
  buildReproductionPlanningJob,
  reproductionPlanFromResult,
  type ReproductionPlan,
} from "./reproduction-planner.js";

export interface ReproductionPlanningContext {
  readonly caseId: string;
  readonly findingId: string;
  readonly planRevision: number;
  readonly priorAttempts: readonly ReproductionAttempt[];
}

export interface BugAnalysisContext {
  readonly caseId: string;
  readonly findingId: string;
  readonly reproducedAttempts: readonly ReproductionAttempt[];
}

/** The model-facing port. It only ever proposes an {@link IntelligenceResult}. */
export interface InvestigationModelAgentPort {
  proposeReproductionPlan(
    job: IntelligenceJob,
    context: ReproductionPlanningContext,
  ): Promise<IntelligenceResult>;
  analyzeBug(
    job: IntelligenceJob,
    context: BugAnalysisContext,
  ): Promise<IntelligenceResult>;
}

/** The deterministic runner port that executes a snapshotted plan against a Target. */
export interface ReproductionRunnerPort {
  reproduce(plan: ReproductionPlan): Promise<ReproductionAttemptDraft>;
}

export interface InvestigationCoordinatorConfig {
  readonly tenantId: string;
  readonly modelProfileId: string;
  readonly dataPolicyId: string;
  readonly jobBudget: IntelligenceJobBudget;
  readonly maxPlanRevisions: number;
}

export interface InvestigateInput {
  readonly caseId: string;
  readonly findingId: string;
  readonly projectId: string;
  readonly budget: InvestigationBudget;
  readonly inputRefs: readonly string[];
}

export interface InvestigationOutcome {
  readonly caseId: string;
  readonly status: InvestigationStatus;
  readonly attempts: readonly ReproductionAttempt[];
  readonly bugEpisode?: BugEpisode;
  readonly handoff?: HumanHandoff;
}

/** A version reader bound to a single in-memory aggregate instance. */
class CaseVersionReader implements AggregateVersionReader {
  constructor(private readonly investigation: InvestigationCase) {}
  async currentVersion(
    ref: IntelligenceAggregateRef,
  ): Promise<number | undefined> {
    if (ref.type !== "investigation" || ref.id !== this.investigation.caseId) {
      return undefined;
    }
    return this.investigation.currentVersion();
  }
}

class InMemoryAppliedResultLedger implements AppliedResultLedger {
  private readonly applied = new Map<string, AppliedEffect>();
  async find(idempotencyKey: string): Promise<AppliedEffect | undefined> {
    return this.applied.get(idempotencyKey);
  }
  async record(idempotencyKey: string, effect: AppliedEffect): Promise<void> {
    this.applied.set(idempotencyKey, effect);
  }
}

/**
 * The deterministic command executor: it is the ONLY code that mutates the
 * Investigation aggregate from a model result. For a planning result it consumes
 * a plan revision (`startReproduction`); for an analysis result it confirms a
 * BugEpisode when the aggregate's own confirmation rule is satisfied, otherwise
 * it deterministically escalates to Needs Human. The model output is never
 * trusted to advance state on its own.
 */
class InvestigationCommandExecutor implements IntelligenceCommandExecutor {
  constructor(
    private readonly investigation: InvestigationCase,
    private readonly planSnapshots: Map<number, ReproductionPlan>,
  ) {}

  async execute(
    job: IntelligenceJob,
    result: IntelligenceResult,
  ): Promise<AppliedEffect> {
    if (job.jobType === "investigation.reproduction-planning") {
      const transition = this.investigation.startReproduction({
        expectedVersion: this.investigation.currentVersion(),
        idempotencyKey: result.idempotencyKey,
      });
      const plan = reproductionPlanFromResult(
        this.investigation.caseId,
        this.investigation.planRevision(),
        result,
      );
      this.planSnapshots.set(plan.planRevision, plan);
      return this.effect(transition.toStatus);
    }

    if (job.jobType === "investigation.bug-analysis") {
      const draft = bugEpisodeDraftFromResult(
        result,
        `${this.investigation.caseId}:episode:${result.idempotencyKey}`,
      );
      try {
        const transition = this.investigation.confirm({
          expectedVersion: this.investigation.currentVersion(),
          idempotencyKey: result.idempotencyKey,
          episode: draft,
        });
        return this.effect(transition.toStatus);
      } catch (error) {
        if (
          error instanceof InvestigationError &&
          (error.code === "InvestigationConfirmationRejected" ||
            error.code === "InvestigationAttemptUnknown")
        ) {
          const transition = this.investigation.escalateToHuman({
            expectedVersion: this.investigation.currentVersion(),
            idempotencyKey: `${result.idempotencyKey}:escalate`,
            handoff: {
              bestHypothesis:
                "Bug analysis did not meet the deterministic confirmation rule.",
              keyEvidenceRefs: [...result.evidenceRefs],
              suggestedActions: ["Assign a human reviewer to confirm or refute."],
              limitationCodes: ["confirmation_rejected"],
            },
          });
          return this.effect(transition.toStatus);
        }
        throw error;
      }
    }

    throw new Error(`Unsupported investigation job type ${job.jobType}.`);
  }

  private effect(status: InvestigationStatus): AppliedEffect {
    return {
      aggregateType: "investigation",
      aggregateId: this.investigation.caseId,
      newVersion: this.investigation.currentVersion(),
      summary: status,
    };
  }
}

/**
 * Coordinates a bounded, model-assisted reproduction of a Finding. It dispatches
 * Intelligence Jobs, invokes the model agent, and passes every result through the
 * deterministic {@link IntelligenceResultApplier} before any aggregate mutation.
 * The reproduction attempts themselves are produced by a deterministic Runner
 * port and appended by this coordinator — never by the model.
 */
export class InvestigationCoordinator {
  constructor(
    private readonly agent: InvestigationModelAgentPort,
    private readonly runner: ReproductionRunnerPort,
    private readonly config: InvestigationCoordinatorConfig,
    private readonly newId: () => string,
  ) {}

  async investigate(input: InvestigateInput): Promise<InvestigationOutcome> {
    const investigation = InvestigationCase.open({
      caseId: input.caseId,
      findingId: input.findingId,
      projectId: input.projectId,
      budget: input.budget,
    });
    investigation.startInvestigation({
      expectedVersion: investigation.currentVersion(),
      idempotencyKey: `${input.caseId}:start`,
    });

    const planSnapshots = new Map<number, ReproductionPlan>();
    const ledger = new InMemoryAppliedResultLedger();
    const applier = new IntelligenceResultApplier({
      ledger,
      versions: new CaseVersionReader(investigation),
      executor: new InvestigationCommandExecutor(investigation, planSnapshots),
    });

    for (let revision = 0; revision < this.config.maxPlanRevisions; revision += 1) {
      // 1. Model-assisted reproduction planning, gated by the applier.
      const planJob = buildReproductionPlanningJob({
        jobId: this.newId(),
        caseId: input.caseId,
        projectId: input.projectId,
        tenantId: this.config.tenantId,
        baseAggregateVersion: investigation.currentVersion(),
        inputRefs: input.inputRefs,
        modelProfileId: this.config.modelProfileId,
        dataPolicyId: this.config.dataPolicyId,
        budget: this.config.jobBudget,
        idempotencyKey: `${input.caseId}:plan:${revision}`,
        causationId: input.findingId,
      });
      const planResult = await this.agent.proposeReproductionPlan(planJob, {
        caseId: input.caseId,
        findingId: input.findingId,
        planRevision: revision + 1,
        priorAttempts: investigation.reproductionAttempts(),
      });
      const planApply = await applier.apply(planJob, planResult);
      if (planApply.status === "rejected") {
        return this.escalate(investigation, `plan_${planApply.code}`);
      }
      if (investigation.status() === "needs_human") {
        return this.outcome(investigation);
      }

      const plan = planSnapshots.get(investigation.planRevision());
      if (plan === undefined) {
        return this.escalate(investigation, "plan_missing_snapshot");
      }

      // 2. Deterministic runner reproduction; the attempt is a Runner submission.
      const attempt = await this.runner.reproduce(plan);
      investigation.appendAttempt({
        expectedVersion: investigation.currentVersion(),
        idempotencyKey: `${input.caseId}:attempt:${attempt.attemptId}`,
        attempt,
      });
      if (investigation.status() === "needs_human") {
        return this.outcome(investigation);
      }

      // 3. On a reproduction, run bug analysis and confirm deterministically.
      if (attempt.outcome === "reproduced") {
        const analysisJob = buildBugAnalysisJob({
          jobId: this.newId(),
          caseId: input.caseId,
          projectId: input.projectId,
          tenantId: this.config.tenantId,
          baseAggregateVersion: investigation.currentVersion(),
          inputRefs: input.inputRefs,
          modelProfileId: this.config.modelProfileId,
          dataPolicyId: this.config.dataPolicyId,
          budget: this.config.jobBudget,
          idempotencyKey: `${input.caseId}:analysis:${revision}`,
          causationId: input.findingId,
        });
        const analysisResult = await this.agent.analyzeBug(analysisJob, {
          caseId: input.caseId,
          findingId: input.findingId,
          reproducedAttempts: investigation
            .reproductionAttempts()
            .filter((a) => a.outcome === "reproduced"),
        });
        await applier.apply(analysisJob, analysisResult);
        if (
          investigation.status() === "confirmed" ||
          investigation.status() === "needs_human"
        ) {
          return this.outcome(investigation);
        }
      }
      // Otherwise (diverged / not_reproduced / blocked) loop to revise the plan.
    }

    return this.escalate(investigation, "plan_revisions_exhausted");
  }

  private escalate(
    investigation: InvestigationCase,
    reason: string,
  ): InvestigationOutcome {
    if (
      investigation.status() === "investigating" ||
      investigation.status() === "reproducing"
    ) {
      investigation.escalateToHuman({
        expectedVersion: investigation.currentVersion(),
        idempotencyKey: `${investigation.caseId}:escalate:${reason}`,
        handoff: {
          bestHypothesis: "Automated reproduction could not reach a conclusion.",
          keyEvidenceRefs: [],
          suggestedActions: ["Assign a human reviewer."],
          limitationCodes: [reason],
        },
      });
    }
    return this.outcome(investigation);
  }

  private outcome(investigation: InvestigationCase): InvestigationOutcome {
    const bugEpisode = investigation.bugEpisode();
    const handoff = investigation.handoff();
    return {
      caseId: investigation.caseId,
      status: investigation.status(),
      attempts: investigation.reproductionAttempts(),
      ...(bugEpisode === undefined ? {} : { bugEpisode }),
      ...(handoff === undefined ? {} : { handoff }),
    };
  }
}
