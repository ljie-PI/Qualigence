import { describe, expect, it } from "vitest";
import {
  RecordingRecorder,
  hashCheckpointState,
} from "@qualigence/recording";
import type {
  ApprovedActionResult,
  RecordingSessionMeta,
} from "@qualigence/recording";
import type { Clock } from "@qualigence/shared-kernel";

function fixedClock(instant: string): Clock {
  return { now: () => instant };
}

const meta: RecordingSessionMeta = {
  recordingId: "rec-1",
  projectId: "proj-1",
  targetId: "web-cart",
  targetVersion: "2026.08.01",
  observationSchemaEpoch: "pre-v1",
  startedAt: "2026-08-01T00:00:00.000Z",
  sourceTraceRefs: ["run-1"],
};

function approvedStep(
  overrides: Partial<ApprovedActionResult> = {},
): ApprovedActionResult {
  return {
    authorized: true,
    beforeGraphRef: "graph-a",
    intent: { kind: "click", target: { purpose: "add to cart" } },
    resolvedNode: {
      role: "button",
      name: "Add to cart",
      purpose: "add to cart",
      sourceNodeId: "node-42",
    },
    outcome: { status: "ok" },
    afterGraphRef: "graph-b",
    requiredClaims: ["cart.count>=1"],
    stateFingerprint: hashCheckpointState("cart:1"),
    ...overrides,
  };
}

describe("RecordingRecorder", () => {
  it("records an approved step and completes with a monotonic ordinal", () => {
    const recorder = new RecordingRecorder(fixedClock("2026-08-01T00:01:00.000Z"));
    recorder.start(meta);
    recorder.record(approvedStep());

    const session = recorder.complete();
    expect(session).toMatchObject({
      recordingId: "rec-1",
      completedAt: "2026-08-01T00:01:00.000Z",
      steps: [{ ordinal: 1 }],
    });
    expect(recorder.currentState()).toBe("completed");
  });

  it("assigns monotonic ordinals across multiple steps", () => {
    const recorder = new RecordingRecorder(fixedClock("t"));
    recorder.start(meta);
    recorder.record(approvedStep());
    recorder.record(
      approvedStep({
        intent: {
          kind: "input",
          target: { purpose: "quantity" },
          valueRef: "test-data.cart.quantity",
        },
      }),
    );
    const session = recorder.complete();
    expect(session.steps.map((step) => step.ordinal)).toEqual([1, 2]);
  });

  it("rejects an unauthorized action", () => {
    const recorder = new RecordingRecorder(fixedClock("t"));
    recorder.start(meta);
    try {
      recorder.record(approvedStep({ authorized: false }));
      expect.unreachable("unpermitted action must fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "RecordingActionNotAuthorized" });
    }
  });

  it("rejects an action whose execution failed", () => {
    const recorder = new RecordingRecorder(fixedClock("t"));
    recorder.start(meta);
    expect(() =>
      recorder.record(
        approvedStep({ outcome: { status: "failed", errorCode: "ActionFailed" } }),
      ),
    ).toThrowError(/successfully-executed/);
  });

  it("rejects a raw secret value, requiring valueRef only", () => {
    const recorder = new RecordingRecorder(fixedClock("t"));
    recorder.start(meta);
    const leaky = approvedStep({
      intent: {
        kind: "input",
        target: { purpose: "password" },
        // Simulate a leaked raw secret alongside the valueRef.
        valueRef: "test-data.login.password",
        value: "hunter2",
      } as never,
    });
    expect(() => recorder.record(leaky)).toMatchObject({});
    try {
      recorder.record(leaky);
      expect.unreachable("raw secret must be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "RecordingSecretLeak" });
    }
  });

  it("only stores valueRef for input steps (no raw value key)", () => {
    const recorder = new RecordingRecorder(fixedClock("t"));
    recorder.start(meta);
    recorder.record(
      approvedStep({
        intent: {
          kind: "input",
          target: { purpose: "quantity" },
          valueRef: "test-data.cart.quantity",
        },
      }),
    );
    const [step] = recorder.complete().steps;
    expect(step?.intent).toEqual({
      kind: "input",
      target: { purpose: "quantity" },
      valueRef: "test-data.cart.quantity",
    });
    expect(Object.prototype.hasOwnProperty.call(step?.intent ?? {}, "value")).toBe(
      false,
    );
  });

  it("cannot complete an empty recording", () => {
    const recorder = new RecordingRecorder(fixedClock("t"));
    recorder.start(meta);
    try {
      recorder.complete();
      expect.unreachable("empty recording must not complete");
    } catch (error) {
      expect(error).toMatchObject({ code: "RecordingEmpty" });
    }
  });

  it("a cancelled recording cannot become induction input", () => {
    const recorder = new RecordingRecorder(fixedClock("t"));
    recorder.start(meta);
    recorder.record(approvedStep());
    recorder.cancel();
    expect(recorder.currentState()).toBe("cancelled");
    try {
      recorder.complete();
      expect.unreachable("cancelled recording must not complete");
    } catch (error) {
      expect(error).toMatchObject({ code: "RecordingIncomplete" });
    }
  });

  it("refuses to record after completion", () => {
    const recorder = new RecordingRecorder(fixedClock("t"));
    recorder.start(meta);
    recorder.record(approvedStep());
    recorder.complete();
    expect(() => recorder.record(approvedStep())).toThrowError(/completed/);
  });
});
