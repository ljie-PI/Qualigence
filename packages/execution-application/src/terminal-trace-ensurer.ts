import type { TraceStore } from "@qualigence/evidence";
import {
  canonicalTraceEventHash,
  type RunId,
  type TraceEvent,
  type TraceEventHashInput,
} from "@qualigence/runner-protocol";
import type { Clock } from "@qualigence/shared-kernel";
import { SystemClock } from "@qualigence/shared-kernel";

/**
 * Guarantees that a created Run always ends with exactly one `run_completed`
 * event. It reads the event at `nextTraceSequenceNumber - 1`; only when that
 * last event is not already a terminal does it append a single
 * `run_completed:error`. A concurrent writer that terminalized first is
 * tolerated: the sequence/idempotency guards of the store make a redundant
 * append a no-op.
 */
export class TerminalTraceEnsurer {
  constructor(
    private readonly traces: TraceStore,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async ensureError(runId: RunId, errorCode: string): Promise<void> {
    if (await this.hasTerminal(runId)) {
      return;
    }

    const sequenceNumber = await this.traces.nextTraceSequenceNumber(runId);
    const event = this.buildTerminalEvent(runId, sequenceNumber, errorCode);
    const result = await this.traces.appendTraceEvent(event);

    if (result.status === "accepted" || result.status === "duplicate") {
      return;
    }

    // A concurrent writer may have terminalized between our check and append.
    if (await this.hasTerminal(runId)) {
      return;
    }

    throw new Error(
      `Failed to append terminal trace for ${runId}: ${result.code}`,
    );
  }

  private async hasTerminal(runId: RunId): Promise<boolean> {
    const next = await this.traces.nextTraceSequenceNumber(runId);
    if (next <= 1) {
      return false;
    }
    const last = await this.traces.eventAt(runId, next - 1);
    return last?.stage === "run_completed";
  }

  private buildTerminalEvent(
    runId: RunId,
    sequenceNumber: number,
    errorCode: string,
  ): TraceEvent {
    const envelope: TraceEventHashInput = {
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      messageId: `${runId}:${sequenceNumber}`,
      idempotencyKey: `${runId}:${sequenceNumber}`,
      runId,
      sequenceNumber,
      stage: "run_completed",
      occurredAt: this.clock.now(),
      payload: { status: "error", errorCode },
    };

    return {
      ...envelope,
      payloadHash: canonicalTraceEventHash(envelope),
    } as TraceEvent;
  }
}
