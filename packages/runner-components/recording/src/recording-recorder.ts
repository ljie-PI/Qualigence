import { createHash } from "node:crypto";
import type { Clock } from "@qualigence/shared-kernel";
import type {
  ApprovedActionResult,
  RecordedStep,
  RecordingSession,
  RecordingSessionMeta,
  RecordingState,
} from "./recording-session.js";
import { RecordingError } from "./recording-session.js";

/**
 * Captures an approved, successful action sequence into an immutable
 * {@link RecordingSession}. The recorder is a deterministic Runner component: it
 * records only Policy-authorized, successfully-executed actions, assigns
 * monotonic ordinals, refuses raw secret values (only `valueRef` is allowed) and
 * hashes the checkpoint state. A recording that is never completed — or that is
 * cancelled — can never become Skill induction input.
 */
export class RecordingRecorder {
  private state: RecordingState = "idle";
  private meta: RecordingSessionMeta | undefined;
  private readonly steps: RecordedStep[] = [];

  constructor(private readonly clock: Clock) {}

  currentState(): RecordingState {
    return this.state;
  }

  start(meta: RecordingSessionMeta): void {
    if (this.state !== "idle") {
      throw new RecordingError(
        "RecordingAlreadyFinished",
        `A recorder can only start from the idle state (was ${this.state}).`,
      );
    }
    this.meta = meta;
    this.state = "recording";
  }

  record(input: ApprovedActionResult): void {
    if (this.state !== "recording") {
      throw new RecordingError(
        "RecordingNotStarted",
        `Cannot record while the session is ${this.state}.`,
      );
    }

    if (!input.authorized) {
      throw new RecordingError(
        "RecordingActionNotAuthorized",
        "Only Policy-authorized actions may be recorded.",
      );
    }

    if (input.outcome.status !== "ok") {
      throw new RecordingError(
        "RecordingActionNotAuthorized",
        "Only successfully-executed actions may be recorded.",
      );
    }

    assertNoRawSecret(input);

    this.steps.push({
      ordinal: this.steps.length + 1,
      beforeGraphRef: input.beforeGraphRef,
      intent: input.intent,
      resolvedNode: input.resolvedNode,
      outcome: input.outcome,
      afterGraphRef: input.afterGraphRef,
      checkpoint: {
        requiredClaims: [...input.requiredClaims],
        stateFingerprint: input.stateFingerprint,
      },
    });
  }

  cancel(): void {
    if (this.state === "completed") {
      throw new RecordingError(
        "RecordingAlreadyFinished",
        "A completed recording cannot be cancelled.",
      );
    }
    this.state = "cancelled";
  }

  complete(): RecordingSession {
    if (this.state !== "recording") {
      throw new RecordingError(
        "RecordingIncomplete",
        `Cannot complete a session that is ${this.state}.`,
      );
    }
    if (this.meta === undefined) {
      throw new RecordingError(
        "RecordingNotStarted",
        "Cannot complete a recording that was never started.",
      );
    }
    const [first, ...rest] = this.steps;
    if (first === undefined) {
      throw new RecordingError(
        "RecordingEmpty",
        "A recording needs at least one approved step to complete.",
      );
    }

    this.state = "completed";
    const session: RecordingSession = {
      recordingId: this.meta.recordingId,
      projectId: this.meta.projectId,
      targetId: this.meta.targetId,
      targetVersion: this.meta.targetVersion,
      observationSchemaEpoch: this.meta.observationSchemaEpoch,
      startedAt: this.meta.startedAt,
      completedAt: this.clock.now(),
      steps: [first, ...rest],
      sourceTraceRefs: [...this.meta.sourceTraceRefs],
    };
    return Object.freeze(session);
  }
}

/**
 * Deterministically hash a checkpoint's normalized state fingerprint. Kept as a
 * pure helper so recorder output and later verification can agree.
 */
export function hashCheckpointState(fingerprintSource: string): string {
  return createHash("sha256").update(fingerprintSource, "utf8").digest("hex");
}

function assertNoRawSecret(input: ApprovedActionResult): void {
  if (input.intent.kind !== "input") {
    return;
  }
  const intent = input.intent as { readonly valueRef?: unknown; readonly value?: unknown };
  if (typeof intent.valueRef !== "string" || intent.valueRef.length === 0) {
    throw new RecordingError(
      "RecordingSecretLeak",
      "An input step must reference a value via valueRef.",
    );
  }
  if ("value" in intent && intent.value !== undefined) {
    throw new RecordingError(
      "RecordingSecretLeak",
      "An input step must not carry a raw value; use valueRef only.",
    );
  }
}
