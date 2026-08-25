import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { StructuredModelInvoker } from "@qualigence/model-gateway";
import type {
  JsonSchema,
  ModelUsage,
  ModelUsageState,
  StructuredOutputContract,
  StructuredOutputValidationIssue,
} from "@qualigence/model-provider";
import type {
  ExplorationContext,
  ExplorationProposal,
} from "@qualigence/exploration";
import type {
  ExplorationDecision,
  ProposedExplorationAction,
} from "@qualigence/mission";

const actionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("navigate"),
      path: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("click"),
      nodeId: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("input"),
      nodeId: z.string().min(1),
      valueRef: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
]);

const decisionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("act"),
      action: actionSchema,
      reason: z.string().min(1),
      expectedNovelty: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("stop"),
      reason: z.string().min(1),
      expectedNovelty: z.string().optional(),
    })
    .strict(),
]);

type ParsedDecision = z.output<typeof decisionSchema>;

const EXPLORATION_TIMEOUT_MS = 60_000;

/**
 * The model-backed exploration proposer. Given the deterministic
 * {@link ExplorationContext} assembled by the controller, it invokes the Model
 * Gateway with the `exploration.next-action` operation and returns a
 * strictly-parsed {@link ExplorationDecision} together with the tokens consumed.
 *
 * The agent is intentionally powerless: it proposes at most one candidate
 * action, never decides budget, risk, grounding or persistence, and never
 * executes anything. Every such decision belongs to the deterministic
 * {@link ExplorationController}.
 */
export class ExplorationAgent {
  constructor(
    private readonly gateway: StructuredModelInvoker,
    private readonly model: string,
  ) {}

  async nextAction(context: ExplorationContext): Promise<ExplorationProposal> {
    const result = await this.gateway.invokeStructured(
      {
        operation: "exploration.next-action",
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "Propose at most one next exploration action, or stop. Reference an " +
              "interactable element only by a nodeId present in the current graph. " +
              "Use only an allowed action kind and stay within the risk ceiling. " +
              "Never propose a destructive or external-side-effect action, never " +
              "revisit an already-visited state, and never emit a CSS/XPath/" +
              "coordinate/script selector. You only propose; the controller decides.",
          },
          {
            role: "user",
            content: JSON.stringify({
              runId: context.runId,
              allowedActionKinds: context.allowedActionKinds,
              riskCeiling: context.riskCeiling,
              remainingBudget: context.remainingBudget,
              visitedFingerprints: context.visitedFingerprints,
              graph: {
                url: context.graph.url,
                title: context.graph.title,
                nodes: context.graph.nodes.map((node) => ({
                  id: node.id,
                  role: node.role,
                  name: node.name,
                  text: node.text,
                  value: node.value,
                  disabled: node.disabled,
                })),
              },
            }),
          },
        ],
        timeoutMs: EXPLORATION_TIMEOUT_MS,
        invocation: { runId: context.runId, invocationId: uuidv7() },
      },
      explorationContract(),
    );

    const tokensUsed = tokensUsedFrom(result.usageState, result.usage);
    return {
      decision: result.value,
      ...(tokensUsed === undefined ? {} : { tokensUsed }),
    };
  }
}

function explorationContract(): StructuredOutputContract<ExplorationDecision> {
  return {
    name: "exploration-next-action",
    jsonSchema: z.toJSONSchema(decisionSchema) as JsonSchema,
    parse(value: unknown): ExplorationDecision {
      const parsed = parseSchema(decisionSchema, value);
      return toDecision(parsed);
    },
  };
}

function tokensUsedFrom(
  state: ModelUsageState | undefined,
  legacyUsage: ModelUsage | undefined,
): number | undefined {
  const usage = state === undefined
    ? legacyUsage
    : state.status === "available"
      ? state.usage
      : undefined;
  if (usage === undefined) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    return usage.inputTokens + usage.outputTokens;
  }
  return undefined;
}

function toDecision(parsed: ParsedDecision): ExplorationDecision {
  if (parsed.status === "stop") {
    return {
      status: "stop",
      reason: parsed.reason,
      ...(parsed.expectedNovelty === undefined
        ? {}
        : { expectedNovelty: parsed.expectedNovelty }),
    };
  }
  return {
    status: "act",
    action: toAction(parsed.action),
    reason: parsed.reason,
    ...(parsed.expectedNovelty === undefined
      ? {}
      : { expectedNovelty: parsed.expectedNovelty }),
  };
}

function toAction(
  action: Extract<ParsedDecision, { status: "act" }>["action"],
): ProposedExplorationAction {
  switch (action.kind) {
    case "navigate":
      return { kind: "navigate", path: action.path, reason: action.reason };
    case "click":
      return { kind: "click", nodeId: action.nodeId, reason: action.reason };
    case "input":
      return {
        kind: "input",
        nodeId: action.nodeId,
        valueRef: action.valueRef,
        reason: action.reason,
      };
  }
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
    new Error("The exploration output failed structured validation."),
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
