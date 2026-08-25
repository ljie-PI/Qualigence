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
  ObservationGraphV1,
  ObservationNodeV1,
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

const plannedReasonSchema = z
  .object({
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
  | { readonly nodeId: string; readonly reason: string }
  | { readonly reason: string };

type CurrentPlanActionStep = Exclude<ExecutionPlanStep, { readonly kind: "verify" }>;

export class InvalidModelEvidenceError extends Error implements StructuredOutputValidationError {
  readonly name = "StructuredOutputValidationError" as const;
  readonly issues: readonly StructuredOutputValidationIssue[];

  constructor(path: string, reason: string) {
    super("The model returned an invalid evidence reference.");
    this.issues = [{ path, reason }];
  }
}

export class ModelBackedDecisionProvider implements ExecutionDecisionProvider<import("@qualigence/runner-kernel").ProposedActionKind> {
  constructor(
    private readonly gateway: StructuredModelInvoker,
    private readonly model: string,
  ) {}

  decide(context: AgentContext & { readonly step: CurrentPlanActionStep }): Promise<AnyProposedAction>;
  decide(context: AgentContext): Promise<ProposedAction>;
  async decide(context: AgentContext): Promise<AnyProposedAction> {
    const currentStep = currentPlanStep(context);
    try {
      const maximumOutputTokens = context.budget?.maximumOutputTokens(context.job.runId);
      const result = await this.gateway.invokeStructured(
        {
          operation: "execution.decision",
          model: this.model,
          messages: [
            {
              role: "system",
              content: currentStep === undefined
                ? "Choose one visible node for the requested web action. Return only a click nodeId and a concise reason."
                : decisionInstruction(currentStep),
            },
            {
              role: "user",
              content: JSON.stringify({
                objective: context.job.objective,
                ...(currentStep === undefined ? {} : { step: currentStep }),
                observation: context.observation,
              }),
            },
          ],
          timeoutMs: 30_000,
          ...(maximumOutputTokens === undefined ? {} : { maximumOutputTokens }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          invocation: { runId: context.job.runId, invocationId: uuidv7() },
        },
        decisionContract(context, currentStep),
      );
      consumeUsageState(context, result.usageState, result.usage);

      return toProposedAction(result.value, currentStep);
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
                claimIds: context.claimIds ?? [],
                before: context.before,
                after: context.after,
                ...(context.action === undefined
                  ? {}
                  : {
                      action: {
                        kind: context.action.kind,
                        nodeId: resolvedActionNodeId(context.action),
                        graphId: context.action.kind === "navigate" ? undefined : context.action.graphId,
                      },
                    }),
                ...(context.outcome === undefined ? {} : { outcome: context.outcome }),
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
      currentStep === undefined
        ? clickDecisionSchema
        : stepNeedsNode(currentStep)
          ? plannedDecisionSchema
          : plannedReasonSchema,
    ) as JsonSchema,
    parse(value: unknown): DecisionProposal {
      const proposal: DecisionProposal = currentStep === undefined
        ? parseSchema(clickDecisionSchema, value)
        : stepNeedsNode(currentStep)
          ? parseSchema(plannedDecisionSchema, value)
          : parseSchema(plannedReasonSchema, value);
      const nodeId = proposalNodeId(proposal);
      if (nodeId !== undefined && !context.observation.nodes.some((node) => node.id === nodeId)) {
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
  const nodeId = proposalNodeId(proposal);
  if (currentStep?.kind === "navigate") {
    return { kind: "navigate", path: currentStep.path, reason: proposal.reason };
  }
  if (currentStep?.kind === "click") {
    if (nodeId === undefined) throw new ExecutionBlockedError("PlanExecutionUnsupported");
    return { kind: "click", target: { nodeId }, reason: proposal.reason };
  }
  if (currentStep?.kind === "input") {
    if (nodeId === undefined) throw new ExecutionBlockedError("PlanExecutionUnsupported");
    return {
      kind: "input",
      target: { nodeId },
      valueRef: currentStep.valueRef,
      reason: proposal.reason,
    };
  }
  if (currentStep?.kind === "select") {
    if (nodeId === undefined) throw new ExecutionBlockedError("PlanExecutionUnsupported");
    return {
      kind: "select",
      target: { nodeId },
      valueRef: currentStep.valueRef,
      reason: proposal.reason,
    };
  }
  if (currentStep?.kind === "scroll") {
    if (currentStep.target !== undefined && nodeId === undefined) {
      throw new ExecutionBlockedError("PlanExecutionUnsupported");
    }
    return {
      kind: "scroll",
      ...(nodeId === undefined ? {} : { target: { nodeId } }),
      direction: currentStep.direction,
      amount: currentStep.amount,
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
    if (steps !== undefined) {
      throw new ExecutionBlockedError("PlanExecutionUnsupported");
    }
    return;
  }
  const planSteps = context.job.plan?.steps;
  const stepIndex = context.stepIndex;
  if (stepIndex === undefined || !samePlanStep(planSteps?.[stepIndex], currentStep)) {
    throw new ExecutionBlockedError("PlanExecutionUnsupported");
  }
}

function samePlanStep(
  left: ExecutionPlanStep | undefined,
  right: CurrentPlanActionStep,
): boolean {
  if (left === undefined || left.kind !== right.kind || left.stepIndex !== right.stepIndex) return false;
  switch (left.kind) {
    case "navigate":
      return right.kind === "navigate" && left.path === right.path;
    case "click":
      return right.kind === "click" && samePlanTarget(left.target, right.target);
    case "input":
      return right.kind === "input" && left.valueRef === right.valueRef && samePlanTarget(left.target, right.target);
    case "select":
      return right.kind === "select" && left.valueRef === right.valueRef && samePlanTarget(left.target, right.target);
    case "scroll":
      return right.kind === "scroll" && left.direction === right.direction && left.amount === right.amount &&
        (left.target === undefined ? right.target === undefined : right.target !== undefined && samePlanTarget(left.target, right.target));
  }
}

function proposalNodeId(proposal: DecisionProposal): string | undefined {
  if ("action" in proposal) {
    return (proposal as { readonly action: { readonly nodeId: string } }).action.nodeId;
  }
  return "nodeId" in proposal ? proposal.nodeId : undefined;
}

function samePlanTarget(
  left: { readonly role?: string; readonly name?: string; readonly purpose: string },
  right: { readonly role?: string; readonly name?: string; readonly purpose: string },
): boolean {
  return left.purpose === right.purpose && left.role === right.role && left.name === right.name;
}

function currentPlanStep(context: AgentContext): CurrentPlanActionStep | undefined {
  const step = context.step;
  if (step === undefined) return undefined;
  if (step.kind === "verify") throw new ExecutionBlockedError("PlanExecutionUnsupported");
  return step;
}

function stepNeedsNode(step: CurrentPlanActionStep): boolean {
  return step.kind === "click" || step.kind === "input" || step.kind === "select" ||
    (step.kind === "scroll" && step.target !== undefined);
}

function decisionInstruction(step: CurrentPlanActionStep): string {
  return stepNeedsNode(step)
    ? `Ground the immutable ${step.kind} Plan step in the current observation. Return only nodeId and a concise reason.`
    : `Confirm the immutable ${step.kind} Plan step. Return only a concise reason.`;
}

function validateClaims(
  claims: readonly VerificationClaim[],
  before: ObservationGraphV1,
  after: ObservationGraphV1,
): void {
  for (const [index, claim] of claims.entries()) {
    validateEvidenceValue(claim.expected, before, `claims[${index}].expected`);
    validateEvidenceValue(claim.observed, after, `claims[${index}].observed`);
  }
}

function validateEvidenceValue(
  value: VerificationClaim["expected"],
  graph: ObservationGraphV1,
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

function normalizeText(node: ObservationNodeV1): string {
  return normalizeTextValue(node.name ?? node.value ?? "");
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
