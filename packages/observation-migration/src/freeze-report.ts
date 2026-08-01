import { OBSERVATION_GRAPH_V1_VERSION } from "@qualigence/observation-contracts";
import { OBSERVATION_MIGRATOR_VERSION } from "./pre-v1-projector.js";
import type { ObservationMigrationResult } from "./migration-runner.js";

/** The version tag of the candidate Freeze Report artifact. */
export const OBSERVATION_FREEZE_REPORT_VERSION =
  "observation-freeze-report/v1" as const;

/**
 * The lifecycle status of Observation Graph v1. LS-12's migration tooling only
 * ever emits `candidate`; the `frozen` transition is introduced by LS-13 (PR-27,
 * the M3 Gate) and is reachable ONLY via `decideGraphFreeze` once the signed
 * manual Windows-11 checklist evidence is attached. The `"frozen"` literal is
 * added here so the lifecycle type can express the frozen state, but
 * {@link buildFreezeReport} still hard-pins `candidate` — this package can never
 * emit a frozen report on its own.
 */
export type ObservationGraphLifecycle = "candidate" | "frozen";

/** The tallied outcome of an inventory migration. */
export interface ObservationFreezeCounts {
  readonly inventory: number;
  readonly migrated: number;
  readonly deprecated: number;
  readonly needsHuman: number;
  readonly failed: number;
}

/** The Freeze Gate evidence block. */
export interface ObservationFreezeGate {
  /** Zero `failed` results that lack an explaining `reasonCode`. */
  readonly zeroUnexplainedFailures: boolean;
  /** Every inventoried asset produced a terminal, recorded result. */
  readonly allAssetsClassified: boolean;
  /** Always false in LS-12 — v1 cannot be frozen before the M3 Gate. */
  readonly frozen: false;
  /** Evidence still required before a future PR may freeze v1. */
  readonly pendingEvidence: readonly string[];
}

/** An immutable candidate Freeze Report over one migration inventory. */
export interface ObservationFreezeReportV1 {
  readonly version: typeof OBSERVATION_FREEZE_REPORT_VERSION;
  readonly generatedAt: string;
  readonly graphSchemaVersion: typeof OBSERVATION_GRAPH_V1_VERSION;
  readonly migratorVersion: typeof OBSERVATION_MIGRATOR_VERSION;
  /** The lifecycle status — `candidate`, never `frozen`, in this PR. */
  readonly status: ObservationGraphLifecycle;
  readonly counts: ObservationFreezeCounts;
  /** Asset ids of `failed` results with no explaining `reasonCode`. */
  readonly unexplainedFailures: readonly string[];
  readonly results: readonly ObservationMigrationResult[];
  readonly gate: ObservationFreezeGate;
}

/** Evidence that must be attached (by LS-13) before v1 may be frozen. */
const PENDING_FREEZE_EVIDENCE: readonly string[] = [
  "LS-13: Web Playwright and Windows UIA conformance on shared nodes/state/checkpoint",
  "LS-13: uia/v1 extension preserves Windows-only semantics losslessly",
  "LS-13: Runner Protocol capability negotiation validated across Web and Desktop",
  "LS-13: human signoff on schema stability and breaking-change check",
];

/**
 * Build an immutable candidate Freeze Report from a set of migration results.
 * The report tallies every terminal outcome, flags any UNEXPLAINED failure
 * (a `failed` result missing a `reasonCode`), and pins the status to
 * `candidate` with `frozen: false` — this package cannot emit a frozen report.
 */
export function buildFreezeReport(
  results: readonly ObservationMigrationResult[],
  now: () => string = () => new Date().toISOString(),
): ObservationFreezeReportV1 {
  const counts: ObservationFreezeCounts = {
    inventory: results.length,
    migrated: results.filter((r) => r.status === "migrated").length,
    deprecated: results.filter((r) => r.status === "deprecated").length,
    needsHuman: results.filter((r) => r.status === "needs_human").length,
    failed: results.filter((r) => r.status === "failed").length,
  };

  const unexplainedFailures = results
    .filter(
      (r) =>
        r.status === "failed" &&
        (r.reasonCode === undefined || r.reasonCode.trim() === ""),
    )
    .map((r) => r.assetId);

  return {
    version: OBSERVATION_FREEZE_REPORT_VERSION,
    generatedAt: now(),
    graphSchemaVersion: OBSERVATION_GRAPH_V1_VERSION,
    migratorVersion: OBSERVATION_MIGRATOR_VERSION,
    status: "candidate",
    counts,
    unexplainedFailures,
    results,
    gate: {
      zeroUnexplainedFailures: unexplainedFailures.length === 0,
      allAssetsClassified:
        counts.migrated + counts.deprecated + counts.needsHuman + counts.failed ===
        counts.inventory,
      frozen: false,
      pendingEvidence: PENDING_FREEZE_EVIDENCE,
    },
  };
}
