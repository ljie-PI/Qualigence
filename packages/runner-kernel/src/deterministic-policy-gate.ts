import { createHash } from "node:crypto";
import {
  ExecutionPlanPolicyError,
  ExecutionPolicySnapshotError,
  parseExecutionJob,
  parseExecutionPolicySnapshot,
  type AcceptedExecutionJob,
  type ExecutionPolicySnapshot,
} from "@qualigence/runner-protocol";
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
    let accepted: AcceptedExecutionJob;
    try {
      accepted = parseExecutionJob(job);
    } catch (error) {
      if (error instanceof ExecutionPlanPolicyError) {
        return { status: "denied", code: "PolicyDenied", message: "PlanActionDenied" };
      }
      if (error instanceof ExecutionPolicySnapshotError) {
        return { status: "denied", code: "PolicyMissing", message: "execution Job policy is required" };
      }
      return { status: "denied", code: "PolicyMissing", message: "execution Job policy is required" };
    }
    const policy = accepted.policy;
    if (Date.parse(policy.expiresAt) <= (options.now ?? Date.now)()) {
      return { status: "denied", code: "PolicyDenied", message: "PolicyExpired" };
    }
    switch (accepted.target.kind) {
      case "web": {
        let target: URL;
        try {
          target = new URL(accepted.target.url);
        } catch {
          return { status: "denied", code: "PolicyDenied", message: "TargetInvalid" };
        }
        if ((target.protocol !== "http:" && target.protocol !== "https:") || !policy.allowedOrigins.includes(target.origin)) {
          return { status: "denied", code: "PolicyDenied", message: "TargetOriginDenied" };
        }
        break;
      }
      case "desktop":
        break;
    }
    if (accepted.plan?.steps.some((step) =>
      step.stepIndex !== undefined && step.kind !== "verify" && !policy.allowedActionKinds.includes(step.kind)
    )) {
      return { status: "denied", code: "PolicyDenied", message: "PlanActionDenied" };
    }
    return { status: "allowed", gate: new DeterministicRunnerPolicyGate(policy, options) };
  }

  async authorize(action: ResolvedAction, context: RunnerPolicyContext): Promise<PolicyDecision> {
    try {
      parseExecutionPolicySnapshot(this.policy);
    } catch {
      return denied("PolicyMalformed");
    }
    const expiresAt = Date.parse(this.policy.expiresAt);
    if (!Number.isFinite(expiresAt)) return denied("PolicyMalformed");
    if (expiresAt <= this.now()) return denied("PolicyExpired");
    if (context.job.target.kind === "web" && !this.policy.allowedOrigins.includes(originOf(context.job))) return denied("TargetOriginDenied");
    if (this.policy.environment === "production" && this.policy.explorationAllowed) return denied("ProductionExplorationDenied");

    const actionKind = action.kind;
    if (!this.policy.allowedActionKinds.includes(actionKind)) return denied("ActionKindDenied");
    const risk = riskFor(action);
    if (
      this.policy.maximumRisk === "ProductionForbidden" ||
      risk === "ProductionForbidden" ||
      rank(risk) > rank(this.policy.maximumRisk)
    ) return denied("RiskDenied");
    if (isFallback(action)) return denied("FallbackDenied");
    if (this.policy.environment === "staging" && (actionKind !== "click" || risk !== "Normal")) {
      return denied("StagingPolicyDenied");
    }
    if (action.targetKind === "desktop") {
      return {
        status: "allowed",
        reason: "PolicyAllowed",
        descriptor: {
          decisionId: `decision:${context.job.runId}:${action.actionId}`,
          policyId: this.policy.policyId,
          actionDigestSha256: runnerPolicyActionDigestSha256({
            runId: context.job.runId,
            action,
            decisionId: `decision:${context.job.runId}:${action.actionId}`,
            policyId: this.policy.policyId,
            risk,
            expiresAt: this.policy.expiresAt,
          }),
          risk,
          expiresAt: this.policy.expiresAt,
        },
      };
    }
    return { status: "allowed", reason: "PolicyAllowed" };
  }
}

export interface RunnerPolicyActionDigestInput {
  readonly runId: string;
  readonly action: ResolvedAction;
  readonly decisionId: string;
  readonly policyId: string;
  readonly risk: string;
  readonly expiresAt: string;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function runnerPolicyActionDigestSha256(input: RunnerPolicyActionDigestInput): string {
  return createHash("sha256")
    .update(canonicalize({
      schema: "qualigence-runner-policy-action-digest/v1",
      runId: input.runId,
      action: input.action,
      decisionId: input.decisionId,
      policyId: input.policyId,
      risk: input.risk,
      expiresAt: input.expiresAt,
    }))
    .digest("hex");
}

function denied(reason: string): PolicyDecision {
  return { status: "denied", reason };
}

function originOf(job: AcceptedExecutionJob): string {
  if (job.target.kind !== "web") return "";
  try {
    return new URL(job.target.url).origin;
  } catch {
    return "";
  }
}

function riskFor(action: ResolvedAction): typeof RISK_ORDER[number] {
  if (action.kind === "input" || action.kind === "select") return "ExternalSideEffect";
  if (action.targetKind === "desktop") {
    if (action.kind === "window" && action.windowOperation === "close") return "Destructive";
  }
  return "Normal";
}

function isFallback(action: ResolvedAction): boolean {
  return action.targetKind === "desktop" && (action.resolution === "coordinate" || action.resolution === "visual");
}

function rank(risk: string): number {
  return RISK_ORDER.indexOf(risk as typeof RISK_ORDER[number]);
}
