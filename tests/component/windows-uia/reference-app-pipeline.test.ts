import { describe, expect, it } from "vitest";
import {
  AppEnvironmentProvider,
  UiaActionExecutor,
  UiaActionResolver,
  WindowsDesktopAdapter,
  type ActionOutcomeReport,
  type DesktopActionExecuteRequest,
} from "@qualigence/desktop-windows-uia";
import {
  ExecutionPermit,
  runnerPolicyActionDigestSha256,
  type ExecutionPermitDescriptor,
  type ExecutionRisk,
  type AnyProposedAction,
  type ProposedAction,
  type ResolvedDesktopAction,
} from "@qualigence/runner-kernel";
import {
  UIA_EXTENSION_TYPE,
  classifyLocalAuthorization,
  type AppSession,
  type AppTarget,
  type LocalApprovalDecision,
  type LocalPermitRequest,
} from "@qualigence/desktop-contracts";
import { validateObservationGraphV1 } from "@qualigence/observation-contracts";
import type { ObservationGraphV1 } from "@qualigence/observation-contracts";
import type { AcceptedExecutionJob } from "@qualigence/runner-protocol";
import { LocalSkillSigner } from "@qualigence/kms-local";
import {
  SkillCompiler,
  bundlePayloadContentSha256,
  skillCommand,
  TestSkill,
  type SkillInductionProposal,
  type SkillVerificationScope,
  type UnsignedSkillBundle,
} from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";
import { SkillReplayController } from "@qualigence/skill-replay";
import {
  DesktopReferenceReplayTarget,
  FakeReferenceCompanion,
  loadAllReferenceAppFixtures,
  loadReferenceAppFixture,
  referenceExpectedAction,
  referenceFixtureCapabilities,
  type ReferenceAppFixture,
  type ReferenceExpectedAction,
} from "../../helpers/windows-reference-app.js";
import { TargetRuntimeFactory, type DesktopCompanionRuntimeClient } from "../../../apps/runner/src/target-runtime-factory.js";

const DEADLINE_MS = 5_000;
const RUN_ID = "run-ref";

class ReusableRuntimeCompanion extends FakeReferenceCompanion implements DesktopCompanionRuntimeClient {
  authCalls = 0;
  probeCalls = 0;
  launchCalls = 0;
  shutdownCalls = 0;
  closeCalls = 0;

  async authenticate(): Promise<void> {
    this.authCalls += 1;
  }

  async probe(): Promise<void> {
    this.probeCalls += 1;
  }

  override async launch(target: AppTarget): Promise<AppSession> {
    this.launchCalls += 1;
    return super.launch(target);
  }

  override async shutdown(sessionId: string): Promise<void> {
    this.shutdownCalls += 1;
    await super.shutdown(sessionId);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

class ValueBindingReferenceCompanion extends FakeReferenceCompanion {
  executeRequest: DesktopActionExecuteRequest | undefined;

  override async requestPermit(request: LocalPermitRequest): Promise<LocalApprovalDecision> {
    const decision = await super.requestPermit(request);
    if (decision.status !== "approved") {
      return decision;
    }
    return {
      ...decision,
      permit: {
        ...decision.permit,
        ...(request.authorization.valueBinding === undefined ? {} : { valueBinding: request.authorization.valueBinding }),
      },
    };
  }

  override async execute(request: DesktopActionExecuteRequest): Promise<ActionOutcomeReport> {
    this.executeRequest = request;
    return super.execute(request);
  }
}

function desktopJob(fixture: ReferenceAppFixture, runId: string): AcceptedExecutionJob {
  return {
    jobId: `job:${runId}`,
    runId,
    projectId: "project-windows",
    target: { kind: "desktop", app: fixture.appTarget },
    objective: "exercise the Desktop runtime factory",
    policy: {
      policyId: "policy:windows-reference",
      environment: "isolated_test",
      allowedOrigins: ["app://windows-reference"],
      allowedActionKinds: ["click"],
      maximumRisk: "Normal",
      explorationAllowed: false,
      issuedAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2026-08-02T00:10:00.000Z",
    },
  } as AcceptedExecutionJob;
}

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
    reason: "windows-reference test policy",
    descriptor,
  });
}

async function captureGraph(
  companion: FakeReferenceCompanion,
  sessionId: string,
): Promise<ObservationGraphV1> {
  const adapter = new WindowsDesktopAdapter(companion);
  return adapter.capture({ sessionId, deadlineMs: DEADLINE_MS });
}

function resolve(
  fixture: ReferenceAppFixture,
  graph: ObservationGraphV1,
  expected: ReferenceExpectedAction,
): ResolvedDesktopAction {
  return new UiaActionResolver().resolve(expected.proposal as ProposedAction, graph, {
    actionId: expected.actionId,
  });
}

describe("Windows-UIA Reference App pipeline (Linux, synthetic UIA)", () => {
  it("declares the full reference capability surface for every fixture", () => {
    for (const fixture of loadAllReferenceAppFixtures()) {
      const capabilities = referenceFixtureCapabilities(fixture);
      for (const capability of [
        "Button",
        "Edit",
        "ComboBox",
        "List",
        "Scroll",
        "Dialog",
        "Crash",
        "Reset",
        "HighRisk",
      ] as const) {
        expect(capabilities.has(capability)).toBe(true);
      }
    }
  });

  it("fails closed before Desktop launch when the Companion readiness probe fails", async () => {
    const fixture = loadReferenceAppFixture("wpf");
    const companion = new class extends ReusableRuntimeCompanion {
      override async probe(): Promise<void> {
        await super.probe();
        throw new Error("probe unavailable");
      }
    }(fixture.uiaSource);
    const factory = new TargetRuntimeFactory({
      config: { headed: false, navigationTimeoutMs: 1_000, actionTimeoutMs: DEADLINE_MS } as never,
      verifier: { async verify() { return { status: "passed" as const, summary: "not used", claims: [] as const }; } },
      companion,
      platform: "win32",
    });

    await expect(factory.open(desktopJob(fixture, "run-probe-fail"))).rejects.toMatchObject({ errorCode: "CompanionUnavailable" });
    expect(companion.authCalls).toBe(1);
    expect(companion.probeCalls).toBe(1);
    expect(companion.launchCalls).toBe(0);
    expect(companion.shutdownCalls).toBe(0);
    expect(companion.closeCalls).toBe(0);
    expect(companion.capturedCount).toBe(0);
    expect(companion.consumedPermitCount).toBe(0);
  });

  it("keeps a probed shared Companion usable across sequential Desktop runtime closes", async () => {
    const fixture = loadReferenceAppFixture("wpf");
    const companion = new ReusableRuntimeCompanion(fixture.uiaSource);
    const factory = new TargetRuntimeFactory({
      config: { headed: false, navigationTimeoutMs: 1_000, actionTimeoutMs: DEADLINE_MS } as never,
      verifier: { async verify() { return { status: "passed" as const, summary: "not used", claims: [] as const }; } },
      companion,
      platform: "win32",
    });

    const first = await factory.open(desktopJob(fixture, "run-seq-1"));
    await first.close();
    const second = await factory.open(desktopJob(fixture, "run-seq-2"));
    await second.close();

    expect(companion.authCalls).toBe(2);
    expect(companion.probeCalls).toBe(2);
    expect(companion.launchCalls).toBe(2);
    expect(companion.shutdownCalls).toBe(2);
    expect(companion.closeCalls).toBe(0);
    expect(companion.consumedPermitCount).toBe(0);
    expect(companion.capturedCount).toBe(0);
  });

  it.each([["wpf"], ["winui"]] as const)(
    "captures a valid, secret-safe Graph v1 from the %s reference app",
    async (technology) => {
      const fixture = loadReferenceAppFixture(technology);
      const companion = new FakeReferenceCompanion(fixture.uiaSource);
      const provider = new AppEnvironmentProvider(companion);

      const session = await provider.launch(fixture.appTarget);
      expect(session.processGroupId).toContain("job:");
      // The session exposes only an opaque process-group id, never a native Job
      // handle — TypeScript can never terminate a process by PID/name.
      expect(session).not.toHaveProperty("jobObjectHandle");

      const graph = await captureGraph(companion, session.sessionId);
      // Re-validate independently of the mapping's internal validation.
      expect(() => validateObservationGraphV1(graph)).not.toThrow();

      const password = graph.nodes.find((node) => node.id === "password");
      expect(password?.sensitivity).toBe("secret");
      expect(password?.value).toBeUndefined();

      const username = graph.nodes.find((node) => node.id === "username");
      expect(username?.value).toBe("alice");

      // AutomationId is preserved losslessly in the versioned uia/v1 extension.
      const submit = graph.nodes.find((node) => node.id === "submitButton");
      expect(submit?.extensions[UIA_EXTENSION_TYPE]?.payload.automationId).toBe("SubmitButton");
    },
  );

  it.each([["wpf"], ["winui"]] as const)(
    "resolves + executes a Normal-risk click end to end against the %s fixture",
    async (technology) => {
      const fixture = loadReferenceAppFixture(technology);
      const companion = new FakeReferenceCompanion(fixture.uiaSource);
      const session = await new AppEnvironmentProvider(companion).launch(fixture.appTarget);
      const graph = await captureGraph(companion, session.sessionId);

      const expected = referenceExpectedAction(fixture, "act-submit");
      const resolved = resolve(fixture, graph, expected);
      expect(resolved.resolution).toBe("semantic");
      expect(resolved.uiaPattern).toBe("Invoke");

      const executor = new UiaActionExecutor(companion, {
        sessionId: session.sessionId,
        runId: RUN_ID,
        deadlineMs: DEADLINE_MS,
      });
      const outcome = await executor.execute(resolved, permitFor(resolved, "Normal"));

      expect(outcome).toEqual({ status: "ok" });
      expect(companion.executedActions).toHaveLength(1);
      expect(companion.executedActions[0]?.nodeId).toBe("submitButton");
      // Exactly one one-time Permit was minted and consumed for the action.
      expect(companion.consumedPermitCount).toBe(1);
    },
  );

  it.each([["wpf"], ["winui"]] as const)(
    "resolves and brokers a UIA SelectionPattern container select on the %s fixture",
    async (technology) => {
      const fixture = loadReferenceAppFixture(technology);
      const companion = new ValueBindingReferenceCompanion(fixture.uiaSource);
      const session = await new AppEnvironmentProvider(companion).launch(fixture.appTarget);
      const graph = await captureGraph(companion, session.sessionId);

      const resolved = new UiaActionResolver().resolve(
        { kind: "select", target: { nodeId: "roleCombo" }, valueRef: "role-ref", reason: "choose role" } as AnyProposedAction,
        graph,
        { actionId: "act-role-select" },
      );
      expect(resolved.uiaPattern).toBe("Selection");

      const executor = new UiaActionExecutor(companion, {
        sessionId: session.sessionId,
        runId: RUN_ID,
        deadlineMs: DEADLINE_MS,
        valueProvider: { async resolve() { return "Administrator"; } },
      });
      const outcome = await executor.execute(resolved, permitFor(resolved, "ExternalSideEffect"));

      expect(outcome).toEqual({ status: "ok" });
      expect(companion.executeRequest?.action.uiaPattern).toBe("Selection");
      expect(companion.executeRequest?.value?.valueRef).toBe("role-ref");
      expect(companion.executeRequest?.value?.plaintext).toBe("Administrator");
      expect(companion.executedActions[0]?.nodeId).toBe("roleCombo");
    },
  );

  it.each([["wpf"], ["winui"]] as const)(
    "brokers an approved high-risk destructive click on the %s fixture",
    async (technology) => {
      const fixture = loadReferenceAppFixture(technology);
      const companion = new FakeReferenceCompanion(fixture.uiaSource, { approveHighRisk: true });
      const session = await new AppEnvironmentProvider(companion).launch(fixture.appTarget);
      const graph = await captureGraph(companion, session.sessionId);

      const expected = referenceExpectedAction(fixture, "act-delete-all");
      expect(expected.requiresLocalApproval).toBe(true);
      expect(classifyLocalAuthorization(expected.policyRisk)).toBe("requires-approval");

      const resolved = resolve(fixture, graph, expected);
      const executor = new UiaActionExecutor(companion, {
        sessionId: session.sessionId,
        runId: RUN_ID,
        deadlineMs: DEADLINE_MS,
      });
      const outcome = await executor.execute(resolved, permitFor(resolved, "Destructive"));

      expect(outcome).toEqual({ status: "ok" });
      expect(companion.executedActions).toHaveLength(1);
      expect(companion.executedActions[0]?.nodeId).toBe("deleteAllButton");
    },
  );

  it.each([["wpf"], ["winui"]] as const)(
    "recovers from a UIA worker hang by restarting and re-capturing (%s)",
    async (technology) => {
      const fixture = loadReferenceAppFixture(technology);
      const companion = new FakeReferenceCompanion(fixture.uiaSource);
      const session = await new AppEnvironmentProvider(companion).launch(fixture.appTarget);

      companion.simulateWorkerHang();
      await expect(captureGraph(companion, session.sessionId)).rejects.toThrow(
        /UiaWorkerUnavailable/,
      );
      expect(companion.workerRestartCount).toBe(1);

      // A retry after the supervisor restarted the worker succeeds.
      const graph = await captureGraph(companion, session.sessionId);
      expect(() => validateObservationGraphV1(graph)).not.toThrow();
    },
  );

  it("feeds the captured Desktop Graph v1 through the LS-08 Skill compiler + replay", async () => {
    const fixture = loadReferenceAppFixture("wpf");
    const companion = new FakeReferenceCompanion(fixture.uiaSource);
    const session = await new AppEnvironmentProvider(companion).launch(fixture.appTarget);
    const graph = await captureGraph(companion, session.sessionId);

    const scope: SkillVerificationScope = {
      projectId: "proj-windows",
      targetId: "windows-reference-wpf",
      origin: "app://windows-reference-wpf",
    };

    const recording: RecordingSession = {
      recordingId: "rec-windows-1",
      projectId: scope.projectId,
      targetId: scope.targetId,
      targetVersion: "2026.08.02",
      observationSchemaEpoch: "v1",
      startedAt: "2026-08-02T00:00:00.000Z",
      completedAt: "2026-08-02T00:01:00.000Z",
      steps: [
        {
          ordinal: 1,
          beforeGraphRef: graph.graphId,
          intent: { kind: "click", target: { role: "button", name: "Submit", purpose: "submit the form" } },
          resolvedNode: {
            role: "button",
            name: "Submit",
            purpose: "submit the form",
            sourceNodeId: "submitButton",
          },
          outcome: { status: "ok" },
          afterGraphRef: `${graph.graphId}#submitted`,
          checkpoint: { requiredClaims: ["form.submitted"], stateFingerprint: "fp-1" },
        },
      ],
      sourceTraceRefs: [session.sessionId],
    };

    const proposal: SkillInductionProposal = {
      parameters: [],
      steps: [
        {
          sourceRecordedStepOrdinal: 1,
          intent: { kind: "click", target: { role: "button", name: "Submit", purpose: "submit the form" } },
          preconditions: [{ kind: "node_present", target: { role: "button", name: "Submit", purpose: "submit the form" } }],
          checkpoint: [{ kind: "claim_satisfied", claimId: "form.submitted" }],
          recovery: "reobserve",
        },
      ],
    };

    const candidate = new SkillCompiler().compile(recording, proposal);
    const skill = TestSkill.draft({
      skillId: "skill-windows-1",
      projectId: scope.projectId,
      targetScope: {
        targetId: scope.targetId,
        allowedOrigins: ["app://windows-reference-wpf"],
      },
    });
    skill.markCandidate({ ...skillCommand(1, "mark-1"), candidate });
    const candidateVersion = skill.snapshot();

    const signer = LocalSkillSigner.generate();
    const bundlePayload = {
      ...candidateVersion,
      contentSha256: bundlePayloadContentSha256(candidateVersion),
    };
    const unsigned: UnsignedSkillBundle = {
      bundleId: "bundle-windows-1",
      skillId: bundlePayload.skillId,
      skillVersion: bundlePayload.version,
      schemaVersion: "skill-bundle/v1",
      compilerVersion: bundlePayload.compilerVersion,
      contentSha256: bundlePayload.contentSha256,
      signerKeyId: signer.keyId,
      signatureAlgorithm: "Ed25519",
      issuedAt: "2026-08-02T00:03:00.000Z",
      payload: bundlePayload,
    };
    const signed = await signer.sign(unsigned);

    const controller = new SkillReplayController({ signer });
    const target = new DesktopReferenceReplayTarget(graph, "Submit", "form.submitted");
    const result = await controller.run(signed, target, scope);

    expect(result).toEqual({ status: "passed" });
  });
});
