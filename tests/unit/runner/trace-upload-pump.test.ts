import { afterEach, describe, expect, it } from "vitest";
import type {
  ExecutionEventAck,
  ExecutionEventBatch,
} from "@qualigence/runner-protocol";
import { SqliteRunnerSpool, type RunnerSpool } from "@qualigence/runner-spool";
import { RunnerAppError } from "../../../apps/runner/src/errors.js";
import { SpoolingTraceRecorder } from "../../../apps/runner/src/spooling-trace-recorder.js";
import {
  TraceUploadPump,
  type TraceBatchSubmitter,
} from "../../../apps/runner/src/trace-upload-pump.js";
import { observationGraphV1 } from "../../helpers/observation-graph-v1.js";

const RUN_ID = "run-1";
const LIMIT = { maximumEvents: 100, maximumBytes: 1_000_000 };

/** A Core-side cursor: acknowledges contiguous batches, optionally failing. */
class RecordingCore implements TraceBatchSubmitter {
  private nextExpected = 1;
  readonly accepted: number[] = [];
  readonly events: ExecutionEventBatch["events"][number][] = [];
  failNext = false;

  async submit(batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    if (this.failNext) {
      this.failNext = false;
      throw new RunnerAppError("TransportError", "connection dropped mid-batch");
    }
    for (const event of batch.events) {
      if (event.sequenceNumber >= this.nextExpected) {
        this.accepted.push(event.sequenceNumber);
        this.events.push(event);
        this.nextExpected = event.sequenceNumber + 1;
      }
    }
    return {
      batchId: batch.batchId,
      runId: batch.runId,
      nextExpectedSequenceNumber: this.nextExpected,
    };
  }
}

let openSpools: SqliteRunnerSpool[] = [];

async function newSpool(): Promise<RunnerSpool> {
  const spool = await SqliteRunnerSpool.open({ databaseFile: ":memory:" });
  openSpools.push(spool);
  return spool;
}

async function recordThreeEvents(spool: RunnerSpool): Promise<void> {
  const recorder = new SpoolingTraceRecorder(spool);
  await recorder.append({
    runId: RUN_ID,
    stage: "observation",
    payload: observationGraphV1("graph-before"),
  });
  await recorder.append({
    runId: RUN_ID,
    stage: "decision",
    payload: {
      kind: "click",
      target: { nodeId: "node-a" },
      reason: "first action",
    },
  });
  await recorder.append({
    runId: RUN_ID,
    stage: "run_completed",
    payload: { status: "passed" },
  });
}

afterEach(async () => {
  await Promise.all(openSpools.map((spool) => spool.close()));
  openSpools = [];
});

describe("TraceUploadPump", () => {
  it("preserves stepIndex through the production recorder and durable spool", async () => {
    const spool = await newSpool();
    const recorder = new SpoolingTraceRecorder(spool);
    await recorder.append({
      runId: RUN_ID,
      stepIndex: 2,
      stage: "decision",
      payload: { kind: "click", target: { nodeId: "node-a" }, reason: "third step" },
    });
    const core = new RecordingCore();

    await new TraceUploadPump(spool, core, RUN_ID, LIMIT).drain();

    expect(core.events).toHaveLength(1);
    expect(core.events[0]).toMatchObject({ stepIndex: 2, stage: "decision" });
  });

  it("drains every spooled event to Core in order and clears the spool", async () => {
    const spool = await newSpool();
    await recordThreeEvents(spool);
    const core = new RecordingCore();

    await new TraceUploadPump(spool, core, RUN_ID, LIMIT).drain();

    expect(core.accepted).toEqual([1, 2, 3]);
    expect((await spool.usage()).events).toBe(0);
  });

  it("loses no accepted event when the connection drops mid-drain and replays on reconnect", async () => {
    const spool = await newSpool();
    await recordThreeEvents(spool);
    const core = new RecordingCore();
    core.failNext = true;

    // Simulated disconnect: the submit throws, so nothing is acknowledged.
    await expect(
      new TraceUploadPump(spool, core, RUN_ID, LIMIT).drain(),
    ).rejects.toBeInstanceOf(RunnerAppError);

    expect(core.accepted).toEqual([]);
    expect((await spool.usage()).events).toBe(3);

    // Reconnect and replay from the durable spool: no event lost, none dropped.
    await new TraceUploadPump(spool, core, RUN_ID, LIMIT).drain();

    expect(core.accepted).toEqual([1, 2, 3]);
    expect((await spool.usage()).events).toBe(0);
  });

  it("does not re-submit events already past the Core cursor", async () => {
    const spool = await newSpool();
    await recordThreeEvents(spool);
    const core = new RecordingCore();

    const pump = new TraceUploadPump(spool, core, RUN_ID, LIMIT);
    await pump.drain();
    // A redundant drain after full acknowledgement is a no-op.
    await pump.drain();

    expect(core.accepted).toEqual([1, 2, 3]);
  });
});
