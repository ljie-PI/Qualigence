import { RunnerAppError, type RunnerAppErrorCode } from "./errors.js";

export type SafeRunnerLogErrorCode = RunnerAppErrorCode | "UnexpectedRunnerError";

const SAFE_RUNNER_APP_ERROR_CODES = new Set<RunnerAppErrorCode>([
  "CapabilityMismatch",
  "LeaseExpired",
  "LeaseWindowUnsafe",
  "SpoolUnavailable",
  "PolicyMissing",
  "PolicyDenied",
  "TransportError",
]);

export function safeRunnerErrorCode(error: unknown): SafeRunnerLogErrorCode {
  if (error instanceof RunnerAppError && SAFE_RUNNER_APP_ERROR_CODES.has(error.code)) {
    return error.code;
  }
  return "UnexpectedRunnerError";
}

export function safeRunnerLogLine(event: "runner.reconnecting" | "runner.fatal", error: unknown): string {
  return `${JSON.stringify({ event, code: safeRunnerErrorCode(error) })}\n`;
}
