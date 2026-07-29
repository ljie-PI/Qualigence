import { describe, expect, it } from "vitest";
import {
  InMemoryTraceStore,
  TraceIngestor,
} from "@qualigence/evidence";

describe("TraceIngestor", () => {
  it("accepts a contiguous trace event and advances the cursor", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());

    const result = await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      messageId: "message-1",
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      idempotencyKey: "idem-1",
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload: { graphId: "graph-1", nodes: [] },
    });

    expect(result).toEqual({ status: "accepted", nextSequenceNumber: 2 });
  });

  it("accepts an exact duplicate without advancing incorrectly", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());
    const event = {
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      messageId: "message-1",
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      idempotencyKey: "idem-1",
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload: { graphId: "graph-1", nodes: [] },
    } as const;

    await ingestor.ingest(event);
    const duplicate = await ingestor.ingest(event);

    expect(duplicate).toEqual({ status: "duplicate", nextSequenceNumber: 2 });
  });

  it("rejects a conflicting duplicate at the same sequence number", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());

    await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      messageId: "message-1",
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      idempotencyKey: "idem-1",
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload: { graphId: "graph-1", nodes: [] },
    });

    const conflict = await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      messageId: "message-2",
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      idempotencyKey: "idem-2",
      occurredAt: "2026-07-30T00:00:01.000Z",
      payload: { graphId: "graph-2", nodes: [] },
    });

    expect(conflict.status).toBe("integrity_violation");
    if (conflict.status !== "integrity_violation") {
      throw new Error(`Expected integrity_violation, got ${conflict.status}`);
    }
    expect(conflict.code).toBe("TraceIntegrityViolation");
  });

  it("rejects an event when the declared hash does not match the payload", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());

    const result = await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      messageId: "message-1",
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      idempotencyKey: "idem-1",
      occurredAt: "2026-07-30T00:00:00.000Z",
      payloadHash: "sender-controlled-hash",
      payload: { graphId: "graph-1", nodes: [] },
    });

    expect(result.status).toBe("hash_mismatch");
    if (result.status !== "hash_mismatch") {
      throw new Error(`Expected hash_mismatch, got ${result.status}`);
    }
    expect(result.code).toBe("PayloadHashMismatch");
    expect(result.declaredPayloadHash).toBe("sender-controlled-hash");
  });

  it("does not accept two concurrent writes for the same sequence number", async () => {
    const store = new InMemoryTraceStore();
    const ingestor = new TraceIngestor(store);

    const results = await Promise.all([
      ingestor.ingest({
        runId: "run-1",
        sequenceNumber: 1,
        stage: "observation",
        messageId: "message-1",
        protocolVersion: "runner-protocol/v1",
        schemaVersion: "trace-event/v1",
        idempotencyKey: "idem-1",
        occurredAt: "2026-07-30T00:00:00.000Z",
        payload: { graphId: "graph-1", nodes: [] },
      }),
      ingestor.ingest({
        runId: "run-1",
        sequenceNumber: 1,
        stage: "observation",
        messageId: "message-2",
        protocolVersion: "runner-protocol/v1",
        schemaVersion: "trace-event/v1",
        idempotencyKey: "idem-2",
        occurredAt: "2026-07-30T00:00:01.000Z",
        payload: { graphId: "graph-2", nodes: [] },
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "accepted",
      "integrity_violation",
    ]);
    expect(store.eventsFor("run-1")).toHaveLength(1);
  });

  it("rejects a sequence gap with the expected sequence number", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());

    const result = await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 2,
      stage: "decision",
      messageId: "message-2",
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      idempotencyKey: "idem-2",
      occurredAt: "2026-07-30T00:00:01.000Z",
      payload: {
        kind: "click",
        target: { nodeId: "node-login" },
        reason: "exercise first web action",
      },
    });

    expect(result).toEqual({
      status: "sequence_gap",
      code: "SequenceGap",
      expectedSequenceNumber: 1,
    });
  });

  it("stores a finding envelope after trace verification", async () => {
    const store = new InMemoryTraceStore();
    const ingestor = new TraceIngestor(store);

    const result = await ingestor.ingestFinding({
      findingId: "finding-1",
      runId: "run-1",
      title: "M1 verification passed",
      summary: "login transition observed",
      severity: "info",
      evidenceRefs: [],
    });

    expect(result).toEqual({ status: "accepted" });
    expect(store.findingsFor("run-1")).toEqual([
      {
        findingId: "finding-1",
        runId: "run-1",
        title: "M1 verification passed",
        summary: "login transition observed",
        severity: "info",
        evidenceRefs: [],
      },
    ]);
  });

  it("deduplicates matching finding envelopes by finding id", async () => {
    const store = new InMemoryTraceStore();
    const ingestor = new TraceIngestor(store);
    const finding = {
      findingId: "finding-1",
      runId: "run-1",
      title: "M1 verification passed",
      summary: "login transition observed",
      severity: "info",
      evidenceRefs: [],
    } as const;

    await ingestor.ingestFinding(finding);
    const duplicate = await ingestor.ingestFinding(finding);

    expect(duplicate).toEqual({ status: "duplicate" });
    expect(store.findingsFor("run-1")).toHaveLength(1);
  });

  it("rejects conflicting finding envelopes with the same finding id", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());

    await ingestor.ingestFinding({
      findingId: "finding-1",
      runId: "run-1",
      title: "M1 verification passed",
      summary: "login transition observed",
      severity: "info",
      evidenceRefs: [],
    });

    const conflict = await ingestor.ingestFinding({
      findingId: "finding-1",
      runId: "run-1",
      title: "Different finding",
      summary: "conflicting content",
      severity: "medium",
      evidenceRefs: [],
    });

    expect(conflict.status).toBe("integrity_violation");
    if (conflict.status !== "integrity_violation") {
      throw new Error(`Expected integrity_violation, got ${conflict.status}`);
    }
    expect(conflict.code).toBe("FindingIntegrityViolation");
  });
});
