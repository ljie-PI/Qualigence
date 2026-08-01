/**
 * The TypeScript-side client of the Rust Companion — an IPC client ONLY.
 *
 * The Companion is the sole broker (specialist finding W-01): TypeScript never
 * holds a Win32/UIA handle, a target PID or a native Job Object. It may only ask
 * the Companion — over the authenticated Named Pipe — to launch/reset/shutdown a
 * Job-managed process, capture a `uia/v1` source, request a one-time local
 * Permit, and execute an already-authorized action. Every method here maps to a
 * single typed {@link CompanionRequest}.
 */

import type {
  AppSession,
  AppTarget,
  LocalApprovalDecision,
  LocalPermitRequest,
  LocalExecutionPermit,
  ResolvedDesktopAction,
} from "@qualigence/desktop-contracts";
import type { UiaSource } from "./uia-source.js";

/** The outcome the Companion reports for an executed desktop action. */
export type ActionOutcomeReport =
  | { readonly status: "ok" }
  | { readonly status: "failed"; readonly errorCode: string };

export interface UiaCaptureRequest {
  readonly sessionId: string;
  readonly deadlineMs: number;
}

export interface DesktopActionExecuteRequest {
  readonly sessionId: string;
  readonly action: ResolvedDesktopAction;
  readonly permit: LocalExecutionPermit;
  readonly deadlineMs: number;
}

export interface CompanionClient {
  launch(target: AppTarget): Promise<AppSession>;
  reset(sessionId: string): Promise<void>;
  shutdown(sessionId: string): Promise<void>;
  capture(request: UiaCaptureRequest): Promise<UiaSource>;
  requestPermit(request: LocalPermitRequest): Promise<LocalApprovalDecision>;
  execute(request: DesktopActionExecuteRequest): Promise<ActionOutcomeReport>;
}

export type DesktopExecutionErrorCode =
  | "UnsupportedTargetKind"
  | "MissingPermitDescriptor"
  | "LocalPermitDenied"
  | "LocalPermitTimedOut"
  | "EmergencyStopped"
  | "ActionOutcomeUnknown"
  | "ActionFailed";

/** A stable, non-secret desktop execution failure surfaced to the Runner. */
export class DesktopExecutionError extends Error {
  readonly code: DesktopExecutionErrorCode;

  constructor(code: DesktopExecutionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "DesktopExecutionError";
    this.code = code;
  }
}
