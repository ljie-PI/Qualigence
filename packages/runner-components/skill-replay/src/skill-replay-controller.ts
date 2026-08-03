import type { SemanticTarget } from "@qualigence/application-model";
import type {
  SignedSkillBundle,
  SkillAssertion,
  SkillSigner,
  SkillStep,
  SkillReplayResult,
  SkillVerificationScope,
} from "@qualigence/skill";

/** A single semantic node observed on the live Target during replay. */
export interface ReplayNode {
  readonly role: string;
  readonly name: string;
  readonly text?: string;
}

/** One observation snapshot of the live Target between actions. */
export interface ReplayObservation {
  readonly urlPath: string;
  readonly nodes: readonly ReplayNode[];
  /** Semantic claims currently satisfied on the Target (by claim id). */
  readonly claims: readonly string[];
}

/** The concrete action the controller resolved a step to before executing it. */
export interface ResolvedReplayAction {
  readonly step: SkillStep;
  readonly node?: ReplayNode;
}

/**
 * The live Target a Skill replays against. `capture` re-observes semantics;
 * `execute` performs the resolved action. Both are only ever called after the
 * Bundle's signature has been verified.
 */
export interface ReplayTarget {
  capture(): Promise<ReplayObservation>;
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

    for (const step of bundle.payload.steps) {
      const stepResult = await this.runStep(target, step);
      if (stepResult.status !== "passed") {
        return stepResult;
      }
    }
    return { status: "passed" };
  }

  private async runStep(
    target: ReplayTarget,
    step: SkillStep,
  ): Promise<SkillReplayResult> {
    const observation = await target.capture();

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

    if (checkpointHolds(step, await target.capture())) {
      return { status: "passed" };
    }
    if (step.recovery === "reobserve") {
      // Recover by re-observing exactly once before giving up.
      if (checkpointHolds(step, await target.capture())) {
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
  observation: ReplayObservation,
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

function checkpointHolds(step: SkillStep, observation: ReplayObservation): boolean {
  return step.checkpoint.every((assertion) =>
    assertionHolds(assertion, observation),
  );
}

function assertionHolds(
  assertion: SkillAssertion,
  observation: ReplayObservation,
): boolean {
  switch (assertion.kind) {
    case "url_path":
      return observation.urlPath === assertion.path;
    case "claim_satisfied":
      return observation.claims.includes(assertion.claimId);
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
      if (matches.length !== 1) {
        return false;
      }
      const node = matches[0];
      const text = node?.text ?? node?.name ?? "";
      return normalize(text).includes(normalize(assertion.expected));
    }
  }
}

/**
 * Semantic match: a Target locates a node by accessible role/name/purpose, not
 * by DOM order or exact text, so reordered or slightly re-worded DOM still
 * resolves to the same node.
 */
function matchesTarget(target: SemanticTarget, node: ReplayNode): boolean {
  if (target.role !== undefined && normalize(node.role) !== normalize(target.role)) {
    return false;
  }
  if (target.name !== undefined) {
    return normalize(node.name) === normalize(target.name);
  }
  const tokens = normalize(target.purpose).split(" ").filter(Boolean);
  const haystack = normalize(`${node.role} ${node.name} ${node.text ?? ""}`);
  return tokens.every((token) => haystack.includes(token));
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
