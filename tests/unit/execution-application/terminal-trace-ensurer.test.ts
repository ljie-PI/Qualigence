import { describe, expect, it } from "vitest";
import { InMemoryTraceStore } from "@qualigence/evidence";
import type { RunId, TraceEvent } from "@qualigence/runner-protocol";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import { TraceIngestor } from "@qualigence/evidence";
import { TerminalTraceEnsurer } from "@qualigence/execution-application";

describe("TerminalTraceEnsurer", () => {
  it("appends exactly one terminal error event and is idempotent", async () => {
    const trace = new InMemoryTraceStore();
    const ensurer = new TerminalTraceEnsurer(trace);

    await ensurer.ensureError("run-1", "BrowserUnavailable");
    await ensurer.ensureError("run-1", "BrowserUnavailable");

    const terminals = trace
      .eventsFor("run-1")
      .filter((event) => event.stage === "run_completed");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.payload).toMatchObject({
      status: "error",
      errorCode: "BrowserUnavailable",
    });
  });

  it("does not append when a business terminal already exists", async () => {
    const trace = new InMemoryTraceStore();
    const recorder = new InMemoryProtocolTraceRecorder(new TraceIngestor(trace));
    await recorder.append({
      runId: "run-2" as RunId,
      stage: "run_completed",
      payload: { status: "passed" },
    });

    const ensurer = new TerminalTraceEnsurer(trace);
    await ensurer.ensureError("run-2", "BrowserUnavailable");

    const terminals: readonly TraceEvent[] = trace
      .eventsFor("run-2")
      .filter((event) => event.stage === "run_completed");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.payload).toMatchObject({ status: "passed" });
  });
});
