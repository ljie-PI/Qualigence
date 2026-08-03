import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { StructuredModelInvoker } from "@qualigence/model-gateway";
import type {
  JsonSchema,
  StructuredOutputContract,
  StructuredOutputValidationIssue,
} from "@qualigence/model-provider";
import type {
  IntelligenceJob,
  IntelligenceResult,
} from "@qualigence/intelligence";
import type {
  BugAnalysisContext,
  InvestigationModelAgentPort,
  ReproductionPlanningContext,
} from "@qualigence/investigation";

const semanticTargetSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    purpose: z.string().min(1),
  })
  .strict();

const intentStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("click"), target: semanticTargetSchema }).strict(),
  z
    .object({
      kind: z.literal("input"),
      target: semanticTargetSchema,
      valueRef: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("verify"),
      claimIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);

const planProposalSchema = z
  .object({
    steps: z.array(intentStepSchema).min(1),
    rationale: z.string().min(1),
  })
  .strict();

const analysisProposalSchema = z
  .object({
    episodeId: z.string().min(1).optional(),
    confirmedAttemptIds: z.array(z.string().min(1)).min(1),
    expectedClaims: z.array(z.string()),
    observedFacts: z.array(z.string()),
    minimalSteps: z.array(intentStepSchema),
    environment: z.record(z.string(), z.string()),
    confidence: z.number().min(0).max(1),
  })
  .strict();

type PlanProposal = z.output<typeof planProposalSchema>;
type AnalysisProposal = z.output<typeof analysisProposalSchema>;

const INVESTIGATION_TIMEOUT_MS = 60_000;

/**
 * The model-backed investigation agent. Given a persistent {@link IntelligenceJob}
 * and the deterministic context assembled by the coordinator, it invokes the
 * Model Gateway with the `investigation.reproduction-planning` or
 * `investigation.bug-analysis` operation and returns a strictly-parsed
 * {@link IntelligenceResult} envelope whose `jobId`/`idempotencyKey` echo the Job.
 *
 * The agent is powerless: it proposes only, never advances the Investigation
 * aggregate, never sets budget or confirmation, and never emits an executable
 * selector. The deterministic coordinator and aggregate own every decision.
 */
export class InvestigationAgent implements InvestigationModelAgentPort {
  constructor(
    private readonly gateway: StructuredModelInvoker,
    private readonly model: string,
  ) {}

  async proposeReproductionPlan(
    job: IntelligenceJob,
    context: ReproductionPlanningContext,
  ): Promise<IntelligenceResult> {
    const result = await this.gateway.invokeStructured(
      {
        operation: "investigation.reproduction-planning",
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "Propose a minimal, deterministic reproduction plan for the Finding " +
              "as an ordered list of semantic intent steps. Reference elements only " +
              "by their semantic purpose/role/name — never a CSS/XPath/coordinate " +
              "or script selector. You only propose; the coordinator decides budget, " +
              "grounding and whether to run the plan.",
          },
          {
            role: "user",
            content: JSON.stringify({
              caseId: context.caseId,
              findingId: context.findingId,
              planRevision: context.planRevision,
              priorAttempts: context.priorAttempts.map((attempt) => ({
                ordinal: attempt.ordinal,
                outcome: attempt.outcome,
                divergenceStepId: attempt.divergenceStepId,
              })),
            }),
          },
        ],
        timeoutMs: INVESTIGATION_TIMEOUT_MS,
        invocation: { runId: context.caseId, invocationId: uuidv7() },
      },
      planContract(),
    );

    const proposal = result.value;
    return {
      jobId: job.jobId,
      resultSchemaVersion: "intelligence-result/v1",
      proposals: [proposal as Readonly<Record<string, unknown>>],
      evidenceRefs: [...job.inputRefs],
      confidence: 1,
      provenance: [result.model],
      usage: usageFrom(result.usage),
      terminalStatus: "succeeded",
      idempotencyKey: job.idempotencyKey,
    };
  }

  async analyzeBug(
    job: IntelligenceJob,
    context: BugAnalysisContext,
  ): Promise<IntelligenceResult> {
    const result = await this.gateway.invokeStructured(
      {
        operation: "investigation.bug-analysis",
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "Analyze the reproduced Finding and produce a bug episode proposal: " +
              "the confirmed attempt ids, the expected claims, the observed facts, " +
              "the minimal semantic steps and the environment, plus a calibrated " +
              "confidence in [0,1]. Never emit a selector. You only propose; the " +
              "deterministic rule decides whether to confirm.",
          },
          {
            role: "user",
            content: JSON.stringify({
              caseId: context.caseId,
              findingId: context.findingId,
              reproducedAttempts: context.reproducedAttempts.map((attempt) => ({
                attemptId: attempt.attemptId,
                ordinal: attempt.ordinal,
                evidenceRefs: attempt.evidenceRefs,
              })),
            }),
          },
        ],
        timeoutMs: INVESTIGATION_TIMEOUT_MS,
        invocation: { runId: context.caseId, invocationId: uuidv7() },
      },
      analysisContract(),
    );

    const proposal = result.value;
    return {
      jobId: job.jobId,
      resultSchemaVersion: "intelligence-result/v1",
      proposals: [proposal as unknown as Readonly<Record<string, unknown>>],
      evidenceRefs: [...job.inputRefs],
      confidence: proposal.confidence,
      provenance: [result.model],
      usage: usageFrom(result.usage),
      terminalStatus: "succeeded",
      idempotencyKey: job.idempotencyKey,
    };
  }
}

function usageFrom(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): IntelligenceResult["usage"] {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costMicros: 0,
  };
}

function planContract(): StructuredOutputContract<PlanProposal> {
  return {
    name: "investigation-reproduction-plan",
    jsonSchema: z.toJSONSchema(planProposalSchema) as JsonSchema,
    parse(value: unknown): PlanProposal {
      return parseSchema(planProposalSchema, value);
    },
  };
}

function analysisContract(): StructuredOutputContract<AnalysisProposal> {
  return {
    name: "investigation-bug-analysis",
    jsonSchema: z.toJSONSchema(analysisProposalSchema) as JsonSchema,
    parse(value: unknown): AnalysisProposal {
      return parseSchema(analysisProposalSchema, value);
    },
  };
}

function parseSchema<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw structuredOutputValidationError(
      result.error.issues.map((issue) => ({
        path: formatIssuePath(issue.path),
        reason: issue.code,
      })),
    );
  }
  return result.data;
}

function structuredOutputValidationError(
  issues: readonly StructuredOutputValidationIssue[],
): Error {
  return Object.assign(
    new Error("The investigation output failed structured validation."),
    {
      name: "StructuredOutputValidationError" as const,
      issues,
    },
  );
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
    } else {
      formatted += `${formatted.length === 0 ? "" : "."}${String(segment)}`;
    }
  }
  return formatted.length === 0 ? "output" : formatted;
}

function uuidv7(): string {
  const bytes = randomBytes(16);
  const timestamp = Date.now();
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
