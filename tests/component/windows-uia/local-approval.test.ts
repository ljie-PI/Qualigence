import { describe, expect, it } from "vitest";
import {
  AppEnvironmentProvider,
  DesktopExecutionError,
  UiaActionExecutor,
  UiaActionResolver,
  WindowsDesktopAdapter,
} from "@qualigence/desktop-windows-uia";
import {
  ExecutionPermit,
  runnerPolicyActionDigestSha256,
  type ExecutionPermitDescriptor,
  type ExecutionRisk,
  type ProposedAction,
  type ResolvedDesktopAction,
} from "@qualigence/runner-kernel";
import type { ObservationGraphV1 } from "@qualigence/observation-contracts";
import { desktopActionDigestSha256 } from "@qualigence/desktop-contracts";
import {
  FakeReferenceCompanion,
  loadReferenceAppFixture,
  referenceExpectedAction,
} from "../../helpers/windows-reference-app.js";

const DEADLINE_MS = 5_000;
const RUN_ID = "run-approval";

function permitFor(action: ResolvedDesktopAction, risk: ExecutionRisk): ExecutionPermit {
  const decisionId = `decision:${action.actionId}`;
  const policyId = "policy:windows-reference";
  const expiresAt = "2026-08-02T00:01:00.000Z";
  const descriptor: ExecutionPermitDescriptor = {
    decisionId,
    policyId,
    actionDigestSha256: runnerPolicyActionDigestSha256({ runId: RUN_ID, action, decisionId, policyId, risk, expiresAt }),
    risk,
    expiresAt,
  };
  return ExecutionPermit.fromAllowedDecision({
    status: "allowed",
    reason: "windows-reference approval test",
    descriptor,
  });
}

async function setup(options: { approveHighRisk?: boolean } = {}) {
  const fixture = loadReferenceAppFixture("wpf");
  const companion = new FakeReferenceCompanion(fixture.uiaSource, options);
  const session = await new AppEnvironmentProvider(companion).launch(fixture.appTarget);
  const graph: ObservationGraphV1 = await new WindowsDesktopAdapter(companion).capture({
    sessionId: session.sessionId,
    deadlineMs: DEADLINE_MS,
  });
  const executor = new UiaActionExecutor(companion, {
    sessionId: session.sessionId,
    runId: RUN_ID,
    deadlineMs: DEADLINE_MS,
  });
  const resolver = new UiaActionResolver();
  const resolveExpected = (actionId: string): ResolvedDesktopAction =>
    resolver.resolve(referenceExpectedAction(fixture, actionId).proposal as ProposedAction, graph, {
      actionId,
    });
  return { companion, executor, resolveExpected };
}

describe("Windows-UIA local approval + one-time Permit security", () => {
  it("auto-approves a Normal action and dispatches exactly one UIA action", async () => {
    const { companion, executor, resolveExpected } = await setup();
    const resolved = resolveExpected("act-submit");

    const outcome = await executor.execute(resolved, permitFor(resolved, "Normal"));

    expect(outcome).toEqual({ status: "ok" });
    expect(companion.executedActions).toHaveLength(1);
  });

  it("dispatches ZERO UIA actions when the operator denies a high-risk action", async () => {
    const { companion, executor, resolveExpected } = await setup({ approveHighRisk: false });
    const resolved = resolveExpected("act-delete-all");

    await expect(executor.execute(resolved, permitFor(resolved, "Destructive"))).rejects.toThrow(
      DesktopExecutionError,
    );
    // A denial fails closed: the worker was never asked to execute anything.
    expect(companion.executedActions).toHaveLength(0);
    expect(companion.consumedPermitCount).toBe(0);
  });

  it("dispatches ZERO UIA actions once an Emergency Stop is latched", async () => {
    const { companion, executor, resolveExpected } = await setup();
    const resolved = resolveExpected("act-submit");

    companion.emergencyStop();

    await expect(executor.execute(resolved, permitFor(resolved, "Normal"))).rejects.toThrow(
      /EmergencyStopped/,
    );
    expect(companion.executedActions).toHaveLength(0);
  });

  it("times out (no dispatch) while the session is paused, then resumes", async () => {
    const { companion, executor, resolveExpected } = await setup();
    const resolved = resolveExpected("act-submit");

    companion.pause();
    await expect(executor.execute(resolved, permitFor(resolved, "Normal"))).rejects.toThrow(
      /LocalPermitTimedOut/,
    );
    expect(companion.executedActions).toHaveLength(0);

    companion.resume();
    const outcome = await executor.execute(resolved, permitFor(resolved, "Normal"));
    expect(outcome).toEqual({ status: "ok" });
    expect(companion.executedActions).toHaveLength(1);
  });

  it("refuses a forbidden (ProductionForbidden) action outright", async () => {
    const { companion, executor, resolveExpected } = await setup();
    const resolved = resolveExpected("act-submit");

    await expect(
      executor.execute(resolved, permitFor(resolved, "ProductionForbidden")),
    ).rejects.toThrow(/LocalPermitDenied/);
    expect(companion.executedActions).toHaveLength(0);
  });

  it("treats a local Permit as one-time: a replayed Permit fails closed", async () => {
    const { companion, resolveExpected } = await setup();
    const resolved = resolveExpected("act-submit");

    // Directly broker one Permit and attempt to consume it twice.
    const nonceBase64 = Buffer.from("nonce-replay").toString("base64");
    const digest = desktopActionDigestSha256({
      sessionId: (companion as unknown as { launchedSessionId?: string }).launchedSessionId ??
        "sess:windows-reference-wpf",
      runId: RUN_ID,
      action: resolved,
      decisionId: "decision:replay",
      policyId: "policy:windows-reference",
      risk: "Normal",
      expiresAt: "2026-08-02T00:01:00.000Z",
      nonceBase64,
    });
    const request = {
      approvalId: "approval-replay",
      sessionId: (companion as unknown as { launchedSessionId?: string }).launchedSessionId ??
        "sess:windows-reference-wpf",
      runId: RUN_ID,
      action: resolved,
      authorization: {
        decisionId: "decision:replay",
        policyId: "policy:windows-reference",
        actionDigestSha256: digest,
        risk: "Normal" as const,
        expiresAt: "2026-08-02T00:01:00.000Z",
        nonceBase64,
      },
      safeSummary: "click on submitButton",
      expiresAt: "2026-08-02T00:01:00.000Z",
    };
    const decision = await companion.requestPermit(request);
    expect(decision.status).toBe("approved");
    if (decision.status !== "approved") {
      throw new Error("expected approval");
    }

    const first = await companion.execute({
      sessionId: request.sessionId,
      action: resolved,
      permit: decision.permit,
      deadlineMs: DEADLINE_MS,
    });
    expect(first).toEqual({ status: "ok" });

    const replay = await companion.execute({
      sessionId: request.sessionId,
      action: resolved,
      permit: decision.permit,
      deadlineMs: DEADLINE_MS,
    });
    expect(replay).toEqual({ status: "failed", errorCode: "LocalPermitConsumed" });
    // Only the first, legitimate consumption dispatched an action.
    expect(companion.executedActions).toHaveLength(1);
  });
});
