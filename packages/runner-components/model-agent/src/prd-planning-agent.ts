import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { StructuredModelInvoker } from "@qualigence/model-gateway";
import type {
  JsonSchema,
  StructuredOutputContract,
  StructuredOutputValidationIssue,
} from "@qualigence/model-provider";
import type { PrdDocument } from "@qualigence/context-intake";
import type {
  ProposedExpectedClaim,
  ProposedIntentStep,
  ProposedTestCase,
  SemanticTarget,
  TestPlanProposal,
} from "@qualigence/application-model";

/**
 * A target's advertised capability surface, handed to the planner so it can bias
 * proposed steps toward supported actions. It is a provider-neutral summary; the
 * agent never reads a repository or resolves selectors.
 */
export interface TargetCapabilitySummary {
  readonly targetId: string;
  readonly supportedStepKinds: readonly ("navigate" | "click" | "input" | "verify")[];
  readonly capabilities: readonly string[];
}

const sourceRefSchema = z
  .object({
    prdId: z.string().min(1),
    revision: z.number().int(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    quotedTextSha256: z.string().min(1),
  })
  .strict();

const semanticTargetSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    purpose: z.string().min(1),
  })
  .strict();

const proposedClaimSchema = z
  .object({
    semanticKey: z.string().min(1),
    statement: z.string().min(1),
    sourceRefs: z.array(sourceRefSchema).min(1),
    confidence: z.number(),
  })
  .strict();

const proposedStepSchema = z.discriminatedUnion("kind", [
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
      claimSemanticKeys: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);

const proposedTestCaseSchema = z
  .object({
    title: z.string().min(1),
    objective: z.string().min(1),
    preconditions: z.array(z.string()),
    steps: z.array(proposedStepSchema).min(1),
    expectedClaimSemanticKeys: z.array(z.string().min(1)).min(1),
    sourceRefs: z.array(sourceRefSchema).min(1),
    priority: z.enum(["low", "medium", "high"]),
  })
  .strict();

const proposalSchema = z
  .object({
    expectedClaims: z.array(proposedClaimSchema).min(1),
    testCases: z.array(proposedTestCaseSchema).min(1),
  })
  .strict();

type ParsedProposal = z.output<typeof proposalSchema>;

const PLANNING_TIMEOUT_MS = 60_000;

/**
 * The model-backed PRD planner. Given an immutable {@link PrdDocument} it invokes
 * the Model Gateway with the `planning.prd-test-cases` operation and returns a
 * strictly-parsed {@link TestPlanProposal}.
 *
 * The agent is intentionally powerless: it allocates no IDs, verifies no source
 * hashes, creates no Mission and touches no repository. Grounding, selector-leak
 * rejection and identity allocation belong to the deterministic
 * `TestPlanProposalValidator` and the Core command handlers.
 */
export class PrdPlanningAgent {
  constructor(
    private readonly gateway: StructuredModelInvoker,
    private readonly model: string,
  ) {}

  async propose(
    document: PrdDocument,
    target: TargetCapabilitySummary,
  ): Promise<TestPlanProposal> {
    const result = await this.gateway.invokeStructured(
      {
        operation: "planning.prd-test-cases",
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "Propose source-grounded expected claims and test cases for the PRD. " +
              "Every claim and test case must cite exact PRD source offsets and the " +
              "SHA-256 of the quoted substring. Reference claims by semantic key only. " +
              "Never emit CSS/XPath/coordinate/script selectors or URL credentials.",
          },
          {
            role: "user",
            content: JSON.stringify({
              prdId: document.prdId,
              revision: document.revision,
              projectId: document.projectId,
              title: document.title,
              content: document.content,
              contentSha256: document.contentSha256,
              target: {
                targetId: target.targetId,
                supportedStepKinds: target.supportedStepKinds,
                capabilities: target.capabilities,
              },
            }),
          },
        ],
        timeoutMs: PLANNING_TIMEOUT_MS,
        invocation: { runId: document.prdId, invocationId: uuidv7() },
      },
      planningContract(),
    );

    return result.value;
  }
}

function planningContract(): StructuredOutputContract<TestPlanProposal> {
  return {
    name: "planning-prd-test-cases",
    jsonSchema: z.toJSONSchema(proposalSchema) as JsonSchema,
    parse(value: unknown): TestPlanProposal {
      const parsed = parseSchema(proposalSchema, value);
      return toProposal(parsed);
    },
  };
}

function toProposal(parsed: ParsedProposal): TestPlanProposal {
  return {
    expectedClaims: parsed.expectedClaims.map(toClaim),
    testCases: parsed.testCases.map(toTestCase),
  };
}

function toClaim(
  claim: ParsedProposal["expectedClaims"][number],
): ProposedExpectedClaim {
  return {
    semanticKey: claim.semanticKey,
    statement: claim.statement,
    sourceRefs: nonEmpty(claim.sourceRefs, "sourceRefs"),
    confidence: claim.confidence,
  };
}

function toTestCase(
  testCase: ParsedProposal["testCases"][number],
): ProposedTestCase {
  return {
    title: testCase.title,
    objective: testCase.objective,
    preconditions: testCase.preconditions,
    steps: nonEmptyMapped(testCase.steps, toStep, "steps"),
    expectedClaimSemanticKeys: nonEmpty(
      testCase.expectedClaimSemanticKeys,
      "expectedClaimSemanticKeys",
    ),
    sourceRefs: nonEmpty(testCase.sourceRefs, "sourceRefs"),
    priority: testCase.priority,
  };
}

function toStep(step: ParsedProposal["testCases"][number]["steps"][number]): ProposedIntentStep {
  switch (step.kind) {
    case "navigate":
      return { kind: "navigate", path: step.path };
    case "click":
      return { kind: "click", target: toSemanticTarget(step.target) };
    case "input":
      return {
        kind: "input",
        target: toSemanticTarget(step.target),
        valueRef: step.valueRef,
      };
    case "verify":
      return {
        kind: "verify",
        claimSemanticKeys: nonEmpty(step.claimSemanticKeys, "claimSemanticKeys"),
      };
  }
}

/** Build a {@link SemanticTarget}, omitting optional fields rather than setting them to `undefined`. */
function toSemanticTarget(
  target: z.output<typeof semanticTargetSchema>,
): SemanticTarget {
  return {
    purpose: target.purpose,
    ...(target.role === undefined ? {} : { role: target.role }),
    ...(target.name === undefined ? {} : { name: target.name }),
  };
}

function nonEmpty<T>(values: readonly T[], path: string): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw structuredOutputValidationError([{ path, reason: "empty_array" }]);
  }
  return [first, ...rest];
}

function nonEmptyMapped<TInput, TOutput>(
  values: readonly TInput[],
  map: (value: TInput) => TOutput,
  path: string,
): readonly [TOutput, ...TOutput[]] {
  return nonEmpty(values.map(map), path);
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
  return Object.assign(new Error("The planning output failed structured validation."), {
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

/**
 * Generates a UUIDv7 identifier for a single planning invocation. Kept local so
 * the runner component stays free of extra runtime dependencies.
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
