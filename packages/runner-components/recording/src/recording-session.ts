import type { SemanticTarget } from "@qualigence/application-model";

/**
 * A single semantic action captured during a recording. Mirrors the Web action
 * surface a Skill can later replay: no `verify` step (Skill checkpoints are
 * assertions, not claim references) and never a CSS/XPath/coordinate locator.
 */
export type IntentStep =
  | { readonly kind: "navigate"; readonly path: string }
  | { readonly kind: "click"; readonly target: SemanticTarget }
  | {
      readonly kind: "input";
      readonly target: SemanticTarget;
      readonly valueRef: string;
    };

/** The deterministic outcome of a recorded action. */
export interface ActionOutcome {
  readonly status: "ok" | "failed";
  readonly errorCode?: string;
}

/**
 * Provenance for the semantic node an action resolved against. `sourceNodeId`
 * is captured for traceability only; a compiled Skill must never reuse it as an
 * executable locator — replay re-resolves by semantics.
 */
export interface RecordedSemanticNode {
  readonly role: string;
  readonly name?: string;
  readonly purpose: string;
  readonly sourceNodeId: string;
}

/** The post-action checkpoint captured for a recorded step. */
export interface RecordedCheckpoint {
  readonly requiredClaims: readonly string[];
  readonly stateFingerprint: string;
}

/** An immutable recorded step. Ordinals are monotonic starting at 1. */
export interface RecordedStep {
  readonly ordinal: number;
  readonly beforeGraphRef: string;
  readonly intent: IntentStep;
  readonly resolvedNode: RecordedSemanticNode;
  readonly outcome: ActionOutcome;
  readonly afterGraphRef: string;
  readonly checkpoint: RecordedCheckpoint;
}

/**
 * An immutable, completed recording. Only a `completed` recording with at least
 * one step is valid induction input; incomplete/cancelled recordings are never
 * accepted by the Skill compiler.
 */
export interface RecordingSession {
  readonly recordingId: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly targetVersion: string;
  readonly observationSchemaEpoch: "pre-v1" | "v1";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly steps: readonly [RecordedStep, ...RecordedStep[]];
  readonly sourceTraceRefs: readonly string[];
}

/** Metadata provided when a recording session is started. */
export interface RecordingSessionMeta {
  readonly recordingId: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly targetVersion: string;
  readonly observationSchemaEpoch: "pre-v1" | "v1";
  readonly startedAt: string;
  readonly sourceTraceRefs: readonly string[];
}

/**
 * The result of a policy-gated, executed action as observed by the Runner. A
 * step is only recordable when it was authorized by the Policy Gate and its
 * action outcome succeeded.
 */
export interface ApprovedActionResult {
  readonly authorized: boolean;
  readonly beforeGraphRef: string;
  readonly intent: IntentStep;
  readonly resolvedNode: RecordedSemanticNode;
  readonly outcome: ActionOutcome;
  readonly afterGraphRef: string;
  readonly requiredClaims: readonly string[];
  readonly stateFingerprint: string;
}

export type RecordingErrorCode =
  | "RecordingActionNotAuthorized"
  | "RecordingSecretLeak"
  | "RecordingIncomplete"
  | "RecordingNotStarted"
  | "RecordingAlreadyFinished"
  | "RecordingEmpty";

export class RecordingError extends Error {
  readonly code: RecordingErrorCode;

  constructor(code: RecordingErrorCode, message: string) {
    super(message);
    this.name = "RecordingError";
    this.code = code;
  }
}

export type RecordingState = "idle" | "recording" | "completed" | "cancelled";
