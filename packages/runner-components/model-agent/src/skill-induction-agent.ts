import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { StructuredModelInvoker } from "@qualigence/model-gateway";
import type {
  JsonSchema,
  StructuredOutputContract,
  StructuredOutputValidationIssue,
} from "@qualigence/model-provider";
import type { RecordingSession } from "@qualigence/recording";
import type {
  ProposedSkillStep,
  SkillAssertion,
  SkillInductionProposal,
  SkillParameter,
} from "@qualigence/skill";

const semanticTargetSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    purpose: z.string().min(1),
  })
  .strict();

const assertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node_present"), target: semanticTargetSchema }).strict(),
  z
    .object({
      kind: z.literal("node_text"),
      target: semanticTargetSchema,
      expected: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("claim_satisfied"), claimId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("url_path"), path: z.string().min(1) }).strict(),
]);

const intentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("click"), target: semanticTargetSchema }).strict(),
  z
    .object({
      kind: z.literal("input"),
      target: semanticTargetSchema,
      valueRef: z.string().min(1),
    })
    .strict(),
]);

const parameterSchema = z
  .object({
    name: z.string().min(1),
    valueRef: z.string().min(1),
    required: z.boolean(),
    sensitivity: z.enum(["public", "internal", "sensitive", "secret"]),
  })
  .strict();

const proposedStepSchema = z
  .object({
    sourceRecordedStepOrdinal: z.number().int().positive(),
    intent: intentSchema,
    preconditions: z.array(assertionSchema),
    checkpoint: z.array(assertionSchema),
    recovery: z.enum(["stop", "reobserve"]),
  })
  .strict();

const proposalSchema = z
  .object({
    parameters: z.array(parameterSchema),
    steps: z.array(proposedStepSchema).min(1),
  })
  .strict();

type ParsedProposal = z.output<typeof proposalSchema>;

const INDUCTION_TIMEOUT_MS = 60_000;

/**
 * The model-backed Skill inducer. Given an immutable {@link RecordingSession} it
 * invokes the Model Gateway with the `skill.induction` operation and returns a
 * strictly-parsed {@link SkillInductionProposal}.
 *
 * The agent is intentionally powerless: it allocates no ids, verifies no source
 * hashes, compiles nothing and touches no repository. Grounding, selector-leak
 * rejection and stable-id allocation belong to the deterministic `SkillCompiler`
 * and the Core command handlers.
 */
export class SkillInductionAgent {
  constructor(
    private readonly gateway: StructuredModelInvoker,
    private readonly model: string,
  ) {}

  async propose(recording: RecordingSession): Promise<SkillInductionProposal> {
    const result = await this.gateway.invokeStructured(
      {
        operation: "skill.induction",
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "Induce a reusable Procedure Skill proposal from the recording. " +
              "Parameterize concrete values via valueRef only, reference each step " +
              "by its recorded ordinal, and describe targets and checkpoints by " +
              "semantics. Never emit CSS/XPath/coordinate/script selectors, a raw " +
              "secret value, an allocated id, or a nodeId as a locator.",
          },
          {
            role: "user",
            content: JSON.stringify({
              recordingId: recording.recordingId,
              projectId: recording.projectId,
              targetId: recording.targetId,
              targetVersion: recording.targetVersion,
              observationSchemaEpoch: recording.observationSchemaEpoch,
              steps: recording.steps.map((step) => ({
                ordinal: step.ordinal,
                intent: step.intent,
                resolvedNode: {
                  role: step.resolvedNode.role,
                  name: step.resolvedNode.name,
                  purpose: step.resolvedNode.purpose,
                },
                checkpoint: step.checkpoint,
              })),
            }),
          },
        ],
        timeoutMs: INDUCTION_TIMEOUT_MS,
        invocation: { runId: recording.recordingId, invocationId: uuidv7() },
      },
      inductionContract(),
    );

    return result.value;
  }
}

function inductionContract(): StructuredOutputContract<SkillInductionProposal> {
  return {
    name: "skill-induction",
    jsonSchema: z.toJSONSchema(proposalSchema) as JsonSchema,
    parse(value: unknown): SkillInductionProposal {
      const parsed = parseSchema(proposalSchema, value);
      return toProposal(parsed);
    },
  };
}

function toProposal(parsed: ParsedProposal): SkillInductionProposal {
  return {
    parameters: parsed.parameters.map(toParameter),
    steps: nonEmptyMapped(parsed.steps, toStep, "steps"),
  };
}

function toParameter(
  parameter: ParsedProposal["parameters"][number],
): SkillParameter {
  return {
    name: parameter.name,
    valueRef: parameter.valueRef,
    required: parameter.required,
    sensitivity: parameter.sensitivity,
  };
}

function toStep(step: ParsedProposal["steps"][number]): ProposedSkillStep {
  return {
    sourceRecordedStepOrdinal: step.sourceRecordedStepOrdinal,
    intent: toIntent(step.intent),
    preconditions: step.preconditions.map(toAssertion),
    checkpoint: step.checkpoint.map(toAssertion),
    recovery: step.recovery,
  };
}

function toIntent(
  intent: ParsedProposal["steps"][number]["intent"],
): ProposedSkillStep["intent"] {
  switch (intent.kind) {
    case "navigate":
      return { kind: "navigate", path: intent.path };
    case "click":
      return { kind: "click", target: toTarget(intent.target) };
    case "input":
      return {
        kind: "input",
        target: toTarget(intent.target),
        valueRef: intent.valueRef,
      };
  }
}

function toAssertion(
  assertion: ParsedProposal["steps"][number]["preconditions"][number],
): SkillAssertion {
  switch (assertion.kind) {
    case "node_present":
      return { kind: "node_present", target: toTarget(assertion.target) };
    case "node_text":
      return {
        kind: "node_text",
        target: toTarget(assertion.target),
        expected: assertion.expected,
      };
    case "claim_satisfied":
      return { kind: "claim_satisfied", claimId: assertion.claimId };
    case "url_path":
      return { kind: "url_path", path: assertion.path };
  }
}

function toTarget(target: z.output<typeof semanticTargetSchema>) {
  return {
    purpose: target.purpose,
    ...(target.role === undefined ? {} : { role: target.role }),
    ...(target.name === undefined ? {} : { name: target.name }),
  };
}

function nonEmptyMapped<TInput, TOutput>(
  values: readonly TInput[],
  map: (value: TInput) => TOutput,
  path: string,
): readonly [TOutput, ...TOutput[]] {
  const mapped = values.map(map);
  const [first, ...rest] = mapped;
  if (first === undefined) {
    throw structuredOutputValidationError([{ path, reason: "empty_array" }]);
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
): Error {
  return Object.assign(
    new Error("The skill induction output failed structured validation."),
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
