import type { TraceIngestor } from "@qualigence/evidence";
import {
  canonicalPayloadHash,
  type FindingEnvelope,
  type TraceEvent,
  type TraceEventSubmission,
} from "@qualigence/runner-protocol";
import type { TraceEventInput, TraceRecorder } from "@qualigence/runner-kernel";

export class InMemoryProtocolTraceRecorder implements TraceRecorder {
  private readonly nextSequenceByRun = new Map<string, number>();

  constructor(private readonly traceIngestor: TraceIngestor) {}

  async append(input: TraceEventInput): Promise<TraceEvent> {
    const sequenceNumber = this.nextSequenceByRun.get(input.runId) ?? 1;
    const submission = {
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      messageId: `${input.runId}:${sequenceNumber}`,
      idempotencyKey: `${input.runId}:${sequenceNumber}`,
      runId: input.runId,
      sequenceNumber,
      stage: input.stage,
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload: input.payload,
    } as const;

    const event = {
      ...submission,
      payloadHash: canonicalPayloadHash(submission.payload),
    } as TraceEvent;

    const result = await this.traceIngestor.ingest(
      submission as TraceEventSubmission,
    );
    if (result.status !== "accepted" && result.status !== "duplicate") {
      throw new Error(`${result.code}: trace event ${input.runId}:${sequenceNumber}`);
    }

    if (input.stage === "finding") {
      const findingResult = await this.traceIngestor.ingestFinding(
        input.payload as FindingEnvelope,
      );
      if (
        findingResult.status !== "accepted" &&
        findingResult.status !== "duplicate"
      ) {
        throw new Error(`${findingResult.code}: finding ${input.runId}`);
      }
    }

    this.nextSequenceByRun.set(input.runId, sequenceNumber + 1);
    return event;
  }
}
