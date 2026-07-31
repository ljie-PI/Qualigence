// This file is verified by `pnpm typecheck`; Vitest should not execute it.
import type { TraceEvent, TraceEventSubmission } from "@qualigence/runner-protocol";
import type { TraceEventInput } from "@qualigence/runner-kernel";

const observationInput: TraceEventInput = {
  runId: "run-1",
  stage: "observation",
  payload: {
    graphId: "graph-1",
    nodes: [],
  },
};

observationInput satisfies TraceEventInput;

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
  payload: {
    graphId: "graph-1",
    nodes: [],
  },
};
