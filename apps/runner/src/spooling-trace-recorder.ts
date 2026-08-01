import {
  canonicalTraceEventHash,
  type FindingEnvelope,
  type TraceEvent,
  type TraceEventHashInput,
} from "@qualigence/runner-protocol";
import type { TraceEventInput, TraceRecorder } from "@qualigence/runner-kernel";
import type { RunnerSpool } from "@qualigence/runner-spool";

/**
 * A {@link TraceRecorder} that writes every event durably to the Runner
 * {@link RunnerSpool} before any network submission is attempted (LS-05 design
 * §5). Sequence numbers are assigned per Run and each event is enveloped and
 * hashed so it is wire-ready; the separate upload pump drains the spool and only
 * deletes acknowledged records. Because the write happens first, a disconnect can
 * never lose an already-recorded Trace event.
 */
export class SpoolingTraceRecorder implements TraceRecorder {
  private readonly nextSequenceByRun = new Map<string, number>();

  constructor(private readonly spool: RunnerSpool) {}

  async append(input: TraceEventInput): Promise<TraceEvent> {
    const sequenceNumber = this.nextSequenceByRun.get(input.runId) ?? 1;
    const event = withHash(withEnvelope(input, sequenceNumber));
    await this.spool.append(event);
    this.nextSequenceByRun.set(input.runId, sequenceNumber + 1);
    return event;
  }
}

/** The finding payload of a `finding`-stage trace event, for downstream reporting. */
export function findingOf(event: TraceEvent): FindingEnvelope | undefined {
  return event.stage === "finding" ? event.payload : undefined;
}

function withEnvelope(input: TraceEventInput, sequenceNumber: number): TraceEventHashInput {
  const base = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `${input.runId}:${sequenceNumber}`,
    idempotencyKey: `${input.runId}:${sequenceNumber}`,
    runId: input.runId,
    sequenceNumber,
    occurredAt: "2026-08-01T00:00:00.000Z",
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
    case "run_completed":
      return { ...base, stage: input.stage, payload: input.payload };
  }
}

function withHash(event: TraceEventHashInput): TraceEvent {
  return {
    ...event,
    payloadHash: canonicalTraceEventHash(event),
  } as TraceEvent;
}
