import type { SemanticTarget } from "@qualigence/application-model";
import {
  ObservationError,
  findGraphExtensionMajor,
  observationError,
  requireGraphExtensionMajor,
  validateObservationGraphV1,
  type ObservationGraphV1,
  type ObservationNodeV1,
  type VersionedExtension,
} from "@qualigence/runner-protocol";
import type {
  SignedSkillBundle,
  SkillAssertion,
  SkillSigner,
  SkillStep,
  SkillReplayResult,
  SkillVerificationScope,
} from "@qualigence/skill";

/**
 * @deprecated Historical pre-v1 replay DTO kept only so stale callers can be
 * rejected at the live replay boundary. Active replay consumes validated
 * Observation Graph v1 snapshots.
 */
export interface ReplayNode {
  readonly role: string;
  readonly name: string;
  readonly text?: string;
}

/**
 * @deprecated Historical pre-v1 replay DTO. `SkillReplayController` rejects
 * this shape; pre-v1 assets must project through `@qualigence/observation-migration`
 * before live replay.
 */
export interface ReplayObservation {
  readonly urlPath: string;
  readonly nodes: readonly ReplayNode[];
  /** Semantic claims currently satisfied on the Target (by claim id). */
  readonly claims: readonly string[];
}

/** The concrete action the controller resolved a step to before executing it. */
export interface ResolvedReplayAction {
  readonly step: SkillStep;
  readonly node?: ObservationNodeV1;
}

/**
 * The live Target a Skill replays against. `capture` re-observes v1 semantics;
 * `execute` performs the resolved action. Both are only ever called after the
 * Bundle's signature has been verified. The captured payload is treated as
 * untrusted at the boundary and must validate as Observation Graph v1 before any
 * precondition, resolver, checkpoint, or action consumes it.
 */
export interface ReplayTarget {
  capture(): Promise<unknown>;
  execute(action: ResolvedReplayAction): Promise<void>;
}

export interface SkillReplayControllerDependencies {
  readonly signer: SkillSigner;
}

/**
 * Re-executes a signed Procedure Skill Bundle against a live Target, resolving
 * every step by semantics (never a stored selector). The signature is verified
 * *before* the Target is ever touched, so a tampered Bundle is rejected without
 * side effects. Each step re-observes the Target, checks preconditions (safe
 * `PlanDiverged` on mismatch), executes, then checks the checkpoint. A failed
 * checkpoint on a `reobserve` step retries observation once before stopping.
 */
export class SkillReplayController {
  constructor(private readonly deps: SkillReplayControllerDependencies) {}

  async run(
    bundle: SignedSkillBundle,
    target: ReplayTarget,
    scope: SkillVerificationScope,
  ): Promise<SkillReplayResult> {
    const verification = await this.deps.signer.verify(bundle, scope);
    if (verification.status !== "valid") {
      // Reject before any Target access — no capture, no execute.
      return { status: "blocked", errorCode: verification.code };
    }

    try {
      for (const step of bundle.payload.steps) {
        const stepResult = await this.runStep(target, step);
        if (stepResult.status !== "passed") {
          return stepResult;
        }
      }
      return { status: "passed" };
    } catch (error) {
      const observationFailure = observationFailureResult(error);
      if (observationFailure !== undefined) {
        return observationFailure;
      }
      throw error;
    }
  }

  private async runStep(
    target: ReplayTarget,
    step: SkillStep,
  ): Promise<SkillReplayResult> {
    const observation = await captureReplayGraph(target);

    for (const precondition of step.preconditions) {
      if (!assertionHolds(precondition, observation)) {
        return { status: "blocked", errorCode: "PlanDiverged" };
      }
    }

    const resolution = resolveAction(step, observation);
    if (resolution.status === "diverged") {
      return { status: "blocked", errorCode: "PlanDiverged" };
    }

    await target.execute(resolution.action);

    if (checkpointHolds(step, await captureReplayGraph(target))) {
      return { status: "passed" };
    }
    if (step.recovery === "reobserve") {
      // Recover by re-observing exactly once before giving up.
      if (checkpointHolds(step, await captureReplayGraph(target))) {
        return { status: "passed" };
      }
    }
    return { status: "blocked", errorCode: "PlanDiverged" };
  }
}

type ActionResolution =
  | { readonly status: "resolved"; readonly action: ResolvedReplayAction }
  | { readonly status: "diverged" };

function resolveAction(
  step: SkillStep,
  observation: ObservationGraphV1,
): ActionResolution {
  const intent = step.intent;
  if (intent.kind === "navigate") {
    return { status: "resolved", action: { step } };
  }
  const matches = observation.nodes.filter((node) =>
    matchesTarget(intent.target, node),
  );
  const node = matches[0];
  if (matches.length !== 1 || node === undefined) {
    // Zero or ambiguous matches both diverge — never guess a node.
    return { status: "diverged" };
  }
  return { status: "resolved", action: { step, node } };
}

function checkpointHolds(step: SkillStep, observation: ObservationGraphV1): boolean {
  return step.checkpoint.every((assertion) =>
    assertionHolds(assertion, observation),
  );
}

function assertionHolds(
  assertion: SkillAssertion,
  observation: ObservationGraphV1,
): boolean {
  switch (assertion.kind) {
    case "url_path":
      return observationPathname(observation) === assertion.path;
    case "claim_satisfied":
      return satisfiedClaimIds(observation).includes(assertion.claimId);
    case "node_present":
      return (
        observation.nodes.filter((node) =>
          matchesTarget(assertion.target, node),
        ).length === 1
      );
    case "node_text": {
      const matches = observation.nodes.filter((node) =>
        matchesTarget(assertion.target, node),
      );
      const node = matches[0];
      if (matches.length !== 1 || node === undefined) {
        return false;
      }
      const text = nodeVisibleText(node);
      return normalize(text).includes(normalize(assertion.expected));
    }
  }
}

/**
 * Semantic match: a Target locates a node by accessible role/name/purpose, not
 * by DOM order or exact text, so reordered or slightly re-worded DOM still
 * resolves to the same node.
 */
function matchesTarget(target: SemanticTarget, node: ObservationNodeV1): boolean {
  if (target.role !== undefined && normalize(node.role) !== normalize(target.role)) {
    return false;
  }
  if (target.name !== undefined) {
    return node.name !== undefined && normalize(node.name) === normalize(target.name);
  }
  const tokens = normalize(target.purpose).split(" ").filter(Boolean);
  const haystack = normalize(`${node.role} ${node.name ?? ""} ${nodeVisibleText(node)}`);
  return tokens.every((token) => haystack.includes(token));
}

async function captureReplayGraph(target: ReplayTarget): Promise<ObservationGraphV1> {
  const candidate = await target.capture();
  return validateReplayObservationGraph(candidate);
}

function validateReplayObservationGraph(candidate: unknown): ObservationGraphV1 {
  const graph = candidate as ObservationGraphV1;
  const validated = validateObservationGraphV1(graph, {
    allowedWebQueryKeys: webQueryKeysPresentOnCandidate(candidate),
  });
  if (validated.target.kind === "web") {
    requireWebV1Semantics(validated);
  }
  return validated;
}

function observationPathname(graph: ObservationGraphV1): string {
  return requireWebV1Semantics(graph).pathname;
}

function requireWebV1Semantics(graph: ObservationGraphV1): { readonly pathname: string } {
  const extension = requireGraphExtensionMajor(graph, "web", 1);
  const payload = extension.payload;
  return { pathname: String(payload["pathname"]) };
}

function webQueryKeysPresentOnCandidate(candidate: unknown): readonly string[] {
  if (!isRecord(candidate)) {
    return [];
  }
  const extensions = candidate["extensions"];
  if (!isRecord(extensions)) {
    return [];
  }
  const web = extensions["web/v1"];
  if (!isRecord(web)) {
    return [];
  }
  const payload = web["payload"];
  if (!isRecord(payload)) {
    return [];
  }
  const query = payload["query"];
  if (!isRecord(query)) {
    return [];
  }
  return Object.keys(query);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function satisfiedClaimIds(graph: ObservationGraphV1): readonly string[] {
  const extension = findGraphExtensionMajor(graph, "skill-replay", 1);
  if (extension !== undefined) {
    return skillReplayClaims(extension);
  }
  if (Object.keys(graph.extensions ?? {}).some((key) => key.startsWith("skill-replay/v"))) {
    requireGraphExtensionMajor(graph, "skill-replay", 1);
  }
  return [];
}

function skillReplayClaims(extension: VersionedExtension): readonly string[] {
  if (extension.type !== "skill-replay/v1") {
    throw observationError(
      "ObservationSchemaInvalid",
      'skill-replay/v1 extension type must be "skill-replay/v1".',
    );
  }
  const claims = extension.payload["claims"];
  if (claims === undefined) {
    return [];
  }
  if (!Array.isArray(claims)) {
    throw observationError(
      "ObservationSchemaInvalid",
      "skill-replay/v1 claims must be an array of strings.",
    );
  }
  return claims.map((claim, index) => {
    if (typeof claim !== "string" || claim.length === 0 || claim.normalize("NFC") !== claim) {
      throw observationError(
        "ObservationSchemaInvalid",
        `skill-replay/v1 claims[${index}] must be a non-empty NFC-normalized string.`,
      );
    }
    return claim;
  });
}

function nodeVisibleText(node: ObservationNodeV1): string {
  if (node.sensitivity === "secret") {
    return node.name ?? "";
  }
  const stateText = node.state["text"];
  return typeof stateText === "string" ? stateText : (node.value ?? node.name ?? "");
}

function observationFailureResult(error: unknown): SkillReplayResult | undefined {
  if (error instanceof ObservationError) {
    return { status: "blocked", errorCode: error.code };
  }
  return undefined;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
