import type { AcceptedExecutionJob, ExecutionPolicySnapshot } from "@qualigence/runner-protocol";
import type {
  PolicyDecision,
  ResolvedAction,
  RunnerPolicyContext,
  RunnerPolicyGate,
} from "./execution-runtime.js";

export type TargetAdmission =
  | { readonly status: "allowed"; readonly gate: DeterministicRunnerPolicyGate }
  | { readonly status: "denied"; readonly code: "PolicyMissing" | "PolicyDenied"; readonly message: string };

const RISK_ORDER = ["Normal", "ExternalSideEffect", "Destructive", "ProductionForbidden"] as const;

export interface DeterministicRunnerPolicyGateOptions {
  readonly now?: () => number;
}

/** Final Runner-side enforcement of the immutable Job policy snapshot. */
export class DeterministicRunnerPolicyGate implements RunnerPolicyGate {
  private readonly now: () => number;

  constructor(
    private readonly policy: ExecutionPolicySnapshot,
    options: DeterministicRunnerPolicyGateOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  static admitJob(job: unknown, options: DeterministicRunnerPolicyGateOptions = {}): TargetAdmission {
    if (!isAcceptedExecutionJob(job) || !isPolicy(job.policy)) {
      return { status: "denied", code: "PolicyMissing", message: "execution Job policy is required" };
    }
    const policy = job.policy;
    if (Date.parse(policy.expiresAt) <= (options.now ?? Date.now)()) {
      return { status: "denied", code: "PolicyDenied", message: "PolicyExpired" };
    }
    let target: URL;
    try {
      target = new URL(job.target.url);
    } catch {
      return { status: "denied", code: "PolicyDenied", message: "TargetInvalid" };
    }
    if ((target.protocol !== "http:" && target.protocol !== "https:") || !policy.allowedOrigins.includes(target.origin)) {
      return { status: "denied", code: "PolicyDenied", message: "TargetOriginDenied" };
    }
    return { status: "allowed", gate: new DeterministicRunnerPolicyGate(policy, options) };
  }

  async authorize(action: ResolvedAction, context: RunnerPolicyContext): Promise<PolicyDecision> {
    if (Date.parse(this.policy.expiresAt) <= this.now()) return denied("PolicyExpired");
    if (!this.policy.allowedOrigins.includes(originOf(context.job))) return denied("TargetOriginDenied");
    if (this.policy.environment === "production" && this.policy.explorationAllowed) return denied("ProductionExplorationDenied");

    const actionKind = action.kind;
    if (!this.policy.allowedActionKinds.includes(actionKind)) return denied("ActionKindDenied");
    const risk = riskFor(action);
    if (risk === "ProductionForbidden" || rank(risk) > rank(this.policy.maximumRisk)) return denied("RiskDenied");
    if (isFallback(action)) return denied("FallbackDenied");
    if (this.policy.environment === "staging" && (actionKind !== "click" || risk !== "Normal")) {
      return denied("StagingPolicyDenied");
    }
    return { status: "allowed", reason: "PolicyAllowed" };
  }
}

function denied(reason: string): PolicyDecision {
  return { status: "denied", reason };
}

function originOf(job: AcceptedExecutionJob): string {
  try {
    return new URL(job.target.url).origin;
  } catch {
    return "";
  }
}

function riskFor(action: ResolvedAction): typeof RISK_ORDER[number] {
  if (action.targetKind === "desktop") {
    if (action.kind === "window" && action.windowOperation === "close") return "Destructive";
    if (action.kind === "input" || action.kind === "select") return "ExternalSideEffect";
  }
  return "Normal";
}

function isFallback(action: ResolvedAction): boolean {
  return action.targetKind === "desktop" && (action.resolution === "coordinate" || action.resolution === "visual");
}

function rank(risk: string): number {
  return RISK_ORDER.indexOf(risk as typeof RISK_ORDER[number]);
}

function isAcceptedExecutionJob(value: unknown): value is AcceptedExecutionJob {
  return typeof value === "object" && value !== null && "target" in value && "policy" in value;
}

function isPolicy(value: unknown): value is ExecutionPolicySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Record<string, unknown>;
  return (
    typeof policy.policyId === "string" &&
    (policy.environment === "isolated_test" || policy.environment === "staging" || policy.environment === "production") &&
    Array.isArray(policy.allowedOrigins) &&
    Array.isArray(policy.allowedActionKinds) &&
    typeof policy.maximumRisk === "string" &&
    typeof policy.explorationAllowed === "boolean" &&
    typeof policy.issuedAt === "string" &&
    typeof policy.expiresAt === "string"
  );
}
