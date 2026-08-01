import pino from "pino";
import type { DestinationStream, Logger } from "pino";
import type { RunExecutionResult } from "@qualigence/execution-application";

/**
 * Serializes the stable `cli-result/v1` JSON as exactly one line. This is the
 * machine contract; only this shape is guaranteed across a major version.
 */
export function renderJson(result: RunExecutionResult): string {
  return `${JSON.stringify(result)}\n`;
}

/**
 * Renders a human-readable summary. This output is NOT a machine contract.
 */
export function renderHuman(result: RunExecutionResult): string {
  const lines = [
    `Status:  ${result.status}`,
    `Run ID:  ${result.runId || "(not started)"}`,
  ];
  if (result.errorCode !== undefined) {
    lines.push(`Error:   ${result.errorCode}`);
  }
  if (result.finding !== undefined) {
    lines.push(`Finding: ${result.finding.title} — ${result.finding.summary}`);
    lines.push(`Severity: ${result.finding.severity}`);
  }
  lines.push(`Evidence: ${result.evidenceRefs.length} reference(s)`);
  return `${lines.join("\n")}\n`;
}

const REDACTED_PATHS = [
  "apiKey",
  "modelApiKey",
  "model.apiKey",
  "QUALIGENCE_MODEL_API_KEY",
  "authorization",
  "Authorization",
  "headers.authorization",
  "token",
  "password",
  "secret",
];

export interface LoggerOptions {
  readonly destination?: DestinationStream;
  readonly level?: string;
}

/**
 * Creates a Pino logger writing to stderr (or an injected destination for
 * tests). Known secret keys are redacted so an API key or token can never be
 * printed, even accidentally.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const pinoOptions = {
    level: options.level ?? "info",
    redact: { paths: REDACTED_PATHS, censor: "[Redacted]" },
  };
  return options.destination === undefined
    ? pino(pinoOptions, pino.destination(2))
    : pino(pinoOptions, options.destination);
}
