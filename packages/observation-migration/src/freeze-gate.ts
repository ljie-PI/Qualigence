import { OBSERVATION_GRAPH_V1_VERSION } from "@qualigence/observation-contracts";
import type { ObservationFreezeReportV1 } from "./freeze-report.js";
import {
  decideGraphFreeze,
  type FreezeDecision,
  type FreezeDecisionStatus,
  type SchemaConformanceEvidence,
  type WindowsChecklistEvidence,
} from "./freeze-decision.js";

/** The version tag of the final Freeze Gate report artifact. */
export const OBSERVATION_FREEZE_GATE_REPORT_VERSION =
  "observation-freeze-gate-report/v1" as const;

/**
 * Where a Freeze Gate report was produced. `automated-linux-ci` is an ordinary
 * CI/sandbox run that CANNOT perform the real Windows-11 checklist and therefore
 * can only ever emit `candidate`. `manual-windows-signoff` is a run driven by a
 * human operator who has attached signed checklist evidence.
 */
export type FreezeGateEnvironment =
  | "automated-linux-ci"
  | "manual-windows-signoff";

export interface BuildFreezeGateReportInput {
  readonly environment: FreezeGateEnvironment;
  readonly candidateReport: ObservationFreezeReportV1;
  /** The signed manual checklist evidence, if a human has produced it. */
  readonly windowsChecklistEvidence?: WindowsChecklistEvidence;
  readonly webConformanceEvidence?: SchemaConformanceEvidence;
}

/**
 * The final, versioned Freeze Gate artifact. It embeds the auditable
 * {@link FreezeDecision} and is honest about its own limitations: an automated
 * run records exactly what it could NOT verify (the real Windows-11 checklist),
 * so it can never present a false `frozen` status.
 */
export interface FreezeGateReportV1 {
  readonly version: typeof OBSERVATION_FREEZE_GATE_REPORT_VERSION;
  readonly generatedAt: string;
  readonly graphSchemaVersion: typeof OBSERVATION_GRAPH_V1_VERSION;
  readonly environment: FreezeGateEnvironment;
  readonly status: FreezeDecisionStatus;
  readonly decision: FreezeDecision;
  readonly candidateReport: ObservationFreezeReportV1;
  /** An honest list of what this run did NOT verify. Empty only when frozen. */
  readonly limitations: readonly string[];
}

function limitationsFor(
  environment: FreezeGateEnvironment,
  decision: FreezeDecision,
): readonly string[] {
  if (decision.status === "frozen") {
    return [];
  }
  const limitations: string[] = [];
  if (environment === "automated-linux-ci") {
    limitations.push(
      "This report was produced by an automated Linux/CI run. The real Windows-11 " +
        "manual acceptance checklist (UIA capture accuracy, Job Object cleanup, " +
        "emergency-stop against a hung app, Named Pipe identity) was NOT performed " +
        "here and cannot be produced by any automated run in this repository.",
    );
  }
  if (!decision.inputs.windowsChecklistValid) {
    limitations.push(
      "No valid signed Windows-11 manual checklist evidence is attached; Graph v1 " +
        "stays candidate until a human operator completes and signs it on real hardware.",
    );
  }
  limitations.push(...decision.blockingReasons);
  return limitations;
}

/**
 * Build the final Freeze Gate report from whatever evidence is available. The
 * status comes entirely from {@link decideGraphFreeze}, so a `frozen` result is
 * only ever produced when a real signed manual checklist is supplied.
 */
export function buildFreezeGateReport(
  input: BuildFreezeGateReportInput,
  now: () => string = () => new Date().toISOString(),
): FreezeGateReportV1 {
  const decision = decideGraphFreeze(
    input.candidateReport,
    input.windowsChecklistEvidence,
    input.webConformanceEvidence,
    now,
  );
  return {
    version: OBSERVATION_FREEZE_GATE_REPORT_VERSION,
    generatedAt: now(),
    graphSchemaVersion: OBSERVATION_GRAPH_V1_VERSION,
    environment: input.environment,
    status: decision.status,
    decision,
    candidateReport: input.candidateReport,
    limitations: limitationsFor(input.environment, decision),
  };
}

/**
 * Generate the Freeze Gate report for an ordinary automated Linux/CI run.
 *
 * This function structurally CANNOT accept signed Windows checklist evidence: it
 * always passes `undefined` for that input, so the resulting report can never be
 * `frozen`, no matter how good the candidate report and schema conformance are.
 * This is the "cannot lie about being frozen" guarantee for the automated Gate —
 * freezing v1 requires a human to run {@link buildFreezeGateReport} (or invoke
 * `decideGraphFreeze`) with real checklist evidence in a deliberate follow-up.
 */
export function generateAutomatedFreezeGateReport(
  candidateReport: ObservationFreezeReportV1,
  webConformanceEvidence?: SchemaConformanceEvidence,
  now: () => string = () => new Date().toISOString(),
): FreezeGateReportV1 {
  return buildFreezeGateReport(
    {
      environment: "automated-linux-ci",
      candidateReport,
      // Intentionally omitted: an automated run has no signed human evidence.
      ...(webConformanceEvidence === undefined ? {} : { webConformanceEvidence }),
    },
    now,
  );
}
