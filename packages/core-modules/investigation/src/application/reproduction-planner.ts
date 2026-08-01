import type { IntentStep } from "@qualigence/mission";
import type {
  IntelligenceJob,
  IntelligenceJobBudget,
  IntelligenceResult,
} from "@qualigence/intelligence";
import type { BugEpisodeDraft } from "../domain/investigation-case.js";
import type { ReproductionAttempt } from "../domain/reproduction-attempt.js";

/**
 * A deterministic, snapshotted reproduction plan derived from a validated
 * reproduction-planning {@link IntelligenceResult}. Its steps are semantic
 * {@link IntentStep}s only — a plan can never carry a CSS/XPath/coordinate
 * selector — and one plan is captured per plan revision.
 */
export interface ReproductionPlan {
  readonly caseId: string;
  readonly planRevision: number;
  readonly steps: readonly IntentStep[];
  readonly rationale: string;
}

export interface BuildIntelligenceJobInput {
  readonly jobId: string;
  readonly caseId: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly baseAggregateVersion: number;
  readonly inputRefs: readonly string[];
  readonly modelProfileId: string;
  readonly dataPolicyId: string;
  readonly budget: IntelligenceJobBudget;
  readonly idempotencyKey: string;
  readonly causationId: string;
}

/** Build the persistent Job envelope for a reproduction-planning model step. */
export function buildReproductionPlanningJob(
  input: BuildIntelligenceJobInput,
): IntelligenceJob {
  return {
    jobId: input.jobId,
    jobType: "investigation.reproduction-planning",
    schemaVersion: "intelligence-job/v1",
    tenantId: input.tenantId,
    projectId: input.projectId,
    aggregateRef: { type: "investigation", id: input.caseId },
    baseAggregateVersion: input.baseAggregateVersion,
    inputRefs: [...input.inputRefs],
    modelProfileId: input.modelProfileId,
    dataPolicyId: input.dataPolicyId,
    budget: input.budget,
    priority: "normal",
    idempotencyKey: input.idempotencyKey,
    causationId: input.causationId,
    expectedResultSchema: "intelligence-result/v1",
  };
}

/** Build the persistent Job envelope for a bug-analysis model step. */
export function buildBugAnalysisJob(
  input: BuildIntelligenceJobInput,
): IntelligenceJob {
  return {
    ...buildReproductionPlanningJob(input),
    jobType: "investigation.bug-analysis",
  };
}

export class ReproductionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReproductionPlanError";
  }
}

function parseIntentStep(value: unknown): IntentStep {
  if (typeof value !== "object" || value === null) {
    throw new ReproductionPlanError("A reproduction step must be an object.");
  }
  const step = value as Record<string, unknown>;
  switch (step["kind"]) {
    case "navigate":
      if (typeof step["path"] !== "string" || step["path"].length === 0) {
        throw new ReproductionPlanError("A navigate step requires a path.");
      }
      return { kind: "navigate", path: step["path"] };
    case "click":
      return { kind: "click", target: parseSemanticTarget(step["target"]) };
    case "input":
      if (typeof step["valueRef"] !== "string" || step["valueRef"].length === 0) {
        throw new ReproductionPlanError("An input step requires a valueRef.");
      }
      return {
        kind: "input",
        target: parseSemanticTarget(step["target"]),
        valueRef: step["valueRef"],
      };
    case "verify": {
      const claimIds = step["claimIds"];
      if (
        !Array.isArray(claimIds) ||
        claimIds.length === 0 ||
        !claimIds.every((id): id is string => typeof id === "string")
      ) {
        throw new ReproductionPlanError(
          "A verify step requires a non-empty claimIds array.",
        );
      }
      return {
        kind: "verify",
        claimIds: claimIds as [string, ...string[]],
      };
    }
    default:
      throw new ReproductionPlanError(
        `Unsupported reproduction step kind ${String(step["kind"])}.`,
      );
  }
}

function parseSemanticTarget(value: unknown): {
  readonly purpose: string;
  readonly role?: string;
  readonly name?: string;
} {
  if (typeof value !== "object" || value === null) {
    throw new ReproductionPlanError("A step target must be an object.");
  }
  const target = value as Record<string, unknown>;
  if (typeof target["purpose"] !== "string" || target["purpose"].length === 0) {
    throw new ReproductionPlanError("A step target requires a purpose.");
  }
  // Reject any attempt to smuggle an executable locator into a plan.
  for (const forbidden of ["selector", "css", "xpath", "coordinates", "script"]) {
    if (forbidden in target) {
      throw new ReproductionPlanError(
        `A reproduction step target must not carry a ${forbidden} locator.`,
      );
    }
  }
  return {
    purpose: target["purpose"],
    ...(typeof target["role"] === "string" ? { role: target["role"] } : {}),
    ...(typeof target["name"] === "string" ? { name: target["name"] } : {}),
  };
}

/**
 * Deterministically derive a snapshotted {@link ReproductionPlan} from a
 * validated reproduction-planning result. Throws if the proposal is malformed or
 * carries a selector.
 */
export function reproductionPlanFromResult(
  caseId: string,
  planRevision: number,
  result: IntelligenceResult,
): ReproductionPlan {
  const proposal = result.proposals[0];
  if (proposal === undefined) {
    throw new ReproductionPlanError("The planning result carried no proposal.");
  }
  const rawSteps = proposal["steps"];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new ReproductionPlanError("A reproduction plan requires steps.");
  }
  const steps = rawSteps.map(parseIntentStep);
  const rationale =
    typeof proposal["rationale"] === "string" ? proposal["rationale"] : "";
  return { caseId, planRevision, steps, rationale };
}

/**
 * Deterministically derive a {@link BugEpisodeDraft} from a validated
 * bug-analysis result. The confidence is taken from the result envelope, not the
 * proposal, so it cannot diverge from the value the applier validated.
 */
export function bugEpisodeDraftFromResult(
  result: IntelligenceResult,
  fallbackEpisodeId: string,
): BugEpisodeDraft {
  const proposal = result.proposals[0];
  if (proposal === undefined) {
    throw new ReproductionPlanError("The analysis result carried no proposal.");
  }
  const confirmedAttemptIds = proposal["confirmedAttemptIds"];
  if (
    !Array.isArray(confirmedAttemptIds) ||
    confirmedAttemptIds.length === 0 ||
    !confirmedAttemptIds.every((id): id is string => typeof id === "string")
  ) {
    throw new ReproductionPlanError(
      "A bug analysis must reference at least one confirmed attempt.",
    );
  }
  const minimalStepsRaw = proposal["minimalSteps"];
  const minimalSteps = Array.isArray(minimalStepsRaw)
    ? minimalStepsRaw.map(parseIntentStep)
    : [];
  const episodeId =
    typeof proposal["episodeId"] === "string"
      ? proposal["episodeId"]
      : fallbackEpisodeId;
  return {
    episodeId,
    confirmedAttemptIds: confirmedAttemptIds as [string, ...string[]],
    expectedClaims: stringArray(proposal["expectedClaims"]),
    observedFacts: stringArray(proposal["observedFacts"]),
    minimalSteps,
    environment: stringRecord(proposal["environment"]),
    evidenceRefs: [...result.evidenceRefs],
    confidence: result.confidence,
  };
}

export function reproducedAttemptIds(
  attempts: readonly ReproductionAttempt[],
): readonly string[] {
  return attempts
    .filter((attempt) => attempt.outcome === "reproduced")
    .map((attempt) => attempt.attemptId);
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      record[key] = item;
    }
  }
  return record;
}
