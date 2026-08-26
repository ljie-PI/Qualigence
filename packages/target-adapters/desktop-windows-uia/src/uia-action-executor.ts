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
  DesktopPlaintextValue,
} from "@qualigence/desktop-contracts";
import {
  desktopActionDigestSha256,
  desktopValueBindingForPlaintext,
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

export interface DesktopActionValueProvider {
  resolve(valueRef: string): Promise<string>;
}

export interface UiaActionExecutorContext {
  readonly sessionId: string;
  readonly runId: string;
  /** Per-action wall-clock deadline handed to the Companion worker. */
  readonly deadlineMs: number;
  /** Resolves Desktop input/select values at the dispatch boundary. */
  readonly valueProvider?: DesktopActionValueProvider;
}

function bindingOnly(value: DesktopPlaintextValue): { readonly valueRef: string; readonly valueSha256: string; readonly valueByteLength: number } {
  return { valueRef: value.valueRef, valueSha256: value.valueSha256, valueByteLength: value.valueByteLength };
}

function toLocalAuthorization(
  descriptor: ExecutionPermitDescriptor,
  context: UiaActionExecutorContext,
  action: ResolvedDesktopAction,
  value: DesktopPlaintextValue | undefined,
): LocalPermitAuthorization {
  const valueBinding = value === undefined ? undefined : bindingOnly(value);
  const base = {
    decisionId: descriptor.decisionId,
    policyId: descriptor.policyId,
    // ExecutionRisk and LocalActionRisk are the same closed union.
    risk: descriptor.risk as LocalActionRisk,
    expiresAt: descriptor.expiresAt,
    ...(valueBinding === undefined ? {} : { valueBinding }),
  };
  return {
    ...base,
    actionDigestSha256: desktopActionDigestSha256({
      sessionId: context.sessionId,
      runId: context.runId,
      action,
      decisionId: base.decisionId,
      policyId: base.policyId,
      risk: base.risk,
      expiresAt: base.expiresAt,
      ...(valueBinding === undefined ? {} : { valueBinding }),
    }),
  };
}

function safeSummary(action: ResolvedDesktopAction): string {
  return `${action.kind} on ${action.nodeId}`;
}

function toActionOutcome(report: ActionOutcomeReport): ActionOutcome {
  return report.status === "ok" ? { status: "ok" } : { status: "failed", errorCode: report.errorCode };
}

async function resolvePlaintextValue(
  action: ResolvedDesktopAction,
  provider: DesktopActionValueProvider | undefined,
): Promise<DesktopPlaintextValue | undefined> {
  if (action.kind !== "input" && action.kind !== "select") return undefined;
  if (provider === undefined) {
    throw new DesktopExecutionError("ValueBindingMissing", "Desktop input/select actions require an action value provider");
  }
  return desktopValueBindingForPlaintext(action.valueRef, await provider.resolve(action.valueRef));
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

    const desktopAction = action as ResolvedDesktopAction;
    const value = await resolvePlaintextValue(desktopAction, this.context.valueProvider);
    const request: LocalPermitRequest = {
      approvalId: `${this.context.runId}:${desktopAction.actionId}`,
      sessionId: this.context.sessionId,
      runId: this.context.runId,
      action: desktopAction,
      authorization: toLocalAuthorization(descriptor, this.context, desktopAction, value),
      safeSummary: safeSummary(desktopAction),
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

    if (value !== undefined) {
      const binding = decision.permit.valueBinding;
      if (
        binding === undefined ||
        binding.valueRef !== value.valueRef ||
        binding.valueSha256 !== value.valueSha256 ||
        binding.valueByteLength !== value.valueByteLength ||
        decision.permit.actionDigestSha256 !== request.authorization.actionDigestSha256
      ) {
        throw new DesktopExecutionError("ValueBindingMismatch", "the Companion permit does not match the resolved action value binding");
      }
    }

    const report = await this.companion.execute({
      sessionId: this.context.sessionId,
      action: desktopAction,
      permit: decision.permit,
      deadlineMs: this.context.deadlineMs,
      ...(value === undefined ? {} : { value }),
    });
    return toActionOutcome(report);
  }
}
