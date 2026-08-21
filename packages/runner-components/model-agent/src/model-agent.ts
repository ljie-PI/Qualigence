import { z } from "zod";
import { randomBytes } from "node:crypto";
import {
  ModelGatewayAbortError,
  ModelGatewayError,
  ModelGatewayInvocationError,
} from "@qualigence/model-gateway";
import type { StructuredModelInvoker } from "@qualigence/model-gateway";
import {
  ExecutionBlockedError,
  ExecutionBudgetError,
  resolvedActionNodeId,
} from "@qualigence/runner-kernel";
import type {
  JsonSchema,
  StructuredOutputContract,
  StructuredOutputValidationError,
  StructuredOutputValidationIssue,
} from "@qualigence/model-provider";
import type {
  AgentContext,
  AnyProposedAction,
  ExecutionDecisionProvider,
  ProposedAction,
  VerificationContext,
  VerificationResult,
  Verifier,
} from "@qualigence/runner-kernel";
import type {
  ExecutionPlanStep,
  ObservationGraph,
  ObservationNode,
  VerificationClaim,
} from "@qualigence/runner-protocol";

const clickDecisionSchema = z
  .object({
    action: z.object({ kind: z.literal("click"), nodeId: z.string().min(1) }).strict(),
    reason: z.string().min(1),
  })
  .strict();

const plannedDecisionSchema = z
  .object({
    nodeId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const evidenceValueSchema = z
  .object({
    graphId: z.string().min(1),
    nodeId: z.string().min(1),
    text: z.string().trim().min(1),
  })
  .strict();

const verificationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("passed"),
      summary: z.string().min(1),
      claims: z.array(evidenceValueSchema).length(0),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      summary: z.string().min(1),
      severitySuggestion: z.enum(["low", "medium", "high"]),
      claims: z
        .array(
          z
            .object({ expected: evidenceValueSchema, observed: evidenceValueSchema })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);

type DecisionProposal =
  | { readonly action: { readonly kind: "click"; readonly nodeId: string }; readonly reason: string }
  | { readonly nodeId: string; readonly reason: string };

type CurrentPlanActionStep = Extract<ExecutionPlanStep, { readonly kind: "input" | "select" }>;

export class InvalidModelEvidenceError extends Error implements StructuredOutputValidationError {
  readonly name = "StructuredOutputValidationError" as const;
  readonly issues: readonly StructuredOutputValidationIssue[];

  constructor(path: string, reason: string) {
    super("The model returned an invalid evidence reference.");
    this.issues = [{ path, reason }];
  }
}

export class ModelBackedDecisionProvider implements ExecutionDecisionProvider {
  constructor(
    private readonly gateway: StructuredModelInvoker,
    private readonly model: string,
    private readonly currentStep?: CurrentPlanActionStep,
  ) {}

  decide(context: AgentContext): Promise<ProposedAction>;
  async decide(context: AgentContext): Promise<AnyProposedAction> {
    try {
      const maximumOutputTokens = context.budget?.maximumOutputTokens(context.job.runId);
      const result = await this.gateway.invokeStructured(
        {
          operation: "execution.decision",
          model: this.model,
          messages: [
            {
              role: "system",
              content: this.currentStep === undefined
                ? "Choose one visible node for the requested web action. Return only a click nodeId and a concise reason."
                : `Choose one visible node for the immutable ${this.currentStep.kind} Plan step. Return only nodeId and a concise reason.`,
            },
            {
              role: "user",
              content: JSON.stringify({
                objective: context.job.objective,
                ...(this.currentStep === undefined ? {} : { step: this.currentStep }),
                observation: context.observation,
              }),
            },
          ],
          timeoutMs: 30_000,
          ...(maximumOutputTokens === undefined ? {} : { maximumOutputTokens }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          invocation: { runId: context.job.runId, invocationId: uuidv7() },
        },
        decisionContract(context, this.currentStep),
      );
      consumeUsageState(context, result.usageState, result.usage);

      return toProposedAction(result.value, this.currentStep);
    } catch (error) {
      consumeErrorUsage(context, error);
      throwModelExecutionError(error);
    }
  }
}

export class ModelBackedVerifier implements Verifier {
  constructor(
    private readonly gateway: StructuredModelInvoker,
    private readonly model: string,
  ) {}

  async verify(context: VerificationContext): Promise<VerificationResult> {
    try {
      const maximumOutputTokens = context.budget?.maximumOutputTokens(context.job.runId);
      const result = await this.gateway.invokeStructured(
        {
          operation: "execution.verification",
          model: this.model,
          messages: [
            {
              role: "system",
              content:
                "Verify the requested objective from the before and after observations. A pass must have no claims. A failure must cite exact graphId, nodeId, and visible text from both observations.",
            },
            {
              role: "user",
              content: JSON.stringify({
                objective: context.job.objective,
                before: context.before,
                after: context.after,
                action: {
                  kind: context.action.kind,
                  nodeId: resolvedActionNodeId(context.action),
                  graphId: context.action.graphId,
                },
                outcome: context.outcome,
              }),
            },
          ],
          timeoutMs: 30_000,
          ...(maximumOutputTokens === undefined ? {} : { maximumOutputTokens }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          invocation: { runId: context.job.runId, invocationId: uuidv7() },
        },
        verificationContract(context),
      );
      consumeUsageState(context, result.usageState, result.usage);

      return result.value;
    } catch (error) {
      consumeErrorUsage(context, error);
      throwModelExecutionError(error);
    }
  }
}

function throwModelExecutionError(error: unknown): never {
  if (error instanceof ModelGatewayInvocationError && !(error instanceof ModelGatewayAbortError)) {
    throwModelExecutionError(error.reason);
  }
  if (error instanceof ModelGatewayAbortError) {
    throw error.reason;
  }
  if (error instanceof ModelGatewayError && error.code === "InvalidStructuredOutput") {
    throw new ExecutionBlockedError(error.code);
  }

  throw error;
}

function consumeErrorUsage(
  context: AgentContext | VerificationContext,
  error: unknown,
): void {
  if (error instanceof ModelGatewayInvocationError) {
    const budget = context.budget;
    if (budget === undefined || !error.providerAttempted) return;
    if (error.usageState.status === "available") {
      budget.consumeModelUsage(context.job.runId, error.usageState.usage);
      return;
    }

    try {
      if (error.usageState.knownUsage !== undefined) {
        budget.consumeModelUsage(context.job.runId, error.usageState.knownUsage);
      }
    } catch (budgetError) {
      if (
        budgetError instanceof ExecutionBudgetError &&
        (budgetError.code === "ModelUsageUnavailable" ||
          budgetError.code === "ModelBudgetExceeded" ||
          budgetError.code === "WallClockBudgetExceeded")
      ) {
        throw new ExecutionBudgetError("ModelUsageUnavailable");
      }
      throw budgetError;
    }
    throw new ExecutionBudgetError("ModelUsageUnavailable");
  }
  if (error instanceof ModelGatewayError && error.providerAttempted) {
    consumeUsageState(context, error.usageState, error.usage);
  }
}

function consumeUsageState(
  context: AgentContext | VerificationContext,
  state: import("@qualigence/model-gateway").ModelUsageState | undefined,
  legacyUsage: import("@qualigence/runner-kernel").ModelUsage | undefined,
): void {
  const budget = context.budget;
  if (budget === undefined) return;
  if (state === undefined) {
    budget.consumeModelUsage(context.job.runId, legacyUsage);
    return;
  }
  if (state.status === "available") {
    budget.consumeModelUsage(context.job.runId, state.usage);
    return;
  }
  if (state.knownUsage !== undefined) {
    budget.consumeModelUsage(context.job.runId, state.knownUsage);
  }
  throw new ExecutionBudgetError("ModelUsageUnavailable");
}

/**
 * Generates a UUIDv7 (time-ordered) identifier for a single logical model
 * invocation. Kept local to the runner component so it stays free of extra
 * runtime dependencies.
 */
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

function decisionContract(
  context: AgentContext,
  currentStep: CurrentPlanActionStep | undefined,
): StructuredOutputContract<DecisionProposal> {
  validateCurrentStep(context, currentStep);
  return {
    name: "execution-decision",
    jsonSchema: z.toJSONSchema(
      currentStep === undefined ? clickDecisionSchema : plannedDecisionSchema,
    ) as JsonSchema,
    parse(value: unknown): DecisionProposal {
      const proposal: DecisionProposal = currentStep === undefined
        ? parseSchema(clickDecisionSchema, value)
        : parseSchema(plannedDecisionSchema, value);
      const nodeId = "action" in proposal ? proposal.action.nodeId : proposal.nodeId;
      if (!context.observation.nodes.some((node) => node.id === nodeId)) {
        throw structuredOutputValidationError([
          { path: currentStep === undefined ? "action.nodeId" : "nodeId", reason: "unknown_node_reference" },
        ]);
      }

      return proposal;
    },
  };
}

function verificationContract(
  context: VerificationContext,
): StructuredOutputContract<VerificationResult> {
  return {
    name: "execution-verification",
    jsonSchema: z.toJSONSchema(verificationSchema) as JsonSchema,
    parse(value: unknown): VerificationResult {
      const parsed = parseSchema(verificationSchema, value);
      if (parsed.status === "passed") {
        return { status: "passed", summary: parsed.summary, claims: [] };
      }

      const claims = asNonEmptyClaims(parsed.claims);
      validateClaims(claims, context.before, context.after);
      return {
        status: "failed",
        summary: parsed.summary,
        severitySuggestion: parsed.severitySuggestion,
        claims,
      };
    },
  };
}

function toProposedAction(
  proposal: DecisionProposal,
  currentStep: CurrentPlanActionStep | undefined,
): AnyProposedAction {
  const nodeId = "action" in proposal ? proposal.action.nodeId : proposal.nodeId;
  if (currentStep?.kind === "input") {
    return {
      kind: "input",
      target: { nodeId },
      valueRef: currentStep.valueRef,
      reason: proposal.reason,
    };
  }
  if (currentStep?.kind === "select") {
    return {
      kind: "select",
      target: { nodeId },
      valueRef: currentStep.valueRef,
      reason: proposal.reason,
    };
  }
  if (!("action" in proposal)) throw new ExecutionBlockedError("PlanExecutionUnsupported");
  return {
    kind: "click",
    target: { nodeId: proposal.action.nodeId },
    reason: proposal.reason,
  };
}

function validateCurrentStep(
  context: AgentContext,
  currentStep: CurrentPlanActionStep | undefined,
): void {
  if (currentStep === undefined) {
    const steps = context.job.plan?.steps;
    if (steps !== undefined && (steps.length !== 1 || steps[0]?.kind !== "click")) {
      throw new ExecutionBlockedError("PlanExecutionUnsupported");
    }
    return;
  }
  const planSteps = context.job.plan?.steps;
  if (planSteps?.length !== 1 || !samePlanStep(planSteps[0], currentStep)) {
    throw new ExecutionBlockedError("PlanExecutionUnsupported");
  }
}

function samePlanStep(left: ExecutionPlanStep, right: CurrentPlanActionStep): boolean {
  if (left.kind !== right.kind || left.stepIndex !== right.stepIndex) return false;
  if (left.kind !== "input" && left.kind !== "select") return false;
  if (
    left.target.purpose !== right.target.purpose ||
    left.target.role !== right.target.role ||
    left.target.name !== right.target.name
  ) return false;
  if (left.kind === "input" && right.kind === "input") return left.valueRef === right.valueRef;
  if (left.kind === "select" && right.kind === "select") return left.valueRef === right.valueRef;
  return false;
}

function validateClaims(
  claims: readonly VerificationClaim[],
  before: ObservationGraph,
  after: ObservationGraph,
): void {
  for (const [index, claim] of claims.entries()) {
    validateEvidenceValue(claim.expected, before, `claims[${index}].expected`);
    validateEvidenceValue(claim.observed, after, `claims[${index}].observed`);
  }
}

function validateEvidenceValue(
  value: VerificationClaim["expected"],
  graph: ObservationGraph,
  path: string,
): void {
  const node = graph.graphId === value.graphId
    ? graph.nodes.find((candidate) => candidate.id === value.nodeId)
    : undefined;

  if (node === undefined) {
    throw new InvalidModelEvidenceError(path, "unknown_evidence_reference");
  }
  if (normalizeText(node) !== normalizeTextValue(value.text)) {
    throw new InvalidModelEvidenceError(path, "visible_text_mismatch");
  }
}

function normalizeText(node: ObservationNode): string {
  return normalizeTextValue(node.text ?? "");
}

function normalizeTextValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function asNonEmptyClaims(
  claims: readonly VerificationClaim[],
): readonly [VerificationClaim, ...VerificationClaim[]] {
  const [first, ...rest] = claims;
  if (first === undefined) {
    throw new InvalidModelEvidenceError("claims", "missing_required_claim");
  }

  return [first, ...rest];
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
): StructuredOutputValidationError {
  return Object.assign(new Error("The model output failed structured validation."), {
    name: "StructuredOutputValidationError" as const,
    issues,
  });
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
