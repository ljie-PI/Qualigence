import { describe, expect, it } from "vitest";
import {
  DESKTOP_UIA_V1_CAPABILITY_TOKENS,
  OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN,
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_TYPE,
  WEB_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN,
  capabilities,
} from "@qualigence/runner-protocol";
import type {
  ExecutionEventAck,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  RunnerHello,
  RunnerWelcome,
  TraceEvent,
} from "@qualigence/runner-protocol";
import {
  decodeWireMessage,
  encodeWireMessage,
  eventAckFromWire,
  eventAckToWire,
  eventBatchFromWire,
  eventBatchToWire,
  helloFromWire,
  helloToWire,
  leaseFromWire,
  leaseToWire,
  offerFromWire,
  offerToWire,
  jobFromWire,
  renewLeaseFromWire,
  renewLeaseToWire,
  welcomeFromWire,
  welcomeToWire,
} from "@qualigence/grpc-runner-protocol";
import type { RunnerWireMessageName } from "@qualigence/grpc-runner-protocol";

function wireRoundTrip<TDomain>(
  name: RunnerWireMessageName,
  toWire: (domain: TDomain) => object,
  fromWire: (wire: Record<string, unknown>) => TDomain,
  domain: TDomain,
): TDomain {
  const wire = toWire(domain);
  const bytes = encodeWireMessage(name, wire);
  const decoded = decodeWireMessage(name, bytes);
  return fromWire(decoded);
}

const desktopAppTarget = {
  targetId: "wpf-reference",
  platform: "windows",
  launch: {
    executable: "C:\\Apps\\Reference\\Reference.exe",
    args: ["--fixture", "default", "ref:credentials/test-user"],
    workingDirectory: "C:\\Apps\\Reference",
  },
  process: {
    expectedImageName: "Reference.exe",
    allowedChildImageNames: ["ReferenceHelper.exe"],
  },
  window: { titlePattern: "Reference App", automationId: "MainWindow" },
  reset: { command: "C:\\Apps\\Reference\\Reset.exe", args: ["--clean"], timeoutMs: 5000 },
  shutdown: { gracefulTimeoutMs: 3000, forceAfterTimeout: false },
} as const;

function wireDesktopAppTarget() {
  return {
    target_id: "wpf-reference",
    platform: "windows",
    launch: {
      executable: "C:\\Apps\\Reference\\Reference.exe",
      args: ["--fixture", "default", "ref:credentials/test-user"],
      working_directory: "C:\\Apps\\Reference",
    },
    process: {
      expected_image_name: "Reference.exe",
      allowed_child_image_names: ["ReferenceHelper.exe"],
    },
    window: { title_pattern: "Reference App", automation_id: "MainWindow" },
    reset: { command: "C:\\Apps\\Reference\\Reset.exe", args: ["--clean"], timeout_ms: 5000 },
    shutdown: { graceful_timeout_ms: 3000, force_after_timeout: false },
  };
}

function graphV1(graphId: string) {
  return {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId,
    target: { kind: "web", targetId: "https://example.test" },
    capturedAt: "2026-08-01T00:00:00.000Z",
    rootNodeIds: ["node-1"],
    nodes: [
      {
        id: "node-1",
        role: "button",
        name: "Add to cart",
        state: { disabled: false },
        relations: [],
        source: { adapterId: "web-playwright", sourceKind: "dom" },
        confidence: 0.9,
        sensitivity: "public",
        extensions: {},
        evidenceRefs: [],
      },
    ],
    evidenceRefs: [],
    extensions: {
      [WEB_EXTENSION_V1_TYPE]: {
        type: WEB_EXTENSION_V1_TYPE,
        version: "1.0",
        payload: {
          origin: "https://example.test",
          pathname: "/",
          title: "Example",
          viewport: { width: 1024, height: 768, devicePixelRatio: 1 },
          query: {},
        },
      },
    },
  } as const;
}

describe("grpc runner protocol mappers", () => {
  it("rejects a network Job that omits the required policy snapshot", () => {
    expect(() =>
      jobFromWire({
        job_id: "job-policyless",
        run_id: "run-policyless",
        target: { web: { url: "https://example.test/" } },
        objective: "must not dispatch",
      }),
    ).toThrow(expect.objectContaining({ code: "PolicyMissing" }));
  });

  it("rejects a network Job that omits immutable project provenance", () => {
    expect(() =>
      jobFromWire({
        job_id: "job-projectless",
        run_id: "run-projectless",
        target: { web: { url: "https://example.test/" } },
        objective: "must not dispatch",
        policy: {
          policy_id: "policy-1", environment: "isolated_test", allowed_origins: ["https://example.test"],
          allowed_action_kinds: ["click"], maximum_risk: "Normal", exploration_allowed: false,
          issued_at: "2026-08-18T00:00:00.000Z", expires_at: "2026-08-18T00:01:00.000Z",
        },
      }),
    ).toThrow(expect.objectContaining({ code: "PolicyMissing" }));
  });

  it.each([
    ["invalid expiry", { expires_at: "not-an-instant" }],
    ["inverted policy interval", { issued_at: "2026-08-18T00:01:00.000Z", expires_at: "2026-08-18T00:00:00.000Z" }],
    ["unknown environment", { environment: "preview" }],
    ["unknown action", { allowed_action_kinds: ["teleport"] }],
    ["staging exploration", { environment: "staging", exploration_allowed: true }],
  ])("rejects a wire Job with %s as PolicyMissing", (_name, policyOverride) => {
    expect(() => jobFromWire({
      job_id: "job-1",
      run_id: "run-1",
      target: { web: { url: "https://example.test/" } },
      objective: "must not dispatch",
      policy: {
        policy_id: "policy-1",
        environment: "isolated_test",
        allowed_origins: ["https://example.test"],
        allowed_action_kinds: ["click"],
        maximum_risk: "Normal",
        exploration_allowed: false,
        issued_at: "2026-08-18T00:00:00.000Z",
        expires_at: "2026-08-18T00:01:00.000Z",
        ...policyOverride,
      },
    })).toThrow(expect.objectContaining({ code: "PolicyMissing" }));
  });

  it("round-trips RunnerHello through the protobuf wire", () => {
    const hello: RunnerHello = {
      runnerId: "runner-1",
      runnerVersion: "0.1.0",
      supportedProtocolMajors: [1],
      capabilities: capabilities({
        targetAdapters: ["web-playwright"],
        observationExtensions: ["dom"],
        actionKinds: ["click", "type"],
        model: { structuredOutput: true, visionInput: true },
      }),
      resumeToken: "resume-secret",
    };
    expect(wireRoundTrip("RunnerHello", helloToWire, helloFromWire, hello)).toEqual(hello);
  });

  it("round-trips a RunnerHello without a resume token", () => {
    const hello: RunnerHello = {
      runnerId: "runner-1",
      runnerVersion: "0.1.0",
      supportedProtocolMajors: [1],
      capabilities: capabilities({ targetAdapters: ["web-playwright"] }),
    };
    const back = wireRoundTrip("RunnerHello", helloToWire, helloFromWire, hello);
    expect(back).toEqual(hello);
    expect("resumeToken" in back).toBe(false);
  });

  it("round-trips RunnerWelcome through the protobuf wire", () => {
    const welcome: RunnerWelcome = {
      sessionId: "session-1",
      resumeToken: "rotated",
      selectedProtocolMajor: 1,
      serverVersion: "0.1.0",
      heartbeatIntervalMs: 5_000,
      leaseDurationMs: 30_000,
      traceBatchMaximumEvents: 128,
      traceBatchMaximumBytes: 262_144,
      maximumInFlightBatches: 4,
      maximumPendingWriteBytes: 1_048_576,
    };
    expect(wireRoundTrip("RunnerWelcome", welcomeToWire, welcomeFromWire, welcome)).toEqual(welcome);
  });

  it("round-trips ExecutionJobOffer through the protobuf wire", () => {
    const offer: ExecutionJobOffer = {
      offerId: "offer-1",
      job: {
        jobId: "job-1",
        runId: "run-attempt-1",
        projectId: "project-1",
        target: { kind: "web", url: "https://example.test/" },
        objective: "add the item to the cart",
        policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["navigate", "click", "input", "select", "scroll"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
        plan: {
          missionId: "mission-1",
          missionRevision: 2,
          testCaseId: "case-1",
          steps: [
            { stepIndex: 0, kind: "navigate", path: "/cart" },
            { stepIndex: 1, kind: "click", target: { role: "button", name: "Add", purpose: "add item" } },
            { stepIndex: 2, kind: "input", target: { role: "textbox", purpose: "enter email" }, valueRef: "customer.email" },
            { stepIndex: 3, kind: "select", target: { role: "combobox", purpose: "choose country" }, valueRef: "customer.country" },
            { stepIndex: 4, kind: "scroll", target: { purpose: "review order" }, direction: "down", amount: "small" },
            { stepIndex: 5, kind: "verify", claimIds: ["claim-1"] },
          ],
          expectedClaimIds: ["claim-1"],
          budget: { maximumStepsPerJob: 6, maximumWallClockMs: 30_000, maximumModelTokens: 1_000 },
        },
      },
      requiredCapabilities: [
        "target:web-playwright",
        OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN,
        WEB_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN,
      ],
      leaseDurationMs: 30_000,
    };
    expect(wireRoundTrip("ExecutionJobOffer", offerToWire, offerFromWire, offer)).toEqual(offer);
  });

  it("round-trips a Desktop TargetRef through structured protobuf fields", () => {
    const offer: ExecutionJobOffer = {
      offerId: "offer-desktop",
      job: {
        jobId: "job-desktop",
        runId: "run-desktop",
        projectId: "project-1",
        target: { kind: "desktop", app: desktopAppTarget },
        objective: "drive the WPF reference app",
        policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click", "input", "select", "scroll", "window"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
      },
      requiredCapabilities: [...DESKTOP_UIA_V1_CAPABILITY_TOKENS, "action:click"],
      leaseDurationMs: 30_000,
    };

    const wire = offerToWire(offer);
    expect(wire).toMatchObject({
      job: {
        target: {
          desktop: {
            app: {
              target_id: "wpf-reference",
              platform: "windows",
              launch: { executable: "C:\\Apps\\Reference\\Reference.exe", args: ["--fixture", "default", "ref:credentials/test-user"], working_directory: "C:\\Apps\\Reference" },
              process: { expected_image_name: "Reference.exe", allowed_child_image_names: ["ReferenceHelper.exe"] },
              window: { title_pattern: "Reference App", automation_id: "MainWindow" },
              reset: { command: "C:\\Apps\\Reference\\Reset.exe", args: ["--clean"], timeout_ms: 5000 },
              shutdown: { graceful_timeout_ms: 3000, force_after_timeout: false },
            },
          },
        },
      },
    });
    expect(wireRoundTrip("ExecutionJobOffer", offerToWire, offerFromWire, offer)).toEqual(offer);
  });

  it.each([
    ["missing kind", {}],
    ["unknown kind", { target: "mobile" }],
    ["multiple oneof payloads", { web: { url: "https://example.test/" }, desktop: { app: {} } }],
    ["desktop app missing required fields", { desktop: { app: { target_id: "wpf-reference" } } }],
    ["desktop app missing reset timeout", { desktop: { app: { ...wireDesktopAppTarget(), reset: { command: "C:\\Apps\\Reference\\Reset.exe", args: [] } } } }],
    ["desktop app missing explicit shutdown decision", { desktop: { app: { ...wireDesktopAppTarget(), shutdown: { graceful_timeout_ms: 3000 } } } }],
    ["desktop launch args is not an array", { desktop: { app: { ...wireDesktopAppTarget(), launch: { ...wireDesktopAppTarget().launch, args: "--fixture default" } } } }],
    ["desktop process child images is not an array", { desktop: { app: { ...wireDesktopAppTarget(), process: { ...wireDesktopAppTarget().process, allowed_child_image_names: "ReferenceHelper.exe" } } } }],
    ["desktop reset args is not an array", { desktop: { app: { ...wireDesktopAppTarget(), reset: { ...wireDesktopAppTarget().reset, args: "--clean" } } } }],
    ["desktop reset timeout is not a number", { desktop: { app: { ...wireDesktopAppTarget(), reset: { ...wireDesktopAppTarget().reset, timeout_ms: "5000" } } } }],
    ["desktop shutdown force flag is not a boolean", { desktop: { app: { ...wireDesktopAppTarget(), shutdown: { ...wireDesktopAppTarget().shutdown, force_after_timeout: "false" } } } }],
    ["desktop optional window scalar is malformed", { desktop: { app: { ...wireDesktopAppTarget(), window: { ...wireDesktopAppTarget().window, title_pattern: 42 } } } }],
  ])("rejects malformed TargetRef wire before producing a Job: %s", (_name, target) => {
    expect(() => jobFromWire({
      job_id: "job-bad-target",
      run_id: "run-bad-target",
      project_id: "project-1",
      target,
      objective: "must not dispatch",
      policy: {
        policy_id: "policy-1", environment: "isolated_test", allowed_origins: ["https://example.test"],
        allowed_action_kinds: ["click"], maximum_risk: "Normal", exploration_allowed: false,
        issued_at: "2026-08-18T00:00:00.000Z", expires_at: "2026-08-18T00:01:00.000Z",
      },
    })).toThrow(expect.objectContaining({ code: "ProtocolViolation" }));
  });

  it("rejects a Desktop offer whose capability requirements omit Desktop/Graph/UIA tokens", () => {
    const offer: ExecutionJobOffer = {
      offerId: "offer-desktop-missing-cap",
      job: {
        jobId: "job-desktop",
        runId: "run-desktop",
        projectId: "project-1",
        target: { kind: "desktop", app: desktopAppTarget },
        objective: "drive the WPF reference app",
        policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
      },
      requiredCapabilities: ["action:click"],
      leaseDurationMs: 30_000,
    };

    expect(() => offerToWire(offer)).toThrow(expect.objectContaining({
      code: "CapabilityMismatch",
      details: { missingCapabilities: [...DESKTOP_UIA_V1_CAPABILITY_TOKENS] },
    }));
  });

  it("round-trips ExecutionJobLease through the protobuf wire", () => {
    const lease: ExecutionJobLease = {
      jobId: "job-1",
      runId: "run-attempt-1",
      leaseToken: "lease-secret",
      leaseEpoch: 3,
      expiresAt: "2026-08-01T10:00:00.000Z",
    };
    expect(wireRoundTrip("ExecutionJobLease", leaseToWire, leaseFromWire, lease)).toEqual(lease);
  });

  it("round-trips the exact lease token in RenewLease", () => {
    const lease: ExecutionJobLease = {
      jobId: "job-1",
      runId: "run-attempt-1",
      leaseToken: "lease-secret",
      leaseEpoch: 3,
      expiresAt: "2026-08-01T10:00:00.000Z",
    };
    const back = wireRoundTrip("RenewLease", renewLeaseToWire, renewLeaseFromWire, lease);
    expect(back.jobId).toBe(lease.jobId);
    expect(back.runId).toBe(lease.runId);
    expect(back.leaseEpoch).toBe(lease.leaseEpoch);
    expect(back.leaseToken).toBe(lease.leaseToken);
  });

  it("round-trips an ExecutionEventBatch with Graph v1 trace events", () => {
    const event: TraceEvent = {
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      messageId: "run-attempt-1:1",
      idempotencyKey: "run-attempt-1:1",
      runId: "run-attempt-1",
      sequenceNumber: 1,
      stepIndex: 2,
      stage: "observation",
      occurredAt: "2026-08-01T00:00:00.000Z",
      payloadHash: "0".repeat(64),
      payload: graphV1("graph-1") as never,
    };
    const batch: ExecutionEventBatch = {
      batchId: "batch-1",
      runId: "run-attempt-1",
      firstSequenceNumber: 1,
      events: [event],
    };
    expect(wireRoundTrip("ExecutionEventBatch", eventBatchToWire, eventBatchFromWire, batch)).toEqual(batch);
  });

  it("rejects an observation Trace payload with an incompatible graph major", () => {
    const event: TraceEvent = {
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      messageId: "run-attempt-1:1",
      idempotencyKey: "run-attempt-1:1",
      runId: "run-attempt-1",
      sequenceNumber: 1,
      stage: "observation",
      occurredAt: "2026-08-01T00:00:00.000Z",
      payloadHash: "0".repeat(64),
      payload: {
        ...graphV1("graph-unsupported"),
        schema: { epoch: "v1", version: "observation-graph/v2" },
      } as never,
    };

    expect(() => eventBatchToWire({
      batchId: "batch-bad-graph",
      runId: "run-attempt-1",
      firstSequenceNumber: 1,
      events: [event],
    })).toThrow(expect.objectContaining({ code: "ProtocolViolation" }));
  });

  it("rejects a web observation Trace payload without a compatible web/v1 extension", () => {
    const event: TraceEvent = {
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      messageId: "run-attempt-1:1",
      idempotencyKey: "run-attempt-1:1",
      runId: "run-attempt-1",
      sequenceNumber: 1,
      stage: "observation",
      occurredAt: "2026-08-01T00:00:00.000Z",
      payloadHash: "0".repeat(64),
      payload: {
        ...graphV1("graph-missing-web"),
        extensions: {},
      } as never,
    };

    expect(() => eventBatchToWire({
      batchId: "batch-missing-web",
      runId: "run-attempt-1",
      firstSequenceNumber: 1,
      events: [event],
    })).toThrow(expect.objectContaining({ code: "ProtocolViolation" }));
  });

  it("does not materialize a step index on legacy Trace events", () => {
    const event: TraceEvent = {
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      messageId: "run-attempt-1:legacy",
      idempotencyKey: "run-attempt-1:legacy",
      runId: "run-attempt-1",
      sequenceNumber: 1,
      stage: "run_completed",
      occurredAt: "2026-08-01T00:00:00.000Z",
      payloadHash: "0".repeat(64),
      payload: { status: "passed" },
    };
    const batch: ExecutionEventBatch = {
      batchId: "batch-legacy",
      runId: "run-attempt-1",
      firstSequenceNumber: 1,
      events: [event],
    };

    const back = wireRoundTrip("ExecutionEventBatch", eventBatchToWire, eventBatchFromWire, batch);
    expect(back).toEqual(batch);
    expect("stepIndex" in back.events[0]!).toBe(false);
  });

  it("round-trips ExecutionEventAck through the protobuf wire", () => {
    const ack: ExecutionEventAck = {
      batchId: "batch-1",
      runId: "run-attempt-1",
      nextExpectedSequenceNumber: 2,
    };
    expect(wireRoundTrip("ExecutionEventAck", eventAckToWire, eventAckFromWire, ack)).toEqual(ack);
  });
});
