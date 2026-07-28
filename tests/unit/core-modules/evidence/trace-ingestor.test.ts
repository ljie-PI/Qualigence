import { describe, expect, it } from "vitest";
import {
  InMemoryTraceStore,
  TraceIngestor,
} from "../../../../packages/core-modules/evidence/src/index.js";

describe("TraceIngestor", () => {
  it("accepts a contiguous trace event and advances the cursor", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());

    const result = await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      payloadHash: "hash-1",
      payload: { graphId: "graph-1" },
    });

    expect(result).toEqual({ status: "accepted", nextSequenceNumber: 2 });
  });

  it("accepts an exact duplicate without advancing incorrectly", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());
    const event = {
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      payloadHash: "hash-1",
      payload: { graphId: "graph-1" },
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
      payloadHash: "hash-1",
      payload: { graphId: "graph-1" },
    });

    const conflict = await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 1,
      stage: "observation",
      payloadHash: "hash-2",
      payload: { graphId: "graph-2" },
    });

    expect(conflict).toEqual({
      status: "integrity_violation",
      code: "TraceIntegrityViolation",
      existingPayloadHash: "hash-1",
    });
  });

  it("rejects a sequence gap with the expected sequence number", async () => {
    const ingestor = new TraceIngestor(new InMemoryTraceStore());

    const result = await ingestor.ingest({
      runId: "run-1",
      sequenceNumber: 2,
      stage: "decision",
      payloadHash: "hash-2",
      payload: { kind: "click" },
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

    await ingestor.ingestFinding({
      findingId: "finding-1",
      runId: "run-1",
      title: "M1 verification passed",
      severity: "info",
      evidenceRefs: [],
    });

    expect(store.findingsFor("run-1")).toEqual([
      {
        findingId: "finding-1",
        runId: "run-1",
        title: "M1 verification passed",
        severity: "info",
        evidenceRefs: [],
      },
    ]);
  });
});
