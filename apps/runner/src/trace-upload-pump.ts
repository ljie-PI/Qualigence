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
  async pumpOnce(signal?: AbortSignal): Promise<TraceUploadPumpResult> {
    signal?.throwIfAborted();
    const events = await abortable(this.spool.pending(this.runId, this.cursor, this.limit), signal);
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
    signal?.throwIfAborted();
    const ack = await abortable(this.submitter.submit(batch), signal);
    signal?.throwIfAborted();
    await abortable(this.spool.acknowledge(this.runId, ack.nextExpectedSequenceNumber), signal);
    signal?.throwIfAborted();
    this.cursor = Math.max(this.cursor, ack.nextExpectedSequenceNumber);
    const remaining = await abortable(this.spool.pending(this.runId, this.cursor, this.limit), signal);
    return { submitted: events.length, done: remaining.length === 0 };
  }

  /** Drain the spool until Core has acknowledged every spooled event. */
  async drain(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const result = await this.pumpOnce(signal);
      if (result.done) {
        return;
      }
    }
  }
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
