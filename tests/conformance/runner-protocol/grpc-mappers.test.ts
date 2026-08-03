import { describe, expect, it } from "vitest";
import { capabilities } from "@qualigence/runner-protocol";
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

describe("grpc runner protocol mappers", () => {
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
        target: { kind: "web", url: "https://example.test/" },
        objective: "add the item to the cart",
      },
      requiredCapabilities: ["target:web-playwright"],
      leaseDurationMs: 30_000,
    };
    expect(wireRoundTrip("ExecutionJobOffer", offerToWire, offerFromWire, offer)).toEqual(offer);
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

  it("round-trips an ExecutionEventBatch with trace events", () => {
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
        graphId: "graph-1",
        url: "https://example.test/",
        nodes: [{ id: "node-1", role: "button", name: "Add to cart", confidence: 0.9 }],
      },
    };
    const batch: ExecutionEventBatch = {
      batchId: "batch-1",
      runId: "run-attempt-1",
      firstSequenceNumber: 1,
      events: [event],
    };
    expect(wireRoundTrip("ExecutionEventBatch", eventBatchToWire, eventBatchFromWire, batch)).toEqual(batch);
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
