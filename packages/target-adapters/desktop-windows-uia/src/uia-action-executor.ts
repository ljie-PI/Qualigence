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

import { randomBytes } from "node:crypto";
import type {
  DesktopPlaintextValue,
  DesktopValueBinding,
  LocalActionRisk,
  LocalExecutionPermit,
  LocalPermitAuthorization,
  LocalPermitRequest,
  ResolvedDesktopAction,
} from "@qualigence/desktop-contracts";
import {
  desktopActionDigestSha256,
  desktopValueBindingForPlaintext,
} from "@qualigence/desktop-contracts";
import {
  isDesktopAction,
  runnerPolicyActionDigestSha256,
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

function bindingOnly(value: DesktopPlaintextValue): DesktopValueBinding {
  return { valueRef: value.valueRef, valueSha256: value.valueSha256, valueByteLength: value.valueByteLength };
}

function assertDescriptorMatchesAction(
  descriptor: ExecutionPermitDescriptor,
  context: UiaActionExecutorContext,
  action: ResolvedDesktopAction,
): void {
  const expected = runnerPolicyActionDigestSha256({
    runId: context.runId,
    action,
    decisionId: descriptor.decisionId,
    policyId: descriptor.policyId,
    risk: descriptor.risk,
    expiresAt: descriptor.expiresAt,
  });
  if (descriptor.actionDigestSha256 !== expected) {
    throw new DesktopExecutionError("ValueBindingMismatch", "the Runner policy descriptor does not match the resolved Desktop action");
  }
}

function toLocalAuthorization(
  descriptor: ExecutionPermitDescriptor,
  context: UiaActionExecutorContext,
  action: ResolvedDesktopAction,
  nonceBase64: string,
  valueBinding: DesktopValueBinding | undefined,
): LocalPermitAuthorization {
  const base = {
    decisionId: descriptor.decisionId,
    policyId: descriptor.policyId,
    // ExecutionRisk and LocalActionRisk are the same closed union.
    risk: descriptor.risk as LocalActionRisk,
    expiresAt: descriptor.expiresAt,
    nonceBase64,
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
      nonceBase64: base.nonceBase64,
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

async function resolveValueBinding(
  action: ResolvedDesktopAction,
  provider: DesktopActionValueProvider | undefined,
): Promise<DesktopValueBinding | undefined> {
  const value = await resolvePlaintextValue(action, provider);
  return value === undefined ? undefined : bindingOnly(value);
}

function assertPermitMatchesAuthorization(
  permit: LocalExecutionPermit,
  authorization: LocalPermitAuthorization,
  context: UiaActionExecutorContext,
  action: ResolvedDesktopAction,
): void {
  if (
    permit.sessionId !== context.sessionId ||
    permit.runId !== context.runId ||
    permit.actionId !== action.actionId ||
    permit.graphId !== action.graphId ||
    permit.actionDigestSha256 !== authorization.actionDigestSha256 ||
    permit.risk !== authorization.risk
  ) {
    throw new DesktopExecutionError("ValueBindingMismatch", "the Companion permit does not match the authorized Desktop action binding");
  }
  if (permit.decisionId !== undefined || permit.policyId !== undefined) {
    if (
      permit.decisionId !== authorization.decisionId ||
      permit.policyId !== authorization.policyId ||
      permit.nonceBase64 !== authorization.nonceBase64 ||
      permit.expiresAt !== authorization.expiresAt
    ) {
      throw new DesktopExecutionError("ValueBindingMismatch", "the Companion permit decision/policy/nonce binding does not match the authorization");
    }
  }
  const expectedBinding = authorization.valueBinding;
  const actualBinding = permit.valueBinding;
  if (expectedBinding === undefined) {
    if (actualBinding !== undefined) {
      throw new DesktopExecutionError("ValueBindingMismatch", "non-value Desktop actions must not include a permit value binding");
    }
    return;
  }
  if (
    actualBinding === undefined ||
    actualBinding.valueRef !== expectedBinding.valueRef ||
    actualBinding.valueSha256 !== expectedBinding.valueSha256 ||
    actualBinding.valueByteLength !== expectedBinding.valueByteLength
  ) {
    throw new DesktopExecutionError("ValueBindingMismatch", "the Companion permit does not match the resolved action value binding");
  }
}

function assertPlaintextMatchesBinding(
  value: DesktopPlaintextValue | undefined,
  binding: DesktopValueBinding | undefined,
): void {
  if (binding === undefined) {
    if (value !== undefined) {
      throw new DesktopExecutionError("ValueBindingMismatch", "non-value Desktop actions must not dispatch plaintext");
    }
    return;
  }
  if (
    value === undefined ||
    value.valueRef !== binding.valueRef ||
    value.valueSha256 !== binding.valueSha256 ||
    value.valueByteLength !== binding.valueByteLength
  ) {
    throw new DesktopExecutionError("ValueBindingMismatch", "the dispatch plaintext no longer matches the approved value binding");
  }
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

  async execute(action: ResolvedAction, permit: ExecutionPermit, signal?: AbortSignal): Promise<ActionOutcome> {
    if (!isDesktopAction(action)) {
      throw new DesktopExecutionError(
        "UnsupportedTargetKind",
        `the UIA executor cannot run a "${action.targetKind ?? "web"}" action`,
      );
    }
    signal?.throwIfAborted();
    const descriptor = permit.descriptor;
    if (descriptor === undefined) {
      throw new DesktopExecutionError(
        "MissingPermitDescriptor",
        "a Desktop action requires a policy-bound permit descriptor",
      );
    }

    const desktopAction = action as ResolvedDesktopAction;
    assertDescriptorMatchesAction(descriptor, this.context, desktopAction);
    const nonceBase64 = randomBytes(32).toString("base64");
    const valueBinding = await resolveValueBinding(desktopAction, this.context.valueProvider);
    signal?.throwIfAborted();
    const authorization = toLocalAuthorization(descriptor, this.context, desktopAction, nonceBase64, valueBinding);
    const request: LocalPermitRequest = {
      approvalId: `${this.context.runId}:${desktopAction.actionId}:${nonceBase64}`,
      sessionId: this.context.sessionId,
      runId: this.context.runId,
      action: desktopAction,
      authorization,
      safeSummary: safeSummary(desktopAction),
      expiresAt: descriptor.expiresAt,
    };

    const decision = await this.companion.requestPermit(request);
    signal?.throwIfAborted();
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

    assertPermitMatchesAuthorization(decision.permit, authorization, this.context, desktopAction);
    const value = await resolvePlaintextValue(desktopAction, this.context.valueProvider);
    assertPlaintextMatchesBinding(value, valueBinding);

    const executeRequest = {
      sessionId: this.context.sessionId,
      action: desktopAction,
      permit: decision.permit,
      deadlineMs: this.context.deadlineMs,
      ...(value === undefined ? {} : { value }),
    };
    permit.assertAuthorizedForDispatch(signal);
    const report = await this.companion.execute(executeRequest);
    return toActionOutcome(report);
  }
}
