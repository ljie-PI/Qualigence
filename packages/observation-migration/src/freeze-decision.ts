import { OBSERVATION_GRAPH_V1_VERSION } from "@qualigence/observation-contracts";
import type { ObservationFreezeReportV1 } from "./freeze-report.js";

/** The version tag of the Freeze Decision record. */
export const FREEZE_DECISION_VERSION =
  "observation-freeze-decision/v1" as const;

/**
 * The version string a real signed manual Windows-11 acceptance run must carry.
 * The evidence is only accepted if it was produced against this exact checklist
 * version, so an old/foreign checklist can never be used to justify a freeze.
 */
export const WINDOWS_M3_CHECKLIST_VERSION =
  "windows-m3-manual-checklist/v1" as const;
export const REQUIRED_RUNNER_PROTOCOL_VERSION = "runner-protocol/v1" as const;

/**
 * The stable ids of the manual checklist's Section 16 security-veto items. Every
 * one of these MUST be present in the operator's evidence with a `pass` result
 * before v1 may be frozen — a single failing or missing veto item blocks freeze.
 * These mirror `docs/testing/windows-m3-manual-checklist.md` Section 16.
 */
export const REQUIRED_SECURITY_VETO_ITEM_IDS = [
  "16.permit-binding-enforced",
  "16.high-risk-authorization-required",
  "16.emergency-stop-blocks-new-actions",
  "16.no-secret-plaintext-logs",
  "16.no-companion-bypass-approval",
  "16.no-direct-uia-or-pid-management",
  "16.named-pipe-identity-enforced",
  "16.uia-hang-does-not-kill-companion",
  "16.no-out-of-job-name-or-pid-kill",
  "16.trace-integrity-conflicts-rejected",
  "16.unsigned-skill-not-executed",
  "16.crash-signals-not-suppressed",
  "16.unknown-side-effect-not-replayed",
] as const;

/** The checkbox count in each executable section of the versioned checklist. */
export const REQUIRED_WINDOWS_CHECKLIST_SECTION_COUNTS = {
  "3": 9,
  "4": 6,
  "5": 13,
  "6": 22,
  "7": 13,
  "8": 9,
  "9": 12,
  "10": 8,
  "11": 9,
  "12": 10,
  "13": 6,
  "14": 9,
  "15": 7,
  "16": 13,
  "17": 3,
} as const;

/** Every stable item id in the executable sections of checklist v1. */
export const REQUIRED_WINDOWS_CHECKLIST_ITEM_IDS: readonly string[] =
  Object.entries(REQUIRED_WINDOWS_CHECKLIST_SECTION_COUNTS).flatMap(
    ([section, count]) =>
      section === "16"
        ? [...REQUIRED_SECURITY_VETO_ITEM_IDS]
        : Array.from(
            { length: count },
            (_, index) => `${section}.item-${index + 1}`,
          ),
  );

/**
 * The shared cross-platform (Web + Desktop) core node/state/checkpoint fields
 * both targets must validate identically for the v1 schema to be considered
 * cross-target stable. A subset of `CANONICAL_NODE_FIELDS` that both a Web
 * Playwright graph and a Windows UIA graph populate.
 */
export const REQUIRED_SHARED_CORE_FIELDS = [
  "role",
  "name",
  "value",
  "state",
  "relations",
] as const;

/** The recorded outcome of one manual checklist item. */
export type WindowsChecklistItemResult =
  | "pass"
  | "fail"
  | "not_applicable"
  | "not_run";

/** One signed, structured manual-checklist item result. */
export interface WindowsChecklistItemEvidence {
  /** The checklist section this item belongs to (e.g. `"16"`). */
  readonly section: string;
  /** The stable item id (e.g. `"16.emergency-stop-blocks-new-actions"`). */
  readonly id: string;
  readonly description: string;
  readonly result: WindowsChecklistItemResult;
  readonly note?: string;
}

/**
 * The structured, signed evidence produced by a human operator running the
 * manual Windows-11 acceptance checklist on real hardware. This is a real record
 * type — NOT a stub — that `decideGraphFreeze` validates. It is never produced by
 * any automated test run in this repository; a human fills it in and signs it.
 */
export interface WindowsChecklistEvidence {
  readonly checklistVersion: string;
  readonly productVersion: string;
  readonly runnerProtocolVersion: string;
  readonly windowsBuild: string;
  readonly interactiveSessionType: "local" | "rdp";
  /** The operator who executed the checklist. */
  readonly operatorName: string;
  /** The independent reviewer who countersigned it. */
  readonly reviewerName: string;
  /** ISO-8601 timestamp of when the acceptance run was completed. */
  readonly executedAt: string;
  /** Run / Trace / Artifact references backing the evidence. */
  readonly evidenceRefs: readonly string[];
  /** The Section 16 security-veto item ids the operator attests were run. */
  readonly securityVetoItemIds: readonly string[];
  readonly items: readonly WindowsChecklistItemEvidence[];
}

/**
 * Evidence that BOTH the Web (PR-02/M1) and Desktop (this PR's Reference App
 * tests) targets validate the SAME Observation Graph v1 schema on the shared
 * node/state/checkpoint core. Without both, v1 is not proven cross-target and
 * cannot be frozen.
 */
export interface SchemaConformanceEvidence {
  readonly schemaVersion: typeof OBSERVATION_GRAPH_V1_VERSION;
  readonly webValidatesV1: boolean;
  readonly desktopValidatesV1: boolean;
  readonly sharedCoreFields: readonly string[];
}

export type FreezeDecisionStatus = "frozen" | "candidate";

/** The immutable per-input validity breakdown a Freeze Decision records. */
export interface FreezeDecisionInputs {
  readonly candidateReportValid: boolean;
  readonly windowsChecklistValid: boolean;
  readonly schemaConformanceValid: boolean;
}

/** The signed provenance echoed onto a `frozen` decision. */
export interface FreezeDecisionSignoff {
  readonly operatorName: string;
  readonly reviewerName: string;
  readonly executedAt: string;
  readonly checklistVersion: string;
  readonly productVersion: string;
  readonly windowsBuild: string;
}

/**
 * The auditable, immutable Freeze Decision. `status` is `frozen` ONLY when all
 * three inputs are present and valid; otherwise it is `candidate` and
 * `blockingReasons` enumerates exactly what is missing. `signoff` is present
 * only on a `frozen` decision.
 */
export interface FreezeDecision {
  readonly version: typeof FREEZE_DECISION_VERSION;
  readonly decidedAt: string;
  readonly graphSchemaVersion: typeof OBSERVATION_GRAPH_V1_VERSION;
  readonly status: FreezeDecisionStatus;
  readonly inputs: FreezeDecisionInputs;
  readonly blockingReasons: readonly string[];
  readonly signoff?: FreezeDecisionSignoff;
}

export const GRAPH_FREEZE_DECISION_VERSION =
  "qualigence-graph-freeze-decision/v1" as const;

export type GraphFreezeEvidenceId =
  | "github-closure"
  | "candidate-migration"
  | "graph-conformance"
  | "native-reports"
  | "provider"
  | "benchmark"
  | "release-manifest";

export interface GraphFreezeEvidenceReference {
  readonly path: string;
  readonly sha256: string;
}

export interface GraphFreezeEvidencePaths {
  readonly githubClosure?: GraphFreezeEvidenceReference;
  readonly candidateMigration?: GraphFreezeEvidenceReference;
  readonly graphConformance?: GraphFreezeEvidenceReference;
  readonly nativeReports?: GraphFreezeEvidenceReference;
  readonly provider?: GraphFreezeEvidenceReference;
  readonly benchmark?: GraphFreezeEvidenceReference;
  readonly releaseManifest?: GraphFreezeEvidenceReference;
}

export type GraphFreezeCapabilityStatus = "verified" | "blocked";

export interface GraphFreezeCapabilityDecision {
  readonly id:
    | GraphFreezeEvidenceId
    | "windows-checklist"
    | "required-ci"
    | "sbom-provenance";
  readonly component: string;
  readonly productionWiring: string;
  readonly verification: string;
  readonly command: string;
  readonly commit: string;
  readonly status: GraphFreezeCapabilityStatus;
  readonly evidence: readonly GraphFreezeEvidenceReference[];
  readonly blockers: readonly string[];
}

export interface GraphFreezeDecisionV1 {
  readonly schemaVersion: typeof GRAPH_FREEZE_DECISION_VERSION;
  readonly repository: string;
  readonly version: string;
  readonly commit: string;
  readonly decidedAt: string;
  readonly graphSchemaVersion: typeof OBSERVATION_GRAPH_V1_VERSION;
  readonly status: FreezeDecisionStatus;
  readonly capabilities: readonly GraphFreezeCapabilityDecision[];
  readonly blockingReasons: readonly string[];
  readonly signoff?: FreezeDecisionSignoff;
}

export interface FinalizeGraphFreezeInput {
  readonly repositoryRoot: string;
  readonly repository: string;
  readonly version: string;
  readonly commit: string;
  readonly decidedAt: string;
  readonly evidence: GraphFreezeEvidencePaths;
  readonly signal?: AbortSignal;
}

export interface GraphFreezeFinalizationResult {
  readonly path: string;
  readonly sha256: string;
  readonly decision: GraphFreezeDecisionV1;
}

export type GraphFreezeFinalizationErrorCode =
  | "FinalizerInputInvalid"
  | "FinalizationAborted"
  | "ReleaseVerifierCleanupFailed"
  | "DecisionArtifactConflict"
  | "DecisionArtifactWriteFailed";

export class GraphFreezeFinalizationError extends Error {
  constructor(
    readonly code: GraphFreezeFinalizationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "GraphFreezeFinalizationError";
  }
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidIsoTimestamp(value: string | undefined): boolean {
  if (!isNonEmpty(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/** Validate the PR-24 candidate Freeze Report (input (a)). */
function validateCandidateReport(
  report: ObservationFreezeReportV1 | undefined,
  reasons: string[],
  decidedAt: string,
): boolean {
  if (report === undefined) {
    reasons.push("candidate Freeze Report is missing");
    return false;
  }
  let ok = true;
  if (
    !isValidIsoTimestamp(report.generatedAt) ||
    Date.parse(report.generatedAt) > Date.parse(decidedAt)
  ) {
    reasons.push("candidate Freeze Report has no valid non-future timestamp");
    ok = false;
  }
  if (report.graphSchemaVersion !== OBSERVATION_GRAPH_V1_VERSION) {
    reasons.push(
      `candidate Freeze Report targets ${report.graphSchemaVersion}, not ${OBSERVATION_GRAPH_V1_VERSION}`,
    );
    ok = false;
  }
  if (!report.gate.allAssetsClassified) {
    reasons.push("candidate Freeze Report has unclassified assets");
    ok = false;
  }
  if (
    !report.gate.zeroUnexplainedFailures ||
    report.unexplainedFailures.length > 0
  ) {
    reasons.push("candidate Freeze Report has unexplained migration failures");
    ok = false;
  }
  if (report.counts.failed > 0) {
    reasons.push(
      `candidate Freeze Report has ${report.counts.failed} failed asset(s)`,
    );
    ok = false;
  }
  return ok;
}

/** Validate the signed manual Windows-11 checklist evidence (input (b)). */
function validateWindowsChecklist(
  evidence: WindowsChecklistEvidence | undefined,
  reasons: string[],
): boolean {
  if (evidence === undefined) {
    reasons.push(
      "signed Windows-11 manual checklist evidence is missing (no human sign-off)",
    );
    return false;
  }
  let ok = true;
  if (evidence.checklistVersion !== WINDOWS_M3_CHECKLIST_VERSION) {
    reasons.push(
      `Windows checklist version ${evidence.checklistVersion} is not ${WINDOWS_M3_CHECKLIST_VERSION}`,
    );
    ok = false;
  }
  if (evidence.runnerProtocolVersion !== REQUIRED_RUNNER_PROTOCOL_VERSION) {
    reasons.push(
      `Windows checklist does not bind ${REQUIRED_RUNNER_PROTOCOL_VERSION}`,
    );
    ok = false;
  }
  if (!isNonEmpty(evidence.operatorName)) {
    reasons.push("Windows checklist is missing an operator signature");
    ok = false;
  }
  if (!isNonEmpty(evidence.reviewerName)) {
    reasons.push("Windows checklist is missing a reviewer signature");
    ok = false;
  }
  if (
    isNonEmpty(evidence.operatorName) &&
    isNonEmpty(evidence.reviewerName) &&
    evidence.operatorName.trim() === evidence.reviewerName.trim()
  ) {
    reasons.push("Windows checklist operator and reviewer must be distinct");
    ok = false;
  }
  if (!isValidIsoTimestamp(evidence.executedAt)) {
    reasons.push("Windows checklist has no valid execution timestamp");
    ok = false;
  }
  if (
    !isNonEmpty(evidence.productVersion) ||
    !isNonEmpty(evidence.windowsBuild)
  ) {
    reasons.push(
      "Windows checklist is missing product/build environment fields",
    );
    ok = false;
  }
  const byId = new Map<string, WindowsChecklistItemEvidence>();
  const sectionCounts = new Map<string, number>();
  for (const item of evidence.items) {
    if (
      !isNonEmpty(item.id) ||
      !isNonEmpty(item.section) ||
      !isNonEmpty(item.description)
    ) {
      reasons.push(
        "Windows checklist contains an item with incomplete identity",
      );
      ok = false;
      continue;
    }
    if (byId.has(item.id)) {
      reasons.push(`checklist item ${item.id} is duplicated`);
      ok = false;
    }
    if (item.id.split(".", 1)[0] !== item.section) {
      reasons.push(
        `checklist item ${item.id} does not belong to section ${item.section}`,
      );
      ok = false;
    }
    byId.set(item.id, item);
    sectionCounts.set(item.section, (sectionCounts.get(item.section) ?? 0) + 1);
    if (item.result === "fail" || item.result === "not_run") {
      reasons.push(`checklist item ${item.id} is incomplete (${item.result})`);
      ok = false;
    }
  }
  for (const [section, count] of Object.entries(
    REQUIRED_WINDOWS_CHECKLIST_SECTION_COUNTS,
  )) {
    if (sectionCounts.get(section) !== count) {
      reasons.push(
        `Windows checklist section ${section} has ${sectionCounts.get(section) ?? 0} of ${count} required items`,
      );
      ok = false;
    }
  }
  if (
    sectionCounts.size !==
    Object.keys(REQUIRED_WINDOWS_CHECKLIST_SECTION_COUNTS).length
  ) {
    reasons.push("Windows checklist contains an unknown executable section");
    ok = false;
  }
  if (
    byId.size !== REQUIRED_WINDOWS_CHECKLIST_ITEM_IDS.length ||
    REQUIRED_WINDOWS_CHECKLIST_ITEM_IDS.some((id) => !byId.has(id))
  ) {
    reasons.push("Windows checklist does not contain the canonical item ids");
    ok = false;
  }

  const attested = new Set(evidence.securityVetoItemIds);
  if (
    attested.size !== evidence.securityVetoItemIds.length ||
    attested.size !== REQUIRED_SECURITY_VETO_ITEM_IDS.length
  ) {
    reasons.push("security-veto item ids are duplicated or non-canonical");
    ok = false;
  }
  for (const requiredId of REQUIRED_SECURITY_VETO_ITEM_IDS) {
    if (!attested.has(requiredId)) {
      reasons.push(`security-veto item ${requiredId} was not attested`);
      ok = false;
      continue;
    }
    const item = byId.get(requiredId);
    if (item === undefined) {
      reasons.push(`security-veto item ${requiredId} has no recorded result`);
      ok = false;
    } else if (item.result !== "pass") {
      reasons.push(
        `security-veto item ${requiredId} did not pass (${item.result})`,
      );
      ok = false;
    }
  }

  const conclusions = evidence.items.filter((item) => item.section === "17");
  if (
    conclusions.filter((item) => item.result === "pass").length !== 1 ||
    conclusions.some(
      (item) => item.result !== "pass" && item.result !== "not_applicable",
    )
  ) {
    reasons.push(
      "Windows checklist must record exactly one passing acceptance conclusion",
    );
    ok = false;
  }
  return ok;
}

/** Validate the cross-target (Web + Desktop) schema conformance (input (c)). */
function validateSchemaConformance(
  evidence: SchemaConformanceEvidence | undefined,
  reasons: string[],
): boolean {
  if (evidence === undefined) {
    reasons.push("cross-target schema conformance evidence is missing");
    return false;
  }
  let ok = true;
  if (evidence.schemaVersion !== OBSERVATION_GRAPH_V1_VERSION) {
    reasons.push(
      `schema conformance targets ${evidence.schemaVersion}, not ${OBSERVATION_GRAPH_V1_VERSION}`,
    );
    ok = false;
  }
  if (!evidence.webValidatesV1) {
    reasons.push("the Web target does not validate the shared v1 schema");
    ok = false;
  }
  if (!evidence.desktopValidatesV1) {
    reasons.push("the Desktop target does not validate the shared v1 schema");
    ok = false;
  }
  const present = new Set(evidence.sharedCoreFields);
  for (const field of REQUIRED_SHARED_CORE_FIELDS) {
    if (!present.has(field)) {
      reasons.push(
        `shared core field "${field}" is not validated by both targets`,
      );
      ok = false;
    }
  }
  return ok;
}

/**
 * Decide whether Observation Graph v1 may move from `candidate` to `frozen`.
 *
 * This is a PURE function. It NEVER runs a Windows machine, compiles a reference
 * app, or executes a checklist; it only VALIDATES the three pieces of evidence
 * it is handed:
 *
 *  (a) the PR-24 candidate Freeze Report showing zero unexplained migration
 *      failures,
 *  (b) the signed manual Windows-11 checklist evidence (operator/reviewer
 *      names, date, checklist version, and a pass/fail per security-veto item),
 *      which a human produces on real hardware, and
 *  (c) confirmation that BOTH the Web and Desktop targets validate the same v1
 *      schema on the shared node/state/checkpoint core.
 *
 * The result is `frozen` ONLY when all three are present and valid. If any input
 * is missing or invalid the result is `candidate`, with `blockingReasons`
 * listing exactly what is unmet. Because the Windows evidence cannot be produced
 * by an automated run, this function cannot fabricate a `frozen` status.
 */
export function decideGraphFreeze(
  candidateReport: ObservationFreezeReportV1 | undefined,
  windowsChecklistEvidence: WindowsChecklistEvidence | undefined,
  webConformanceEvidence: SchemaConformanceEvidence | undefined,
  now: () => string = () => new Date().toISOString(),
): FreezeDecision {
  const blockingReasons: string[] = [];
  const decidedAt = now();
  const candidateReportValid = validateCandidateReport(
    candidateReport,
    blockingReasons,
    decidedAt,
  );
  const windowsChecklistValid = validateWindowsChecklist(
    windowsChecklistEvidence,
    blockingReasons,
  );
  const schemaConformanceValid = validateSchemaConformance(
    webConformanceEvidence,
    blockingReasons,
  );

  const frozen =
    candidateReportValid && windowsChecklistValid && schemaConformanceValid;

  const decision: FreezeDecision = {
    version: FREEZE_DECISION_VERSION,
    decidedAt,
    graphSchemaVersion: OBSERVATION_GRAPH_V1_VERSION,
    status: frozen ? "frozen" : "candidate",
    inputs: {
      candidateReportValid,
      windowsChecklistValid,
      schemaConformanceValid,
    },
    blockingReasons,
  };

  if (frozen && windowsChecklistEvidence !== undefined) {
    return {
      ...decision,
      signoff: {
        operatorName: windowsChecklistEvidence.operatorName,
        reviewerName: windowsChecklistEvidence.reviewerName,
        executedAt: windowsChecklistEvidence.executedAt,
        checklistVersion: windowsChecklistEvidence.checklistVersion,
        productVersion: windowsChecklistEvidence.productVersion,
        windowsBuild: windowsChecklistEvidence.windowsBuild,
      },
    };
  }
  return decision;
}
