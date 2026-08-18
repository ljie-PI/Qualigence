// This file is verified by `pnpm typecheck`; Vitest should not execute it.
import type { RunnerProtocolErrorCode } from "@qualigence/grpc-runner-protocol";
import { capabilities, negotiateCapabilities, negotiateProtocolMajor } from "@qualigence/runner-protocol";
import type {
  AcceptedExecutionJob,
  CapabilityMismatch,
  ExecutionEventAck,
  ExecutionEventBatch,
  ExecutionEventBatchOutcome,
  ExecutionJobLease,
  ExecutionJobOffer,
  ExecutionLeaseState,
  ProtocolVersionMismatch,
  ResumeToken,
  RunnerHello,
  RunnerSessionState,
  RunnerWelcome,
} from "@qualigence/runner-protocol";

const hello: RunnerHello = {
  runnerId: "runner-1",
  runnerVersion: "0.1.0",
  supportedProtocolMajors: [1],
  capabilities: capabilities({ targetAdapters: ["web-playwright"] }),
};

hello satisfies RunnerHello;

const resumingHello: RunnerHello = {
  runnerId: "runner-1",
  runnerVersion: "0.1.0",
  supportedProtocolMajors: [1],
  capabilities: capabilities({ targetAdapters: ["web-playwright"] }),
  resumeToken: "resume-secret",
};

resumingHello satisfies RunnerHello;

const welcome: RunnerWelcome = {
  sessionId: "session-1",
  resumeToken: "rotated-secret",
  selectedProtocolMajor: 1,
  serverVersion: "0.1.0",
  heartbeatIntervalMs: 5_000,
  leaseDurationMs: 30_000,
  traceBatchMaximumEvents: 128,
  traceBatchMaximumBytes: 262_144,
  maximumInFlightBatches: 4,
  maximumPendingWriteBytes: 1_048_576,
};

welcome satisfies RunnerWelcome;

// @ts-expect-error the negotiated protocol major is fixed to 1 and cannot be downgraded silently
const downgradedWelcome: RunnerWelcome = { ...welcome, selectedProtocolMajor: 2 };
void downgradedWelcome;

const lease: ExecutionJobLease = {
  jobId: "job-1",
  runId: "run-attempt-1",
  leaseToken: "secret",
  leaseEpoch: 3,
  expiresAt: "2026-08-01T10:00:00.000Z",
};

lease satisfies ExecutionJobLease;

const leaseLost: RunnerProtocolErrorCode = "LeaseLost";
void leaseLost;

const offer: ExecutionJobOffer = {
  offerId: "offer-1",
  job: {
    jobId: "job-1",
    runId: "run-attempt-1",
    projectId: "project-1",
    target: { kind: "web", url: "https://example.test/" },
    objective: "add the item to the cart",
    policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
  },
  requiredCapabilities: ["target:web-playwright", "action:click"],
  leaseDurationMs: 30_000,
};

offer satisfies ExecutionJobOffer;

// Task 15 freezes policy as a required Job snapshot. This is intentionally RED
// until the protocol contract adds the required field.
const policylessJob = {
  jobId: "job-policyless",
  runId: "run-policyless",
  target: { kind: "web", url: "https://example.test/" },
  objective: "must not dispatch without policy",
};
// @ts-expect-error AcceptedExecutionJob must reject a policyless value
const typedPolicylessJob: AcceptedExecutionJob = policylessJob;
void typedPolicylessJob;

const projectlessJob = {
  jobId: "job-projectless",
  runId: "run-projectless",
  target: { kind: "web" as const, url: "https://example.test/" },
  objective: "must not dispatch without project provenance",
  policy: offer.job.policy,
};
// @ts-expect-error AcceptedExecutionJob must reject a projectless value
const typedProjectlessJob: AcceptedExecutionJob = projectlessJob;
void typedProjectlessJob;

const batch: ExecutionEventBatch = {
  batchId: "batch-1",
  runId: "run-attempt-1",
  firstSequenceNumber: 1,
  events: [],
};

batch satisfies ExecutionEventBatch;

const ack: ExecutionEventAck = {
  batchId: "batch-1",
  runId: "run-attempt-1",
  nextExpectedSequenceNumber: 2,
};

ack satisfies ExecutionEventAck;

// Batch outcomes never silently accept an out-of-order or tampered batch.
const acknowledged: ExecutionEventBatchOutcome = { outcome: "acknowledged", ack };
const gap: ExecutionEventBatchOutcome = {
  outcome: "gap",
  runId: "run-attempt-1",
  nextExpectedSequenceNumber: 5,
};
const integrityViolation: ExecutionEventBatchOutcome = {
  outcome: "integrity_violation",
  runId: "run-attempt-1",
  sequenceNumber: 5,
  code: "TraceIntegrityViolation",
};

function describeBatchOutcome(result: ExecutionEventBatchOutcome): number {
  switch (result.outcome) {
    case "acknowledged":
      return result.ack.nextExpectedSequenceNumber;
    case "gap":
      return result.nextExpectedSequenceNumber;
    case "integrity_violation":
      return result.sequenceNumber;
    default:
      return assertNever(result);
  }
}

void describeBatchOutcome(acknowledged);
void describeBatchOutcome(gap);
void describeBatchOutcome(integrityViolation);

// Session state is a closed set; illegal shapes are unrepresentable.
const sessionStates: readonly RunnerSessionState[] = [
  { status: "connecting", hello },
  { status: "established", welcome },
  { status: "resuming", previousSessionId: "session-0", resumeToken: "carry" satisfies ResumeToken },
  { status: "closed", reason: "protocol_version_mismatch" },
];

function describeSession(state: RunnerSessionState): string {
  switch (state.status) {
    case "connecting":
      return state.hello.runnerId;
    case "established":
      return state.welcome.sessionId;
    case "resuming":
      return state.previousSessionId;
    case "closed":
      return state.reason;
    default:
      return assertNever(state);
  }
}

for (const state of sessionStates) {
  void describeSession(state);
}

// @ts-expect-error an established session must carry the negotiated welcome
const establishedWithoutWelcome: RunnerSessionState = { status: "established" };
void establishedWithoutWelcome;

// @ts-expect-error unknown session status is not representable
const unknownSession: RunnerSessionState = { status: "paused" };
void unknownSession;

// Lease lifecycle is exhaustive; a held lease cannot exist without its token bundle.
const leaseStates: readonly ExecutionLeaseState[] = [
  { status: "offered", offer },
  { status: "held", lease },
  { status: "renewed", lease },
  {
    status: "completed",
    jobId: "job-1",
    runId: "run-attempt-1",
    completion: { jobId: "job-1", runId: "run-attempt-1", status: "passed" },
  },
  { status: "lost", jobId: "job-1", runId: "run-attempt-1", leaseEpoch: 3, reason: "expired" },
];

function describeLease(state: ExecutionLeaseState): string {
  switch (state.status) {
    case "offered":
      return state.offer.offerId;
    case "held":
    case "renewed":
      return state.lease.leaseToken;
    case "completed":
      return state.completion.status;
    case "lost":
      return state.reason;
    default:
      return assertNever(state);
  }
}

for (const state of leaseStates) {
  void describeLease(state);
}

// @ts-expect-error a held lease must carry the lease bundle
const heldWithoutLease: ExecutionLeaseState = { status: "held" };
void heldWithoutLease;

// Protocol negotiation exposes an explicit rejection instead of a silent fallback.
const selectedNegotiation = negotiateProtocolMajor([1]);
if (selectedNegotiation.outcome === "selected") {
  const selected: 1 = selectedNegotiation.selectedProtocolMajor;
  void selected;
}

const rejectedNegotiation = negotiateProtocolMajor([2]);
if (rejectedNegotiation.outcome === "rejected") {
  const rejection: ProtocolVersionMismatch = rejectedNegotiation.rejection;
  void rejection;
}

// A downgraded fallback rejection is impossible: the mismatch code is a fixed literal.
const downgradedMismatch: ProtocolVersionMismatch = {
  // @ts-expect-error the mismatch code is a fixed literal, a downgraded fallback is impossible
  code: "Downgraded",
  offeredProtocolMajors: [2],
  supportedProtocolMajors: [1],
};
void downgradedMismatch;

const capabilityNegotiation = negotiateCapabilities(
  capabilities({ targetAdapters: ["web-playwright"] }),
  ["target:web-playwright"],
);
if (capabilityNegotiation.outcome === "rejected") {
  const mismatch: CapabilityMismatch = capabilityNegotiation.rejection;
  void mismatch;
}

function assertNever(value: never): never {
  throw new Error(`unexpected variant: ${String(value)}`);
}
