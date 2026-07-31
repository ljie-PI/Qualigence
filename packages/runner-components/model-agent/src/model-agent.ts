import { z } from "zod";
import type { StructuredModelInvoker } from "@qualigence/model-gateway";
import type {
  JsonSchema,
  StructuredOutputContract,
} from "@qualigence/model-provider";
import type {
  AgentContext,
  ExecutionDecisionProvider,
  ProposedAction,
  VerificationContext,
  VerificationResult,
  Verifier,
} from "@qualigence/runner-kernel";
import type {
  ObservationGraph,
  ObservationNode,
  VerificationClaim,
} from "@qualigence/runner-protocol";

const decisionSchema = z
  .object({
    action: z.object({ kind: z.literal("click"), nodeId: z.string().min(1) }).strict(),
    reason: z.string().min(1),
  })
  .strict();

const evidenceValueSchema = z
  .object({
    graphId: z.string().min(1),
    nodeId: z.string().min(1),
    text: z.string(),
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

interface DecisionProposal {
  readonly action: {
    readonly kind: "click";
    readonly nodeId: string;
  };
  readonly reason: string;
}

export class InvalidModelEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModelEvidenceError";
  }
}

export class ModelBackedDecisionProvider implements ExecutionDecisionProvider {
  constructor(
    private readonly gateway: StructuredModelInvoker,
    private readonly model: string,
  ) {}

  async decide(context: AgentContext): Promise<ProposedAction> {
    const result = await this.gateway.invokeStructured(
      {
        operation: "execution.decision",
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "Choose one visible node for the requested web action. Return only a click nodeId and a concise reason.",
          },
          {
            role: "user",
            content: JSON.stringify({
              objective: context.job.objective,
              observation: context.observation,
            }),
          },
        ],
        timeoutMs: 30_000,
      },
      structuredContract("execution-decision", decisionSchema),
    );

    return toProposedAction(result.value);
  }
}

export class ModelBackedVerifier implements Verifier {
  constructor(
    private readonly gateway: StructuredModelInvoker,
    private readonly model: string,
  ) {}

  async verify(context: VerificationContext): Promise<VerificationResult> {
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
                nodeId: context.action.target.nodeId,
                graphId: context.action.graphId,
              },
              outcome: context.outcome,
            }),
          },
        ],
        timeoutMs: 30_000,
      },
      verificationContract(context),
    );

    return result.value;
  }
}

function structuredContract<T extends z.ZodType>(name: string, schema: T) {
  return {
    name,
    jsonSchema: z.toJSONSchema(schema) as JsonSchema,
    parse(value: unknown): z.output<T> {
      return schema.parse(value);
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
      const parsed = verificationSchema.parse(value);
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

function toProposedAction(proposal: DecisionProposal): ProposedAction {
  return {
    kind: proposal.action.kind,
    target: { nodeId: proposal.action.nodeId },
    reason: proposal.reason,
  };
}

function validateClaims(
  claims: readonly VerificationClaim[],
  before: ObservationGraph,
  after: ObservationGraph,
): void {
  for (const claim of claims) {
    validateEvidenceValue(claim.expected, before);
    validateEvidenceValue(claim.observed, after);
  }
}

function validateEvidenceValue(
  value: VerificationClaim["expected"],
  graph: ObservationGraph,
): void {
  const node = graph.graphId === value.graphId
    ? graph.nodes.find((candidate) => candidate.id === value.nodeId)
    : undefined;

  if (
    node === undefined ||
    normalizeText(node) !== normalizeTextValue(value.text)
  ) {
    throw new InvalidModelEvidenceError(
      `Model evidence reference ${value.graphId}:${value.nodeId} does not match the observed text.`,
    );
  }
}

function normalizeText(node: ObservationNode): string {
  return normalizeTextValue(node.text ?? node.value ?? node.name ?? "");
}

function normalizeTextValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function asNonEmptyClaims(
  claims: readonly VerificationClaim[],
): readonly [VerificationClaim, ...VerificationClaim[]] {
  const [first, ...rest] = claims;
  if (first === undefined) {
    throw new InvalidModelEvidenceError("A failed verification requires evidence claims.");
  }

  return [first, ...rest];
}
