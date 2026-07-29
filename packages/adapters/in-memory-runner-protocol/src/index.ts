import type { TraceIngestor } from "@qualigence/evidence";
import {
  canonicalTraceEventHash,
  type FindingEnvelope,
  type TraceEvent,
  type TraceEventHashInput,
} from "@qualigence/runner-protocol";
import type { TraceEventInput, TraceRecorder } from "@qualigence/runner-kernel";

export class InMemoryProtocolTraceRecorder implements TraceRecorder {
  private readonly nextSequenceByRun = new Map<string, number>();

  constructor(private readonly traceIngestor: TraceIngestor) {}

  async append(input: TraceEventInput): Promise<TraceEvent> {
    const sequenceNumber = this.nextSequenceByRun.get(input.runId) ?? 1;
    const event = withHash(withEnvelope(input, sequenceNumber));

    const result = await this.traceIngestor.ingest(event);
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

function withEnvelope(
  input: TraceEventInput,
  sequenceNumber: number,
): TraceEventHashInput {
  const base = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `${input.runId}:${sequenceNumber}`,
    idempotencyKey: `${input.runId}:${sequenceNumber}`,
    runId: input.runId,
    sequenceNumber,
    occurredAt: "2026-07-30T00:00:00.000Z",
  } as const;

  switch (input.stage) {
    case "observation":
      return { ...base, stage: input.stage, payload: input.payload };
    case "decision":
      return { ...base, stage: input.stage, payload: input.payload };
    case "action_resolved":
      return { ...base, stage: input.stage, payload: input.payload };
    case "policy_authorized":
      return { ...base, stage: input.stage, payload: input.payload };
    case "policy_denied":
      return { ...base, stage: input.stage, payload: input.payload };
    case "action_executed":
      return { ...base, stage: input.stage, payload: input.payload };
    case "verification":
      return { ...base, stage: input.stage, payload: input.payload };
    case "finding":
      return { ...base, stage: input.stage, payload: input.payload };
  }
}

function withHash(event: TraceEventHashInput): TraceEvent {
  return {
    ...event,
    payloadHash: canonicalTraceEventHash(event),
  } as TraceEvent;
}
