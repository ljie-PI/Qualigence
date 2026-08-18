import { describe, expect, it } from "vitest";
import { InMemoryTraceStore, TraceIngestor } from "@qualigence/evidence";
import type {
  ExecutionEventBatch,
  RunnerHello,
  TraceEvent,
} from "@qualigence/runner-protocol";
import { canonicalTraceEventHash, capabilities } from "@qualigence/runner-protocol";
import type { AuthenticatedRunnerContext } from "@qualigence/runner-control";
import { InMemoryRunnerControlStore } from "../../helpers/in-memory-runner-control-store.js";
import {
  RunnerResumeTokenService,
  RunnerSessionService,
  RunOwnershipService,
} from "@qualigence/core-application";

const identity1: AuthenticatedRunnerContext = {
  runnerId: "runner-1",
  certificateFingerprint: "fp-1",
  scope: { kind: "local" },
};
const identity2: AuthenticatedRunnerContext = {
  runnerId: "runner-2",
  certificateFingerprint: "fp-2",
  scope: { kind: "local" },
};

const welcome = {
  serverVersion: "0.1.0",
  heartbeatIntervalMs: 5_000,
  leaseDurationMs: 30_000,
  traceBatchMaximumEvents: 128,
  traceBatchMaximumBytes: 262_144,
  maximumInFlightBatches: 2,
  maximumPendingWriteBytes: 1_048_576,
} as const;

function hello(runnerId: string, overrides: Partial<RunnerHello> = {}): RunnerHello {
  return {
    runnerId,
    runnerVersion: "0.1.0",
    supportedProtocolMajors: [1],
    capabilities: capabilities({ targetAdapters: ["web-playwright"] }),
    ...overrides,
  };
}

function observationEvent(runId: string, sequenceNumber: number, graphId = `graph-${sequenceNumber}`): TraceEvent {
  const base = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `${runId}:${sequenceNumber}`,
    idempotencyKey: `${runId}:${sequenceNumber}`,
    runId,
    sequenceNumber,
    stage: "observation",
    occurredAt: "2026-08-01T00:00:00.000Z",
    payload: { graphId, nodes: [] },
  } as const;
  return { ...base, payloadHash: canonicalTraceEventHash(base) } as TraceEvent;
}

function batch(runId: string, first: number, events: TraceEvent[]): ExecutionEventBatch {
  return { batchId: `batch-${first}`, runId, firstSequenceNumber: first, events };
}

function makeService(ownership?: RunOwnershipService): { service: RunnerSessionService; store: InMemoryTraceStore } {
  const store = new InMemoryTraceStore();
  const controlStore = new InMemoryRunnerControlStore();
  const service = new RunnerSessionService({
    store: controlStore,
    welcome,
    resumeTokens: new RunnerResumeTokenService({ store: controlStore }),
    traceIngestor: new TraceIngestor(store),
    ...(ownership === undefined ? {} : { ownership }),
  });
  return { service, store };
}

describe("RunnerSessionService", () => {
  it("registers a runner and rotates a fresh resume token per handshake", async () => {
    const { service } = makeService();
    const w1 = await service.register(hello("runner-1"), identity1);
    expect(w1.selectedProtocolMajor).toBe(1);
    expect(w1.resumeToken).toBeTruthy();

    const w2 = await service.register(hello("runner-1"), identity1);
    expect(w2.resumeToken).not.toBe(w1.resumeToken);
    expect(w2.sessionId).not.toBe(w1.sessionId);
  });

  it("keeps the same session id across a successful resume", async () => {
    const { service } = makeService();
    const first = await service.register(hello("runner-1"), identity1);
    const resumed = await service.register(hello("runner-1", { resumeToken: first.resumeToken }), identity1);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.resumeToken).not.toBe(first.resumeToken);
  });

  it("removes only protocol session state on close", async () => {
    const { service } = makeService();
    const first = await service.register(hello("runner-1"), identity1);
    await service.closeSession(first.sessionId);
    expect(service.session(first.sessionId)).toBeUndefined();
  });

  it("rejects a hello with no shared protocol major", async () => {
    const { service } = makeService();
    await expect(service.register(hello("runner-1", { supportedProtocolMajors: [2] }), identity1)).rejects.toMatchObject({
      code: "ProtocolVersionMismatch",
    });
  });

  it("rejects an unknown resume token", async () => {
    const { service } = makeService();
    await expect(service.register(hello("runner-1", { resumeToken: "bogus" }), identity1)).rejects.toMatchObject({
      code: "RunnerResumeRejected",
    });
  });

  it("ingests trace batches and persists every accepted event", async () => {
    const { service, store } = makeService();
    const w = await service.register(hello("runner-1"), identity1);
    const ack = await service.ingest(w.sessionId, batch("run-1", 1, [
      observationEvent("run-1", 1),
      observationEvent("run-1", 2),
    ]));
    expect(ack.nextExpectedSequenceNumber).toBe(3);
    expect(store.eventsFor("run-1")).toHaveLength(2);
  });

  it("returns the same ack for a duplicate batch", async () => {
    const { service } = makeService();
    const w = await service.register(hello("runner-1"), identity1);
    const events = [observationEvent("run-1", 1), observationEvent("run-1", 2)];
    const first = await service.ingest(w.sessionId, batch("run-1", 1, events));
    const second = await service.ingest(w.sessionId, batch("run-1", 1, events));
    expect(second.nextExpectedSequenceNumber).toBe(first.nextExpectedSequenceNumber);
  });

  it("quarantines a session on a same-sequence, different-hash conflict", async () => {
    const { service } = makeService();
    const w = await service.register(hello("runner-1"), identity1);
    await service.ingest(w.sessionId, batch("run-1", 1, [observationEvent("run-1", 1)]));
    // Re-submit sequence 1 with a different payload/hash.
    await expect(
      service.ingest(w.sessionId, batch("run-1", 1, [observationEvent("run-1", 1, "graph-tampered")])),
    ).rejects.toMatchObject({ code: "TraceIntegrityViolation" });
  });

  it("rejects a trace upload from a runner that does not own the run", async () => {
    const ownership = new RunOwnershipService({ store: new InMemoryRunnerControlStore(), integrityEvents: { emit: () => undefined } });
    await ownership.grant(
      { jobId: "job-1", runId: "run-1", target: { kind: "web", url: "https://example.test/" }, objective: "cart", policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" } },
      { runnerId: "runner-1", sessionId: "session-1" },
    );
    const { service } = makeService(ownership);
    const w = await service.register(hello("runner-2"), identity2);
    await expect(
      service.ingest(w.sessionId, batch("run-1", 1, [observationEvent("run-1", 1)])),
    ).rejects.toMatchObject({ code: "RunOwnershipViolation" });
  });
});
