import { randomBytes } from "node:crypto";
import type { ExecutionEventAck, ExecutionEventBatch } from "@qualigence/runner-protocol";
import type { RunnerSpool, SpoolBatchLimit } from "@qualigence/runner-spool";

/** The minimal submit seam the pump needs; a {@link RunnerSession} satisfies it. */
export interface TraceBatchSubmitter {
  submit(batch: ExecutionEventBatch): Promise<ExecutionEventAck>;
}

export interface TraceUploadPumpResult {
  readonly submitted: number;
  readonly done: boolean;
}

/**
 * Drains spooled Trace to Core in original order (LS-05 design §5). It reads the
 * next pending window from the {@link RunnerSpool}, submits it, and only
 * acknowledges the spool once Core confirms — so a transport failure mid-drain
 * leaves every unacknowledged event durably queued for replay. On reconnect the
 * pump simply resumes from the spool: no event is dropped and none is duplicated
 * past the Core cursor.
 */
export class TraceUploadPump {
  private cursor = 1;

  constructor(
    private readonly spool: RunnerSpool,
    private readonly submitter: TraceBatchSubmitter,
    private readonly runId: string,
    private readonly limit: SpoolBatchLimit,
    private readonly generateBatchId: () => string = (): string => randomBytes(8).toString("hex"),
  ) {}

  /** Submit at most one batch. Returns `done` when nothing more is pending. */
  async pumpOnce(): Promise<TraceUploadPumpResult> {
    const events = await this.spool.pending(this.runId, this.cursor, this.limit);
    if (events.length === 0) {
      return { submitted: 0, done: true };
    }
    const first = events[0]!;
    const batch: ExecutionEventBatch = {
      batchId: this.generateBatchId(),
      runId: this.runId,
      firstSequenceNumber: first.sequenceNumber,
      events,
    };
    const ack = await this.submitter.submit(batch);
    await this.spool.acknowledge(this.runId, ack.nextExpectedSequenceNumber);
    this.cursor = Math.max(this.cursor, ack.nextExpectedSequenceNumber);
    const remaining = await this.spool.pending(this.runId, this.cursor, this.limit);
    return { submitted: events.length, done: remaining.length === 0 };
  }

  /** Drain the spool until Core has acknowledged every spooled event. */
  async drain(): Promise<void> {
    for (;;) {
      const result = await this.pumpOnce();
      if (result.done) {
        return;
      }
    }
  }
}
