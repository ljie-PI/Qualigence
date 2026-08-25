import { describe, expect, it } from "vitest";
import {
  InvestigationJobProcessor,
  JobProcessingError,
  type IntelligenceContextSource,
} from "@qualigence/intelligence-worker";
import type { IntelligenceJob, IntelligenceResult } from "@qualigence/intelligence";
import type {
  BugAnalysisContext,
  InvestigationModelAgentPort,
  ReproductionPlanningContext,
} from "@qualigence/investigation";

function job(overrides: Partial<IntelligenceJob> = {}): IntelligenceJob {
  return {
    jobId: "job-1",
    jobType: "investigation.reproduction-planning",
    schemaVersion: "intelligence-job/v1",
    tenantId: "tenant-a",
    projectId: "project-1",
    aggregateRef: { type: "investigation", id: "case-1" },
    baseAggregateVersion: 0,
    inputRefs: ["ctx/case-1.json"],
    modelProfileId: "profile-1",
    dataPolicyId: "policy-1",
    budget: { maximumTokens: 1000, maximumCostMicros: 1000, timeoutMs: 60000 },
    priority: "normal",
    idempotencyKey: "idem-1",
    causationId: "cause-1",
    expectedResultSchema: "intelligence-result/v1",
    ...overrides,
  };
}

const succeeded: IntelligenceResult = {
  jobId: "job-1",
  resultSchemaVersion: "intelligence-result/v1",
  proposals: [{ steps: [], rationale: "ok" }],
  evidenceRefs: [],
  confidence: 1,
  provenance: ["model-x"],
  usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
  terminalStatus: "succeeded",
  idempotencyKey: "idem-1",
};

const reproContext: ReproductionPlanningContext = {
  caseId: "case-1",
  findingId: "finding-1",
  planRevision: 1,
  priorAttempts: [],
};

const bugContext = {
  caseId: "case-1",
  findingId: "finding-1",
} as BugAnalysisContext;

function contextSource(
  overrides: Partial<IntelligenceContextSource> = {},
): IntelligenceContextSource {
  return {
    loadReproductionPlanning: async () => reproContext,
    loadBugAnalysis: async () => bugContext,
    ...overrides,
  };
}

describe("InvestigationJobProcessor", () => {
  it("dispatches reproduction-planning to the agent with the loaded context", async () => {
    const seen: { job?: IntelligenceJob; context?: ReproductionPlanningContext } = {};
    const agent: InvestigationModelAgentPort = {
      proposeReproductionPlan: async (j, c) => {
        seen.job = j;
        seen.context = c;
        return succeeded;
      },
      analyzeBug: async () => {
        throw new Error("should not be called");
      },
    };
    const processor = new InvestigationJobProcessor(agent, contextSource());

    const result = await processor.process(job());

    expect(result).toBe(succeeded);
    expect(seen.job?.jobId).toBe("job-1");
    expect(seen.context).toBe(reproContext);
  });

  it("dispatches bug-analysis to the agent", async () => {
    let called = false;
    const agent: InvestigationModelAgentPort = {
      proposeReproductionPlan: async () => {
        throw new Error("wrong branch");
      },
      analyzeBug: async () => {
        called = true;
        return succeeded;
      },
    };
    const processor = new InvestigationJobProcessor(agent, contextSource());

    const result = await processor.process(job({ jobType: "investigation.bug-analysis" }));

    expect(called).toBe(true);
    expect(result).toBe(succeeded);
  });

  it("does not invoke model work when the processor signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const agent: InvestigationModelAgentPort = {
      proposeReproductionPlan: async () => {
        throw new Error("model should not be called");
      },
      analyzeBug: async () => {
        throw new Error("model should not be called");
      },
    };
    const processor = new InvestigationJobProcessor(agent, contextSource());

    await expect(processor.process(job(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("checks for abort after context loading and before model work", async () => {
    const controller = new AbortController();
    let modelCalled = false;
    const agent: InvestigationModelAgentPort = {
      proposeReproductionPlan: async () => {
        modelCalled = true;
        return succeeded;
      },
      analyzeBug: async () => succeeded,
    };
    const processor = new InvestigationJobProcessor(
      agent,
      contextSource({
        loadReproductionPlanning: async () => {
          controller.abort();
          return reproContext;
        },
      }),
    );

    await expect(processor.process(job(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(modelCalled).toBe(false);
  });

  it("rejects a job type it does not handle", async () => {
    const agent: InvestigationModelAgentPort = {
      proposeReproductionPlan: async () => succeeded,
      analyzeBug: async () => succeeded,
    };
    const processor = new InvestigationJobProcessor(agent, contextSource());

    await expect(processor.process(job({ jobType: "prd.planning" }))).rejects.toMatchObject({
      code: "UnsupportedJobType",
    });
  });

  it("wraps a model failure as a ModelFailed processing error", async () => {
    const agent: InvestigationModelAgentPort = {
      proposeReproductionPlan: async () => {
        throw new Error("provider 500");
      },
      analyzeBug: async () => succeeded,
    };
    const processor = new InvestigationJobProcessor(agent, contextSource());

    const error = await processor.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobProcessingError);
    expect((error as JobProcessingError).code).toBe("ModelFailed");
  });

  it("propagates a ContextUnavailable error without masking it", async () => {
    const agent: InvestigationModelAgentPort = {
      proposeReproductionPlan: async () => succeeded,
      analyzeBug: async () => succeeded,
    };
    const processor = new InvestigationJobProcessor(
      agent,
      contextSource({
        loadReproductionPlanning: async () => {
          throw new JobProcessingError("ContextUnavailable", "missing artifact");
        },
      }),
    );

    await expect(processor.process(job())).rejects.toMatchObject({ code: "ContextUnavailable" });
  });
});
