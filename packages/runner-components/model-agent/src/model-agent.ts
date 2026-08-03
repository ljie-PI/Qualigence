import { z } from "zod";
import { randomBytes } from "node:crypto";
import { ModelGatewayError } from "@qualigence/model-gateway";
import type { StructuredModelInvoker } from "@qualigence/model-gateway";
import { ExecutionBlockedError } from "@qualigence/runner-kernel";
import type {
  JsonSchema,
  StructuredOutputContract,
  StructuredOutputValidationError,
  StructuredOutputValidationIssue,
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

interface DecisionProposal {
  readonly action: {
    readonly kind: "click";
    readonly nodeId: string;
  };
  readonly reason: string;
}

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
  ) {}

  async decide(context: AgentContext): Promise<ProposedAction> {
    try {
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
          invocation: { runId: context.job.runId, invocationId: uuidv7() },
        },
        decisionContract(context),
      );

      return toProposedAction(result.value);
    } catch (error) {
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
          invocation: { runId: context.job.runId, invocationId: uuidv7() },
        },
        verificationContract(context),
      );

      return result.value;
    } catch (error) {
      throwModelExecutionError(error);
    }
  }
}

function throwModelExecutionError(error: unknown): never {
  if (error instanceof ModelGatewayError && error.code === "InvalidStructuredOutput") {
    throw new ExecutionBlockedError(error.code);
  }

  throw error;
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

function decisionContract(context: AgentContext): StructuredOutputContract<DecisionProposal> {
  return {
    name: "execution-decision",
    jsonSchema: z.toJSONSchema(decisionSchema) as JsonSchema,
    parse(value: unknown): DecisionProposal {
      const proposal = parseSchema(decisionSchema, value);
      if (!context.observation.nodes.some((node) => node.id === proposal.action.nodeId)) {
        throw structuredOutputValidationError([
          { path: "action.nodeId", reason: "unknown_node_reference" },
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
