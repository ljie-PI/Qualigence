import type { IntelligenceJob, IntelligenceResult } from "@qualigence/intelligence";
import type {
  BugAnalysisContext,
  InvestigationModelAgentPort,
  ReproductionPlanningContext,
} from "@qualigence/investigation";
import { JobProcessingError, throwIfJobProcessingAborted, type JobProcessor } from "./job-processor.js";

/**
 * Loads the deterministically pre-assembled context for an Intelligence Job.
 * The Worker connects as the least-privilege Worker role and cannot read
 * aggregate tables, so context is delivered out-of-band via the Job's
 * `inputRefs` (artifacts). This port is the seam the artifact-backed loader
 * plugs into.
 */
export interface IntelligenceContextSource {
  loadReproductionPlanning(job: IntelligenceJob, signal?: AbortSignal): Promise<ReproductionPlanningContext>;
  loadBugAnalysis(job: IntelligenceJob, signal?: AbortSignal): Promise<BugAnalysisContext>;
}

/**
 * A {@link JobProcessor} for `investigation.*` Jobs. It loads the Job's context
 * and delegates to a model-backed {@link InvestigationModelAgentPort} (e.g. the
 * `InvestigationAgent`) which returns a strictly-parsed proposal envelope. The
 * processor never advances the Investigation aggregate — that is the Server's
 * job when it applies the appended Result.
 */
export class InvestigationJobProcessor implements JobProcessor {
  constructor(
    private readonly agent: InvestigationModelAgentPort,
    private readonly context: IntelligenceContextSource,
  ) {}

  async process(job: IntelligenceJob, signal?: AbortSignal): Promise<IntelligenceResult> {
    throwIfJobProcessingAborted(signal);
    switch (job.jobType) {
      case "investigation.reproduction-planning": {
        const context = await this.context.loadReproductionPlanning(job, signal);
        throwIfJobProcessingAborted(signal);
        return this.invoke(() => this.agent.proposeReproductionPlan(job, context));
      }
      case "investigation.bug-analysis": {
        const context = await this.context.loadBugAnalysis(job, signal);
        throwIfJobProcessingAborted(signal);
        return this.invoke(() => this.agent.analyzeBug(job, context));
      }
      default:
        throw new JobProcessingError(
          "UnsupportedJobType",
          `this Worker does not handle job type ${job.jobType}`,
        );
    }
  }

  private async invoke(run: () => Promise<IntelligenceResult>): Promise<IntelligenceResult> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof JobProcessingError) {
        throw error;
      }
      throw new JobProcessingError("ModelFailed", "the model dispatch failed", { cause: error });
    }
  }
}
