// This file is verified by `pnpm typecheck`; Vitest should not execute it.
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_TYPE,
  type TraceEvent,
  type TraceEventSubmission,
} from "@qualigence/runner-protocol";
import type { TraceEventInput } from "@qualigence/runner-kernel";

const graphV1 = {
  schema: OBSERVATION_GRAPH_V1_SCHEMA,
  graphId: "graph-1",
  target: { kind: "web", targetId: "https://example.test" },
  capturedAt: "2026-08-24T00:00:00.000Z",
  rootNodeIds: ["root"],
  nodes: [{
    id: "root",
    role: "document",
    name: "Test page",
    state: {},
    relations: [],
    source: { adapterId: "type-test", sourceKind: "fixture" },
    confidence: 1,
    sensitivity: "public",
    extensions: {},
    evidenceRefs: [],
  }],
  evidenceRefs: [],
  extensions: {
    [WEB_EXTENSION_V1_TYPE]: {
      type: WEB_EXTENSION_V1_TYPE,
      version: "1.0",
      payload: {
        origin: "https://example.test",
        pathname: "/",
        title: "Test page",
        viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
        query: {},
      },
    },
  },
} as const;

const observationInput: TraceEventInput = {
  runId: "run-1",
  stage: "observation",
  payload: graphV1,
};

observationInput satisfies TraceEventInput;

const indexedDecisionInput: TraceEventInput = {
  runId: "run-1",
  stepIndex: 0,
  stage: "decision",
  payload: {
    kind: "click",
    target: { nodeId: "node-1" },
    reason: "execute the first immutable plan step",
  },
};

indexedDecisionInput satisfies TraceEventInput;

const completedInput: TraceEventInput = {
  runId: "run-1",
  stage: "run_completed",
  payload: { status: "passed" },
};

completedInput satisfies TraceEventInput;

const incompleteFindingCompletion: TraceEventInput = {
  runId: "run-1",
  stage: "run_completed",
  // @ts-expect-error finding terminal events require a finding id
  payload: { status: "finding" },
};

incompleteFindingCompletion satisfies TraceEventInput;

const criticalVerificationSeverity: TraceEventInput = {
  runId: "run-1",
  stage: "verification",
  // @ts-expect-error model verification severity is limited to low, medium, or high
  payload: {
    status: "failed",
    summary: "critical is reserved for deterministic severity policy",
    severitySuggestion: "critical",
    claims: [
      {
        expected: { graphId: "before", nodeId: "price", text: "$19" },
        observed: { graphId: "after", nodeId: "total", text: "$29" },
      },
    ],
  },
};

criticalVerificationSeverity satisfies TraceEventInput;

const passedVerification: TraceEventInput = {
  runId: "run-1",
  stage: "verification",
  payload: { status: "passed", summary: "objective satisfied", claims: [] },
};

passedVerification satisfies TraceEventInput;

const passedVerificationWithClaims: TraceEventInput = {
  runId: "run-1",
  stage: "verification",
  // @ts-expect-error passed verification cannot carry evidence claims
  payload: {
    status: "passed",
    summary: "contradictory payload",
    claims: [
      {
        expected: { graphId: "before", nodeId: "price", text: "$19" },
        observed: { graphId: "after", nodeId: "total", text: "$29" },
      },
    ],
  },
};

passedVerificationWithClaims satisfies TraceEventInput;

const failedVerificationWithoutClaims: TraceEventInput = {
  runId: "run-1",
  stage: "verification",
  // @ts-expect-error failed verification requires at least one evidence claim
  payload: {
    status: "failed",
    summary: "missing grounded evidence",
    severitySuggestion: "high",
    claims: [],
  },
};

failedVerificationWithoutClaims satisfies TraceEventInput;

const mismatchedInput: TraceEventInput = {
  runId: "run-1",
  stage: "observation",
  payload: {
    // @ts-expect-error observation trace input must not accept a policy payload
    status: "allowed",
    reason: "wrong payload for observation",
  },
};

// @ts-expect-error policy_authorized payload status is narrowed to allowed
const deniedPayloadForAuthorizedEvent: TraceEvent = {
  protocolVersion: "runner-protocol/v1",
  schemaVersion: "trace-event/v1",
  messageId: "message-1",
  idempotencyKey: "idempotency-1",
  runId: "run-1",
  sequenceNumber: 1,
  stage: "policy_authorized",
  occurredAt: "2026-07-30T00:00:00.000Z",
  payloadHash: "hash",
  payload: {
    status: "denied",
    reason: "wrong status for stage",
  },
};

// @ts-expect-error wire submissions must include the sender payload hash
const missingPayloadHash: TraceEventSubmission = {
  protocolVersion: "runner-protocol/v1",
  schemaVersion: "trace-event/v1",
  messageId: "message-1",
  idempotencyKey: "idempotency-1",
  runId: "run-1",
  sequenceNumber: 1,
  stage: "observation",
  occurredAt: "2026-07-30T00:00:00.000Z",
  payload: graphV1,
};
