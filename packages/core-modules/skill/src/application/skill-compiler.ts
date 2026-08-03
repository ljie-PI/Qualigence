import type { RecordingSession } from "@qualigence/recording";
import type { IntentStep } from "@qualigence/recording";
import type { SemanticTarget } from "@qualigence/application-model";
import type {
  ProposedSkillStep,
  SkillInductionProposal,
} from "../domain/proposal.js";
import type {
  SkillAssertion,
  SkillCandidate,
  SkillParameter,
  SkillStep,
} from "../domain/skill-types.js";
import { skillContentSha256 } from "../domain/skill-bundle.js";

export const SKILL_COMPILER_VERSION = "skill-compiler/v1";
export const LOCATOR_SCHEMA_VERSION = "semantic-locator/v1";

export type SkillCompilerErrorCode =
  | "InvalidSkillProposal"
  | "SelectorLeakRejected"
  | "RecordingIncomplete";

export class SkillCompilerError extends Error {
  readonly code: SkillCompilerErrorCode;

  constructor(code: SkillCompilerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SkillCompilerError";
    this.code = code;
  }
}

// Deterministic selector/injection leak detectors mirroring the LS-07 planner
// validator: semantic fields must never carry CSS/XPath/coordinate/script/creds.
const CSS_SELECTOR = /css\s*=/i;
const XPATH_EXPR = /(xpath\s*=)|((^|[^:])\/\/)/;
const COORDINATE =
  /(\bx\s*=\s*-?\d)|(\by\s*=\s*-?\d)|(@\s*\(?\s*-?\d+\s*,\s*-?\d+)|(\bat\s+\(?\s*-?\d+\s*,\s*-?\d+)/i;
const SCRIPT_INJECTION =
  /(javascript:)|(<\s*script)|(\beval\s*\()|(=>)|(\bfunction\s*\()/i;
const URL_CREDENTIALS = /:\/\/[^/@\s]+:[^/@\s]+@/;

function selectorLeakReason(text: string): string | undefined {
  if (CSS_SELECTOR.test(text)) return "css selector";
  if (XPATH_EXPR.test(text)) return "xpath expression";
  if (COORDINATE.test(text)) return "coordinate";
  if (SCRIPT_INJECTION.test(text)) return "script";
  if (URL_CREDENTIALS.test(text)) return "url credentials";
  return undefined;
}

/**
 * The deterministic (non-model) Skill compiler. It turns an immutable
 * {@link RecordingSession} plus a model {@link SkillInductionProposal} into a
 * grounded {@link SkillCandidate}: it validates every proposal reference against
 * the recording, rejects any leaked selector / coordinate / raw secret, refuses
 * unknown or unstable nodeId locators, generates stable step ids, carries the
 * recording's source node only as provenance, and computes a canonical content
 * hash. It never runs a model, allocates persistence ids, or writes anything.
 */
export class SkillCompiler {
  compile(
    recording: RecordingSession,
    proposal: SkillInductionProposal,
  ): SkillCandidate {
    this.assertCompletedRecording(recording);
    this.assertParameters(proposal.parameters);

    const byOrdinal = new Map(
      recording.steps.map((step) => [step.ordinal, step]),
    );
    const knownValueRefs = new Set(
      proposal.parameters.map((parameter) => parameter.valueRef),
    );

    const steps = proposal.steps.map((proposedStep, index) =>
      this.compileStep(proposedStep, index, byOrdinal, knownValueRefs),
    );

    const [firstStep, ...restSteps] = steps;
    if (firstStep === undefined) {
      throw new SkillCompilerError(
        "InvalidSkillProposal",
        "A proposal must compile to at least one step.",
      );
    }

    const content = {
      parameters: proposal.parameters,
      steps: [firstStep, ...restSteps] as const,
      sourceRecordingIds: [recording.recordingId] as const,
      observationSchemaEpoch: recording.observationSchemaEpoch,
      locatorSchemaVersion: LOCATOR_SCHEMA_VERSION,
      compilerVersion: SKILL_COMPILER_VERSION,
    };

    return {
      ...content,
      contentSha256: skillContentSha256({
        skillId: "",
        projectId: recording.projectId,
        targetScope: {
          targetId: recording.targetId,
          allowedOrigins: [],
        },
        ...content,
      }),
    };
  }

  private compileStep(
    proposedStep: ProposedSkillStep,
    index: number,
    byOrdinal: ReadonlyMap<number, RecordingSession["steps"][number]>,
    knownValueRefs: ReadonlySet<string>,
  ): SkillStep {
    const source = byOrdinal.get(proposedStep.sourceRecordedStepOrdinal);
    if (source === undefined) {
      throw new SkillCompilerError(
        "InvalidSkillProposal",
        `Proposed step references recorded ordinal ${proposedStep.sourceRecordedStepOrdinal}, which is not in the recording.`,
      );
    }

    this.assertGroundedIntent(proposedStep.intent, source.intent, knownValueRefs);
    for (const assertion of [
      ...proposedStep.preconditions,
      ...proposedStep.checkpoint,
    ]) {
      this.assertGroundedAssertion(assertion);
    }

    return {
      stepId: `step-${String(index + 1).padStart(3, "0")}`,
      intent: proposedStep.intent,
      preconditions: proposedStep.preconditions,
      checkpoint: proposedStep.checkpoint,
      recovery: proposedStep.recovery,
      sourceNodeId: source.resolvedNode.sourceNodeId,
    };
  }

  private assertCompletedRecording(recording: RecordingSession): void {
    if (recording.steps.length === 0) {
      throw new SkillCompilerError(
        "RecordingIncomplete",
        "Cannot compile a Skill from a recording with no steps.",
      );
    }
  }

  private assertParameters(parameters: readonly SkillParameter[]): void {
    const seen = new Set<string>();
    for (const parameter of parameters) {
      if (parameter.name.length === 0 || parameter.valueRef.length === 0) {
        throw new SkillCompilerError(
          "InvalidSkillProposal",
          "Every parameter needs a name and a valueRef.",
        );
      }
      if (seen.has(parameter.name)) {
        throw new SkillCompilerError(
          "InvalidSkillProposal",
          `Duplicate parameter name "${parameter.name}".`,
        );
      }
      seen.add(parameter.name);
      this.assertField(parameter.valueRef, "parameter valueRef");
    }
  }

  private assertGroundedIntent(
    intent: IntentStep,
    sourceIntent: IntentStep,
    knownValueRefs: ReadonlySet<string>,
  ): void {
    if (intent.kind !== sourceIntent.kind) {
      throw new SkillCompilerError(
        "InvalidSkillProposal",
        `Proposed step kind "${intent.kind}" does not match the recorded kind "${sourceIntent.kind}".`,
      );
    }

    switch (intent.kind) {
      case "navigate":
        this.assertField(intent.path, "navigate path");
        return;
      case "click":
        this.assertTarget(intent.target);
        return;
      case "input": {
        this.assertTarget(intent.target);
        this.assertRawSecret(intent);
        this.assertField(intent.valueRef, "input valueRef");
        if (!knownValueRefs.has(intent.valueRef)) {
          throw new SkillCompilerError(
            "InvalidSkillProposal",
            `Input step references valueRef "${intent.valueRef}" that is not a declared parameter.`,
          );
        }
        return;
      }
    }
  }

  private assertRawSecret(intent: IntentStep): void {
    const candidate = intent as { readonly value?: unknown };
    if ("value" in candidate && candidate.value !== undefined) {
      throw new SkillCompilerError(
        "InvalidSkillProposal",
        "An input step must reference values by valueRef, never a raw value.",
      );
    }
  }

  private assertGroundedAssertion(assertion: SkillAssertion): void {
    switch (assertion.kind) {
      case "node_present":
        this.assertTarget(assertion.target);
        return;
      case "node_text":
        this.assertTarget(assertion.target);
        this.assertField(assertion.expected, "assertion expected text");
        return;
      case "claim_satisfied":
        this.assertField(assertion.claimId, "assertion claimId");
        return;
      case "url_path":
        this.assertField(assertion.path, "assertion url_path");
        return;
    }
  }

  private assertTarget(target: SemanticTarget): void {
    this.assertField(target.purpose, "target purpose");
    if (target.role !== undefined) this.assertField(target.role, "target role");
    if (target.name !== undefined) this.assertField(target.name, "target name");
  }

  private assertField(value: string, label: string): void {
    const reason = selectorLeakReason(value);
    if (reason !== undefined) {
      throw new SkillCompilerError(
        "SelectorLeakRejected",
        `Rejected ${reason} in ${label}.`,
      );
    }
  }
}
