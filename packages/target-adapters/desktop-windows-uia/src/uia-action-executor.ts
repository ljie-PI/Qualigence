/**
 * The Companion-brokered UIA action executor (specialist finding W-01).
 *
 * It refuses any non-Desktop action, then executes a Desktop action ONLY by
 * going through the Companion: it maps the branded {@link ExecutionPermit}'s
 * {@link ExecutionPermitDescriptor} to the structurally-equal
 * {@link LocalPermitAuthorization} DTO, sends `permit.request`, and only if the
 * Companion approves and returns a one-time local Permit does it send
 * `action.execute`. There is no code path that invokes UIA directly, and a
 * denied / timed-out / emergency-stopped decision never reaches the worker.
 */

import type {
  LocalActionRisk,
  LocalPermitAuthorization,
  LocalPermitRequest,
  ResolvedDesktopAction,
} from "@qualigence/desktop-contracts";
import {
  isDesktopAction,
  type ActionExecutor,
  type ActionOutcome,
  type ExecutionPermit,
  type ExecutionPermitDescriptor,
  type ResolvedAction,
} from "@qualigence/runner-kernel";
import {
  DesktopExecutionError,
  type ActionOutcomeReport,
  type CompanionClient,
} from "./companion-client.js";

export interface UiaActionExecutorContext {
  readonly sessionId: string;
  readonly runId: string;
  /** Per-action wall-clock deadline handed to the Companion worker. */
  readonly deadlineMs: number;
}

function toLocalAuthorization(descriptor: ExecutionPermitDescriptor): LocalPermitAuthorization {
  return {
    decisionId: descriptor.decisionId,
    policyId: descriptor.policyId,
    actionDigestSha256: descriptor.actionDigestSha256,
    // ExecutionRisk and LocalActionRisk are the same closed union.
    risk: descriptor.risk as LocalActionRisk,
    expiresAt: descriptor.expiresAt,
  };
}

function safeSummary(action: ResolvedDesktopAction): string {
  return `${action.kind} on ${action.nodeId}`;
}

function toActionOutcome(report: ActionOutcomeReport): ActionOutcome {
  return report.status === "ok"
    ? { status: "ok" }
    : { status: "failed", errorCode: report.errorCode };
}

export class UiaActionExecutor implements ActionExecutor {
  constructor(
    private readonly companion: CompanionClient,
    private readonly context: UiaActionExecutorContext,
  ) {}

  /** Only Desktop actions are supported; a Web click must never reach UIA. */
  supports(action: ResolvedAction): boolean {
    return isDesktopAction(action);
  }

  async execute(action: ResolvedAction, permit: ExecutionPermit): Promise<ActionOutcome> {
    if (!isDesktopAction(action)) {
      throw new DesktopExecutionError(
        "UnsupportedTargetKind",
        `the UIA executor cannot run a "${action.targetKind ?? "web"}" action`,
      );
    }
    const descriptor = permit.descriptor;
    if (descriptor === undefined) {
      throw new DesktopExecutionError(
        "MissingPermitDescriptor",
        "a Desktop action requires a policy-bound permit descriptor",
      );
    }

    const request: LocalPermitRequest = {
      approvalId: `${this.context.runId}:${action.actionId}`,
      sessionId: this.context.sessionId,
      runId: this.context.runId,
      action: action as ResolvedDesktopAction,
      authorization: toLocalAuthorization(descriptor),
      safeSummary: safeSummary(action),
      expiresAt: descriptor.expiresAt,
    };

    const decision = await this.companion.requestPermit(request);
    switch (decision.status) {
      case "approved":
        break;
      case "denied":
        throw new DesktopExecutionError("LocalPermitDenied", "the Companion denied the action");
      case "timed_out":
        throw new DesktopExecutionError("LocalPermitTimedOut", "the approval prompt timed out");
      case "emergency_stopped":
        throw new DesktopExecutionError("EmergencyStopped", "the session is under an Emergency Stop");
    }

    const report = await this.companion.execute({
      sessionId: this.context.sessionId,
      action,
      permit: decision.permit,
      deadlineMs: this.context.deadlineMs,
    });
    return toActionOutcome(report);
  }
}
