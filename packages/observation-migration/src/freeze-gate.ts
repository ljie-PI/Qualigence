import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { OBSERVATION_GRAPH_V1_VERSION } from "@qualigence/observation-contracts";
import { canonicalJson, sha256Hex } from "@qualigence/skill";
import {
  OBSERVATION_FREEZE_REPORT_VERSION,
  type ObservationFreezeReportV1,
} from "./freeze-report.js";
import { OBSERVATION_MIGRATOR_VERSION } from "./pre-v1-projector.js";
import {
  GRAPH_FREEZE_DECISION_VERSION,
  GraphFreezeFinalizationError,
  REQUIRED_SHARED_CORE_FIELDS,
  decideGraphFreeze,
  type FreezeDecision,
  type FreezeDecisionStatus,
  type FinalizeGraphFreezeInput,
  type GraphFreezeCapabilityDecision,
  type GraphFreezeDecisionV1,
  type GraphFreezeEvidenceId,
  type GraphFreezeEvidenceReference,
  type GraphFreezeFinalizationResult,
  type SchemaConformanceEvidence,
  type WindowsChecklistEvidence,
} from "./freeze-decision.js";

const execFileAsync = promisify(execFile);

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
      ...(webConformanceEvidence === undefined
        ? {}
        : { webConformanceEvidence }),
    },
    now,
  );
}

const MISSING_CAPABILITIES: readonly Omit<
  GraphFreezeCapabilityDecision,
  "commit" | "status" | "evidence" | "blockers"
>[] = [
  {
    id: "benchmark",
    component: "Detection Benchmark v1",
    productionWiring: "Reference Model Profile benchmark runner",
    verification:
      "serialized benchmark report and persisted invocation evidence",
    command:
      "CI=true corepack pnpm vitest run tests/e2e/detection-benchmark/reference-model-profile.test.ts",
  },
  {
    id: "candidate-migration",
    component: "Observation migration",
    productionWiring: "active pre-v1 Trace and Skill inventory",
    verification: "serialized Observation Freeze Report",
    command:
      "corepack pnpm vitest run tests/migration/observation-v1/freeze-decision.test.ts",
  },
  {
    id: "github-closure",
    component: "GitHub closure tracker",
    productionWiring:
      "Issue #67 canonical ticket graph and merged pull requests",
    verification:
      "serialized GitHub Issue, PR, review, check, and commit evidence",
    command: "gh issue view 67 --repo ljie-PI/Qualigence --comments",
  },
  {
    id: "graph-conformance",
    component: "Observation Graph v1",
    productionWiring: "Web and Desktop Graph producers and consumers",
    verification: "serialized Web/Desktop schema and extension conformance",
    command:
      "corepack pnpm vitest run tests/conformance/observation tests/component/windows-uia",
  },
  {
    id: "native-reports",
    component: "Windows native runtime",
    productionWiring:
      "Named Pipe authority, UIA worker, Job Object, and Companion daemon",
    verification: "serialized Ticket 29 and Ticket 30 native reports",
    command: "corepack pnpm gate:windows",
  },
  {
    id: "provider",
    component: "Model provider",
    productionWiring: "Reference Model Profile and live remote model smoke",
    verification: "serialized real-provider result and redaction evidence",
    command:
      "CI=true QUALIGENCE_LIVE_MODEL_SMOKE=true corepack pnpm vitest run tests/live/remote-model-smoke.test.ts",
  },
  {
    id: "release-manifest",
    component: "Release manifest",
    productionWiring: "Ticket 34 immutable release workflow",
    verification: "Ticket 34 schema and verifier",
    command:
      "corepack pnpm gate:release -- --manifest artifacts/release/<version>/release-manifest.json",
  },
  {
    id: "required-ci",
    component: "Mandatory CI Gates",
    productionWiring:
      "gate-linux, gate-windows-rust, gate-self-hosted, and browser-e2e",
    verification: "same-commit, zero-skip Gate artifacts",
    command: "GitHub Actions required Gate artifact verification",
  },
  {
    id: "sbom-provenance",
    component: "Release supply chain",
    productionWiring:
      "immutable images, SPDX SBOM, provenance, and attestations",
    verification: "Ticket 34 release-manifest verifier",
    command:
      "corepack pnpm gate:release -- --manifest artifacts/release/<version>/release-manifest.json",
  },
  {
    id: "windows-checklist",
    component: "Windows manual acceptance",
    productionWiring: "signed local-console and RDP Windows 11 checklist",
    verification: "embedded WindowsChecklistEvidence and distinct signatures",
    command: "Integrated human acceptance Issue #181",
  },
] as const;

class EvidenceValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function validateFinalizerInput(input: FinalizeGraphFreezeInput): void {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) ||
    !/^[A-Za-z0-9._-]+$/u.test(input.version) ||
    !/^[a-f0-9]{40}$/u.test(input.commit) ||
    !Number.isFinite(Date.parse(input.decidedAt)) ||
    input.repositoryRoot.trim() === ""
  ) {
    throw new GraphFreezeFinalizationError(
      "FinalizerInputInvalid",
      "repository, version, commit, decidedAt, and repositoryRoot must be valid",
    );
  }
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new GraphFreezeFinalizationError(
      "FinalizationAborted",
      "Graph freeze finalization was cancelled before terminal publication",
    );
  }
}

function missingCapabilities(
  input: FinalizeGraphFreezeInput,
): GraphFreezeCapabilityDecision[] {
  return MISSING_CAPABILITIES.map(
    (capability): GraphFreezeCapabilityDecision => {
      const blocker = `EvidenceMissing: ${capability.id}`;
      return {
        ...capability,
        commit: input.commit,
        status: "blocked",
        evidence: [],
        blockers: [blocker],
      };
    },
  );
}

function graphFreezeDecision(
  input: FinalizeGraphFreezeInput,
  capabilities: readonly GraphFreezeCapabilityDecision[],
  signoff: GraphFreezeDecisionV1["signoff"],
): GraphFreezeDecisionV1 {
  const status =
    signoff !== undefined &&
    capabilities.every((capability) => capability.status === "verified")
      ? "frozen"
      : "candidate";
  return {
    schemaVersion: GRAPH_FREEZE_DECISION_VERSION,
    repository: input.repository,
    version: input.version,
    commit: input.commit,
    decidedAt: input.decidedAt,
    graphSchemaVersion: OBSERVATION_GRAPH_V1_VERSION,
    status,
    capabilities: [...capabilities].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    blockingReasons: capabilities
      .flatMap((capability) => capability.blockers)
      .sort(),
    ...(status === "frozen" && signoff !== undefined ? { signoff } : {}),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvidenceValidationError(
      "EvidenceMalformed",
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new EvidenceValidationError(
        "EvidenceSchemaInvalid",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvidenceValidationError(
      "EvidenceMalformed",
      `${label}.${key} must be a non-empty string`,
    );
  }
  return value;
}

function requireArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new EvidenceValidationError(
      "EvidenceMalformed",
      `${label}.${key} must be an array`,
    );
  }
  return value;
}

function assertBinding(
  record: Record<string, unknown>,
  input: FinalizeGraphFreezeInput,
  label: string,
): void {
  if (record["repository"] !== input.repository) {
    throw new EvidenceValidationError(
      "EvidenceRepositoryMismatch",
      `${label} does not bind ${input.repository}`,
    );
  }
  if (record["version"] !== input.version) {
    throw new EvidenceValidationError(
      "EvidenceVersionMismatch",
      `${label} does not bind ${input.version}`,
    );
  }
  if (record["commit"] !== input.commit) {
    throw new EvidenceValidationError(
      "EvidenceCommitMismatch",
      `${label} does not bind ${input.commit}`,
    );
  }
  if (record["evidenceClass"] !== "real") {
    throw new EvidenceValidationError(
      "SyntheticEvidenceRejected",
      `${label} must be classified as real evidence`,
    );
  }
  const generatedAt = requireString(record, "generatedAt", label);
  const generatedTime = Date.parse(generatedAt);
  if (
    !Number.isFinite(generatedTime) ||
    generatedTime > Date.parse(input.decidedAt)
  ) {
    throw new EvidenceValidationError(
      "EvidenceStale",
      `${label}.generatedAt must be valid and no later than decidedAt`,
    );
  }
}

async function assertNoSymlink(
  repositoryRoot: string,
  referencedPath: string,
): Promise<void> {
  let current = resolve(repositoryRoot);
  for (const segment of referencedPath.split("/")) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new EvidenceValidationError(
        "EvidencePathSymlink",
        `${referencedPath} traverses a symbolic link`,
      );
    }
  }
}

async function readEvidenceJson(
  input: FinalizeGraphFreezeInput,
  id: GraphFreezeEvidenceId,
  reference: GraphFreezeEvidenceReference,
): Promise<unknown> {
  if (
    !/^[a-f0-9]{64}$/u.test(reference.sha256) ||
    isAbsolute(reference.path) ||
    reference.path.includes("\\") ||
    reference.path.includes("\0") ||
    reference.path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new EvidenceValidationError(
      "EvidencePathInvalid",
      `${id} must use a hashed repository-relative path without traversal`,
    );
  }
  const releasePrefix = `artifacts/release/${input.version}/`;
  const manualPrefix = `artifacts/manual-acceptance/${input.version}/`;
  const acceptedPrefixes =
    id === "release-manifest" ? [releasePrefix] : [releasePrefix, manualPrefix];
  if (
    !acceptedPrefixes.some((prefix) => reference.path.startsWith(prefix)) ||
    (id === "release-manifest" &&
      reference.path !== `${releasePrefix}release-manifest.json`)
  ) {
    throw new EvidenceValidationError(
      "EvidencePathInvalid",
      `${id} is not at an accepted versioned evidence path`,
    );
  }
  const root = resolve(input.repositoryRoot);
  const path = resolve(input.repositoryRoot, ...reference.path.split("/"));
  const relativePath = relative(root, path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new EvidenceValidationError(
      "EvidencePathInvalid",
      `${id} resolves outside the repository root`,
    );
  }
  await assertNoSymlink(root, reference.path);
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  const canonicalRelative = relative(canonicalRoot, canonical);
  if (
    canonicalRelative === "" ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative)
  ) {
    throw new EvidenceValidationError(
      "EvidencePathInvalid",
      `${id} canonical path escapes the repository root`,
    );
  }
  const bytes = await readFile(path);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== reference.sha256) {
    throw new EvidenceValidationError(
      "EvidenceHashMismatch",
      `${id} expected ${reference.sha256} but found ${actualHash}`,
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new EvidenceValidationError(
      "EvidenceJsonInvalid",
      `${id} is not valid JSON: ${errorMessage(error)}`,
    );
  }
}

function validateCandidateMigrationEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): void {
  const evidence = asRecord(value, "candidate migration evidence");
  assertKeys(
    evidence,
    [
      "schemaVersion",
      "repository",
      "version",
      "commit",
      "generatedAt",
      "evidenceClass",
      "inventory",
      "report",
    ],
    "candidate migration evidence",
  );
  if (
    evidence["schemaVersion"] !== "qualigence-observation-migration-evidence/v1"
  ) {
    throw new EvidenceValidationError(
      "EvidenceSchemaVersionInvalid",
      "candidate migration evidence has an unsupported schema version",
    );
  }
  assertBinding(evidence, input, "candidate migration evidence");
  const inventory = requireArray(
    evidence,
    "inventory",
    "candidate migration evidence",
  );
  if (inventory.length === 0) {
    throw new EvidenceValidationError(
      "MigrationInventoryInvalid",
      "candidate migration inventory must contain every active pre-v1 asset",
    );
  }
  const inventoryByIdentity = new Map<string, "observation" | "skill">();
  for (const [index, value] of inventory.entries()) {
    const item = asRecord(value, `candidate migration inventory ${index}`);
    assertKeys(
      item,
      ["assetId", "assetKind", "sourceHash", "active"],
      `candidate migration inventory ${index}`,
    );
    const assetId = requireString(
      item,
      "assetId",
      `candidate migration inventory ${index}`,
    );
    const sourceHash = requireString(
      item,
      "sourceHash",
      `candidate migration inventory ${index}`,
    );
    const assetKind = item["assetKind"];
    const identity = `${assetId}\0${sourceHash}`;
    if (
      (assetKind !== "observation" && assetKind !== "skill") ||
      item["active"] !== true ||
      !/^[a-f0-9]{64}$/u.test(sourceHash)
    ) {
      throw new EvidenceValidationError(
        "MigrationInventoryInvalid",
        `${assetId} is not an active hash-bound Trace or Skill inventory item`,
      );
    }
    if (inventoryByIdentity.has(identity)) {
      throw new EvidenceValidationError(
        "EvidenceDuplicate",
        `candidate migration inventory ${identity} is duplicated`,
      );
    }
    inventoryByIdentity.set(identity, assetKind);
  }
  const report = asRecord(evidence["report"], "candidate migration report");
  if (
    report["version"] !== OBSERVATION_FREEZE_REPORT_VERSION ||
    report["graphSchemaVersion"] !== OBSERVATION_GRAPH_V1_VERSION ||
    report["migratorVersion"] !== OBSERVATION_MIGRATOR_VERSION ||
    report["status"] !== "candidate"
  ) {
    throw new EvidenceValidationError(
      "MigrationReportVersionInvalid",
      "candidate migration report versions or lifecycle are invalid",
    );
  }
  const results = requireArray(report, "results", "candidate migration report");
  const seen = new Set<string>();
  const classifiedInventory = new Set<string>();
  const counts = {
    migrated: 0,
    deprecated: 0,
    needs_human: 0,
    failed: 0,
  };
  for (const [index, value] of results.entries()) {
    const result = asRecord(value, `candidate migration result ${index}`);
    const assetId = requireString(
      result,
      "assetId",
      `candidate migration result ${index}`,
    );
    const sourceHash = requireString(
      result,
      "sourceHash",
      `candidate migration result ${index}`,
    );
    const migratorVersion = requireString(
      result,
      "migratorVersion",
      `candidate migration result ${index}`,
    );
    const inventoryIdentity = `${assetId}\0${sourceHash}`;
    const identity = `${assetId}\0${sourceHash}\0${migratorVersion}`;
    if (seen.has(identity) || classifiedInventory.has(inventoryIdentity)) {
      throw new EvidenceValidationError(
        "EvidenceDuplicate",
        `candidate migration result ${identity} is duplicated`,
      );
    }
    seen.add(identity);
    classifiedInventory.add(inventoryIdentity);
    const assetKind = inventoryByIdentity.get(inventoryIdentity);
    if (
      assetKind === undefined ||
      result["assetKind"] !== assetKind ||
      !migratorVersion.startsWith(OBSERVATION_MIGRATOR_VERSION)
    ) {
      throw new EvidenceValidationError(
        "MigrationInventoryMismatch",
        `${assetId} does not match the authoritative active inventory`,
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(sourceHash)) {
      throw new EvidenceValidationError(
        "MigrationSourceHashInvalid",
        `${assetId} has an invalid source hash`,
      );
    }
    const status = result["status"];
    if (
      status !== "migrated" &&
      status !== "deprecated" &&
      status !== "needs_human" &&
      status !== "failed"
    ) {
      throw new EvidenceValidationError(
        "MigrationStatusInvalid",
        `${assetId} has no terminal classification`,
      );
    }
    counts[status] += 1;
    if (
      status === "failed" ||
      ((status === "deprecated" || status === "needs_human") &&
        (typeof result["reasonCode"] !== "string" ||
          result["reasonCode"].trim() === ""))
    ) {
      throw new EvidenceValidationError(
        "MigrationUnexplainedFailure",
        `${assetId} is failed or lacks an explained non-migrated disposition`,
      );
    }
    if (
      status === "migrated" &&
      (typeof result["outputRef"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(result["outputRef"]))
    ) {
      throw new EvidenceValidationError(
        "MigrationOutputInvalid",
        `${assetId} has no immutable migrated output hash`,
      );
    }
    if (assetKind === "skill") {
      for (const key of [
        "skillSourceHash",
        "skillAssetHash",
        "skillVersion",
        "locatorSchemaVersion",
        "skillCompilerVersion",
        "sourceTraceRefs",
      ]) {
        if (result[key] === undefined) {
          throw new EvidenceValidationError(
            "MigrationSkillProvenanceMissing",
            `${assetId} is missing ${key}`,
          );
        }
      }
      if (
        typeof result["skillSourceHash"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(result["skillSourceHash"]) ||
        typeof result["skillAssetHash"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(result["skillAssetHash"]) ||
        typeof result["skillVersion"] !== "number" ||
        !Number.isSafeInteger(result["skillVersion"]) ||
        result["skillVersion"] < 1 ||
        result["locatorSchemaVersion"] !== "semantic-locator/v1" ||
        typeof result["skillCompilerVersion"] !== "string" ||
        result["skillCompilerVersion"].trim() === "" ||
        !Array.isArray(result["sourceTraceRefs"]) ||
        result["sourceTraceRefs"].length === 0 ||
        result["sourceTraceRefs"].some(
          (reference) =>
            typeof reference !== "string" || reference.trim() === "",
        )
      ) {
        throw new EvidenceValidationError(
          "MigrationSkillProvenanceInvalid",
          `${assetId} has invalid Skill source/compiler/Trace provenance`,
        );
      }
    }
  }
  if (classifiedInventory.size !== inventoryByIdentity.size) {
    throw new EvidenceValidationError(
      "MigrationInventoryMismatch",
      "candidate migration results omit active inventory assets",
    );
  }
  const reportCounts = asRecord(report["counts"], "candidate migration counts");
  if (
    reportCounts["inventory"] !== results.length ||
    reportCounts["migrated"] !== counts.migrated ||
    reportCounts["deprecated"] !== counts.deprecated ||
    reportCounts["needsHuman"] !== counts.needs_human ||
    reportCounts["failed"] !== counts.failed
  ) {
    throw new EvidenceValidationError(
      "MigrationCountsInvalid",
      "candidate migration counts do not match serialized results",
    );
  }
  const unexplained = requireArray(
    report,
    "unexplainedFailures",
    "candidate migration report",
  );
  const gate = asRecord(report["gate"], "candidate migration gate");
  if (
    unexplained.length !== 0 ||
    gate["zeroUnexplainedFailures"] !== true ||
    gate["allAssetsClassified"] !== true ||
    gate["frozen"] !== false ||
    counts.failed !== 0
  ) {
    throw new EvidenceValidationError(
      "MigrationGateInvalid",
      "candidate migration report does not prove a complete fail-closed inventory",
    );
  }
}

function assertStringArray(
  value: unknown,
  label: string,
  options: { readonly exact?: readonly string[] } = {},
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new EvidenceValidationError(
      "EvidenceMalformed",
      `${label} must be a non-empty string array`,
    );
  }
  const values = value as string[];
  if (new Set(values).size !== values.length) {
    throw new EvidenceValidationError(
      "EvidenceDuplicate",
      `${label} contains duplicate values`,
    );
  }
  if (
    options.exact !== undefined &&
    (values.length !== options.exact.length ||
      options.exact.some((entry) => !values.includes(entry)))
  ) {
    throw new EvidenceValidationError(
      "EvidenceSetInvalid",
      `${label} does not contain the required exact values`,
    );
  }
  return values;
}

function validateConformanceTarget(
  value: unknown,
  label: string,
  desktop: boolean,
): void {
  const target = asRecord(value, label);
  assertKeys(
    target,
    [
      "status",
      "schemaVersion",
      "sharedCoreFields",
      "command",
      "artifactRefs",
      ...(desktop ? ["extensionVersion", "extensionFidelity"] : []),
    ],
    label,
  );
  if (
    target["status"] !== "passed" ||
    target["schemaVersion"] !== OBSERVATION_GRAPH_V1_VERSION
  ) {
    throw new EvidenceValidationError(
      "GraphConformanceInvalid",
      `${label} did not pass Observation Graph v1`,
    );
  }
  assertStringArray(target["sharedCoreFields"], `${label}.sharedCoreFields`, {
    exact: REQUIRED_SHARED_CORE_FIELDS,
  });
  requireString(target, "command", label);
  assertStringArray(target["artifactRefs"], `${label}.artifactRefs`);
  if (
    desktop &&
    (target["extensionVersion"] !== "uia/v1" ||
      target["extensionFidelity"] !== "lossless")
  ) {
    throw new EvidenceValidationError(
      "DesktopExtensionConformanceInvalid",
      "Desktop conformance must preserve uia/v1 losslessly",
    );
  }
}

function validateGraphConformanceEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): void {
  const evidence = asRecord(value, "Graph conformance evidence");
  assertKeys(
    evidence,
    [
      "schemaVersion",
      "repository",
      "version",
      "commit",
      "generatedAt",
      "evidenceClass",
      "web",
      "desktop",
      "capabilityNegotiation",
    ],
    "Graph conformance evidence",
  );
  if (
    evidence["schemaVersion"] !== "qualigence-graph-conformance-evidence/v1"
  ) {
    throw new EvidenceValidationError(
      "EvidenceSchemaVersionInvalid",
      "Graph conformance evidence has an unsupported schema version",
    );
  }
  assertBinding(evidence, input, "Graph conformance evidence");
  validateConformanceTarget(evidence["web"], "Graph conformance web", false);
  validateConformanceTarget(
    evidence["desktop"],
    "Graph conformance desktop",
    true,
  );
  const negotiation = asRecord(
    evidence["capabilityNegotiation"],
    "Graph capability negotiation",
  );
  assertKeys(
    negotiation,
    ["status", "incompatibleGraphMajor", "incompatibleExtensionMajor"],
    "Graph capability negotiation",
  );
  if (
    negotiation["status"] !== "passed" ||
    negotiation["incompatibleGraphMajor"] !== "rejected" ||
    negotiation["incompatibleExtensionMajor"] !== "rejected"
  ) {
    throw new EvidenceValidationError(
      "GraphCapabilityNegotiationInvalid",
      "incompatible Graph and extension majors must be rejected",
    );
  }
}

const REQUIRED_NATIVE_REPORTS = new Map([
  ["ticket-29-named-pipe", "qualigence-windows-named-pipe-authority/v1"],
  ["ticket-30-uia-companion", "qualigence-windows-uia-daemon-harness/v1"],
]);

function validateNativeReportsEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): void {
  const evidence = asRecord(value, "native reports evidence");
  assertKeys(
    evidence,
    [
      "schemaVersion",
      "repository",
      "version",
      "commit",
      "generatedAt",
      "evidenceClass",
      "reports",
    ],
    "native reports evidence",
  );
  if (evidence["schemaVersion"] !== "qualigence-native-reports-evidence/v1") {
    throw new EvidenceValidationError(
      "EvidenceSchemaVersionInvalid",
      "native reports evidence has an unsupported schema version",
    );
  }
  assertBinding(evidence, input, "native reports evidence");
  const reports = requireArray(evidence, "reports", "native reports evidence");
  if (reports.length !== REQUIRED_NATIVE_REPORTS.size) {
    throw new EvidenceValidationError(
      "NativeReportMissing",
      "both Ticket 29 and Ticket 30 native reports are required",
    );
  }
  const seen = new Set<string>();
  for (const [index, value] of reports.entries()) {
    const report = asRecord(value, `native report ${index}`);
    assertKeys(
      report,
      [
        "name",
        "reportSchemaVersion",
        "environment",
        "status",
        "command",
        "artifactRefs",
      ],
      `native report ${index}`,
    );
    const name = requireString(report, "name", `native report ${index}`);
    if (seen.has(name)) {
      throw new EvidenceValidationError(
        "EvidenceDuplicate",
        `native report ${name} is duplicated`,
      );
    }
    seen.add(name);
    if (
      REQUIRED_NATIVE_REPORTS.get(name) !== report["reportSchemaVersion"] ||
      report["environment"] !== "windows-11-native" ||
      report["status"] !== "passed"
    ) {
      throw new EvidenceValidationError(
        "NativeReportInvalid",
        `${name} is not a passing native Windows 11 report`,
      );
    }
    requireString(report, "command", `native report ${name}`);
    assertStringArray(
      report["artifactRefs"],
      `native report ${name}.artifactRefs`,
    );
  }
  for (const name of REQUIRED_NATIVE_REPORTS.keys()) {
    if (!seen.has(name)) {
      throw new EvidenceValidationError(
        "NativeReportMissing",
        `native report ${name} is missing`,
      );
    }
  }
}

const REQUIRED_CLOSURE_ISSUES = [
  140, 145, 143, 136, 139, 138, 141, 135, 137, 144, 134, 142, 157, 147, 155,
  150, 152, 153, 156, 149, 148, 151, 146, 154, 163, 159, 160, 167, 168, 161,
  164, 158, 166, 169, 165,
] as const;

const REQUIRED_REMEDIATION_ISSUES = [
  162, 176, 172, 170, 177, 174, 173, 175, 178, 180, 179, 171,
] as const;

function requireSafeInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceValidationError(
      "EvidenceMalformed",
      `${label}.${key} must be a non-negative safe integer`,
    );
  }
  return value;
}

function requireCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new EvidenceValidationError(
      "GithubCommitInvalid",
      `${label} must be a full lowercase commit SHA`,
    );
  }
  return value;
}

function commitAncestors(
  graph: ReadonlyMap<string, readonly string[]>,
  commit: string,
): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [commit];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const parents = graph.get(current);
    if (parents === undefined) {
      throw new EvidenceValidationError(
        "GithubCommitGraphIncomplete",
        `commit graph is missing ${current}`,
      );
    }
    pending.push(...parents);
  }
  return visited;
}

function validatePullRequest(
  value: unknown,
  ticket: number,
  input: FinalizeGraphFreezeInput,
  graph: ReadonlyMap<string, readonly string[]>,
  ancestors: ReadonlySet<string>,
  seenPullRequests: Set<number>,
): void {
  const label = `Ticket ${ticket} pull request`;
  const pullRequest = asRecord(value, label);
  assertKeys(
    pullRequest,
    [
      "number",
      "url",
      "state",
      "mergedAt",
      "reviewedHead",
      "remoteHead",
      "mergeCommit",
      "changedFiles",
      "requiredChecks",
      "checks",
      "postReviewFiles",
    ],
    label,
  );
  const number = requireSafeInteger(pullRequest, "number", label);
  if (number === 0 || seenPullRequests.has(number)) {
    throw new EvidenceValidationError(
      "GithubPullRequestDuplicate",
      `${label} number is missing or duplicated`,
    );
  }
  seenPullRequests.add(number);
  if (
    pullRequest["url"] !==
      `https://github.com/${input.repository}/pull/${number}` ||
    pullRequest["state"] !== "closed" ||
    !Number.isFinite(Date.parse(requireString(pullRequest, "mergedAt", label)))
  ) {
    throw new EvidenceValidationError(
      "GithubPullRequestNotMerged",
      `${label} is not a merged pull request in ${input.repository}`,
    );
  }
  const reviewedHead = requireCommit(
    pullRequest["reviewedHead"],
    `${label}.reviewedHead`,
  );
  const remoteHead = requireCommit(
    pullRequest["remoteHead"],
    `${label}.remoteHead`,
  );
  const mergeCommit = requireCommit(
    pullRequest["mergeCommit"],
    `${label}.mergeCommit`,
  );
  if (!ancestors.has(mergeCommit)) {
    throw new EvidenceValidationError(
      "GithubCommitNotAncestor",
      `${label} merge commit is not in the selected candidate ancestry`,
    );
  }
  if (!commitAncestors(graph, mergeCommit).has(remoteHead)) {
    throw new EvidenceValidationError(
      "GithubRemoteHeadNotMerged",
      `${label} merge commit does not contain its remote head`,
    );
  }
  if (reviewedHead !== remoteHead) {
    if (!commitAncestors(graph, remoteHead).has(reviewedHead)) {
      throw new EvidenceValidationError(
        "GithubReviewedHeadMismatch",
        `${label} remote head does not descend from its reviewed head`,
      );
    }
    const postReviewFiles = assertStringArray(
      pullRequest["postReviewFiles"],
      `${label}.postReviewFiles`,
    );
    if (
      postReviewFiles.some(
        (path) =>
          !(
            path === "README.md" ||
            path.startsWith("docs/") ||
            path.startsWith(".github/ISSUE_TEMPLATE/")
          ),
      )
    ) {
      throw new EvidenceValidationError(
        "GithubReviewedHeadMismatch",
        `${label} changed code or tests after its reviewed head`,
      );
    }
  }
  assertStringArray(pullRequest["changedFiles"], `${label}.changedFiles`);
  const requiredChecks = assertStringArray(
    pullRequest["requiredChecks"],
    `${label}.requiredChecks`,
  );
  const checks = requireArray(pullRequest, "checks", label);
  if (checks.length === 0) {
    throw new EvidenceValidationError(
      "GithubCheckMissing",
      `${label} has no required check evidence`,
    );
  }
  const checkNames = new Set<string>();
  for (const [index, value] of checks.entries()) {
    const check = asRecord(value, `${label} check ${index}`);
    assertKeys(
      check,
      ["name", "conclusion", "commit"],
      `${label} check ${index}`,
    );
    const name = requireString(check, "name", `${label} check ${index}`);
    if (checkNames.has(name)) {
      throw new EvidenceValidationError(
        "GithubCheckDuplicate",
        `${label} check ${name} is duplicated`,
      );
    }
    checkNames.add(name);
    if (check["conclusion"] !== "success" || check["commit"] !== remoteHead) {
      throw new EvidenceValidationError(
        "GithubCheckInvalid",
        `${label} check ${name} is not a same-head success`,
      );
    }
  }
  if (
    checkNames.size !== requiredChecks.length ||
    requiredChecks.some((name) => !checkNames.has(name))
  ) {
    throw new EvidenceValidationError(
      "GithubCheckMissing",
      `${label} checks do not exactly cover its required check names`,
    );
  }
}

function validateGithubClosureEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): void {
  const evidence = asRecord(value, "GitHub closure evidence");
  assertKeys(
    evidence,
    [
      "schemaVersion",
      "repository",
      "version",
      "commit",
      "generatedAt",
      "evidenceClass",
      "umbrellaIssue",
      "tickets",
      "remediation",
      "integratedAcceptance",
      "commitGraph",
    ],
    "GitHub closure evidence",
  );
  if (evidence["schemaVersion"] !== "qualigence-github-closure-evidence/v1") {
    throw new EvidenceValidationError(
      "EvidenceSchemaVersionInvalid",
      "GitHub closure evidence has an unsupported schema version",
    );
  }
  assertBinding(evidence, input, "GitHub closure evidence");
  if (evidence["umbrellaIssue"] !== 67) {
    throw new EvidenceValidationError(
      "GithubUmbrellaMismatch",
      "GitHub closure evidence must be rooted at Issue #67",
    );
  }
  const graphEntries = requireArray(
    evidence,
    "commitGraph",
    "GitHub closure evidence",
  );
  const graph = new Map<string, readonly string[]>();
  for (const [index, value] of graphEntries.entries()) {
    const entry = asRecord(value, `GitHub commit graph entry ${index}`);
    assertKeys(entry, ["sha", "parents"], `GitHub commit graph entry ${index}`);
    const sha = requireCommit(
      entry["sha"],
      `GitHub commit graph entry ${index}.sha`,
    );
    if (graph.has(sha)) {
      throw new EvidenceValidationError(
        "GithubCommitDuplicate",
        `commit graph contains duplicate ${sha}`,
      );
    }
    const parents = requireArray(
      entry,
      "parents",
      `GitHub commit graph entry ${index}`,
    ).map((parent, parentIndex) =>
      requireCommit(
        parent,
        `GitHub commit graph entry ${index}.parents[${parentIndex}]`,
      ),
    );
    if (new Set(parents).size !== parents.length) {
      throw new EvidenceValidationError(
        "GithubCommitDuplicate",
        `commit graph entry ${sha} contains duplicate parents`,
      );
    }
    graph.set(sha, parents);
  }
  const ancestors = commitAncestors(graph, input.commit);
  const tickets = requireArray(evidence, "tickets", "GitHub closure evidence");
  if (tickets.length !== REQUIRED_CLOSURE_ISSUES.length) {
    throw new EvidenceValidationError(
      "GithubTicketMissing",
      "GitHub closure evidence must include legacy Tickets 01-35 exactly once",
    );
  }
  const seenTickets = new Set<number>();
  const seenPullRequests = new Set<number>();
  for (const value of tickets) {
    const ticket = asRecord(value, "GitHub closure ticket");
    assertKeys(
      ticket,
      ["legacyTicket", "issue", "pullRequest"],
      "GitHub closure ticket",
    );
    const legacyTicket = requireSafeInteger(
      ticket,
      "legacyTicket",
      "GitHub closure ticket",
    );
    if (
      legacyTicket < 1 ||
      legacyTicket > 35 ||
      seenTickets.has(legacyTicket)
    ) {
      throw new EvidenceValidationError(
        "GithubTicketDuplicate",
        `legacy Ticket ${legacyTicket} is invalid or duplicated`,
      );
    }
    seenTickets.add(legacyTicket);
    const issue = asRecord(
      ticket["issue"],
      `legacy Ticket ${legacyTicket} issue`,
    );
    assertKeys(
      issue,
      [
        "number",
        "parentIssue",
        "state",
        "status",
        "todoTotal",
        "todoCompleted",
        "blockedBy",
      ],
      `legacy Ticket ${legacyTicket} issue`,
    );
    if (
      issue["number"] !== REQUIRED_CLOSURE_ISSUES[legacyTicket - 1] ||
      issue["parentIssue"] !== 67 ||
      (issue["state"] !== "closed" && issue["status"] !== "superseded") ||
      (issue["status"] !== "resolved" && issue["status"] !== "superseded")
    ) {
      throw new EvidenceValidationError(
        "GithubTicketStatusInvalid",
        `legacy Ticket ${legacyTicket} has inconsistent issue identity or status`,
      );
    }
    const todoTotal = requireSafeInteger(
      issue,
      "todoTotal",
      `legacy Ticket ${legacyTicket} issue`,
    );
    const todoCompleted = requireSafeInteger(
      issue,
      "todoCompleted",
      `legacy Ticket ${legacyTicket} issue`,
    );
    if (todoTotal === 0 || todoCompleted !== todoTotal) {
      throw new EvidenceValidationError(
        "GithubTicketTodoIncomplete",
        `legacy Ticket ${legacyTicket} has incomplete tracked work`,
      );
    }
    const blockedBy = requireArray(
      issue,
      "blockedBy",
      `legacy Ticket ${legacyTicket} issue`,
    ).map((dependency) => {
      if (
        typeof dependency !== "number" ||
        !Number.isSafeInteger(dependency) ||
        dependency < 1 ||
        dependency >= legacyTicket
      ) {
        throw new EvidenceValidationError(
          "GithubTicketDependencyInvalid",
          `legacy Ticket ${legacyTicket} has an invalid dependency`,
        );
      }
      return dependency;
    });
    if (legacyTicket > 1 && blockedBy.length === 0) {
      throw new EvidenceValidationError(
        "GithubTicketDependencyInvalid",
        `legacy Ticket ${legacyTicket} has no recorded dependency`,
      );
    }
    if (new Set(blockedBy).size !== blockedBy.length) {
      throw new EvidenceValidationError(
        "GithubTicketDependencyInvalid",
        `legacy Ticket ${legacyTicket} has duplicate dependencies`,
      );
    }
    if (issue["status"] === "resolved") {
      if (ticket["pullRequest"] === undefined) {
        throw new EvidenceValidationError(
          "GithubPullRequestNotMerged",
          `resolved legacy Ticket ${legacyTicket} has no merged pull request`,
        );
      }
      validatePullRequest(
        ticket["pullRequest"],
        legacyTicket,
        input,
        graph,
        ancestors,
        seenPullRequests,
      );
    } else if (ticket["pullRequest"] !== undefined) {
      validatePullRequest(
        ticket["pullRequest"],
        legacyTicket,
        input,
        graph,
        ancestors,
        seenPullRequests,
      );
    }
  }
  for (let legacyTicket = 1; legacyTicket <= 35; legacyTicket += 1) {
    if (!seenTickets.has(legacyTicket)) {
      throw new EvidenceValidationError(
        "GithubTicketMissing",
        `legacy Ticket ${legacyTicket} is missing`,
      );
    }
  }

  const remediation = requireArray(
    evidence,
    "remediation",
    "GitHub closure evidence",
  );
  if (remediation.length !== REQUIRED_REMEDIATION_ISSUES.length) {
    throw new EvidenceValidationError(
      "GithubRemediationMissing",
      "Tickets 36-47 must each be classified",
    );
  }
  const seenRemediation = new Set<number>();
  for (const value of remediation) {
    const item = asRecord(value, "GitHub remediation ticket");
    assertKeys(
      item,
      [
        "legacyTicket",
        "issue",
        "classification",
        "parentLegacyTicket",
        "blocking",
      ],
      "GitHub remediation ticket",
    );
    const legacyTicket = requireSafeInteger(
      item,
      "legacyTicket",
      "GitHub remediation ticket",
    );
    if (
      legacyTicket < 36 ||
      legacyTicket > 47 ||
      seenRemediation.has(legacyTicket)
    ) {
      throw new EvidenceValidationError(
        "GithubRemediationDuplicate",
        `legacy remediation Ticket ${legacyTicket} is invalid or duplicated`,
      );
    }
    seenRemediation.add(legacyTicket);
    const issue = asRecord(
      item["issue"],
      `legacy Ticket ${legacyTicket} issue`,
    );
    assertKeys(
      issue,
      ["number", "parentIssue", "state", "status"],
      `legacy Ticket ${legacyTicket} issue`,
    );
    const classification = item["classification"];
    if (
      issue["number"] !== REQUIRED_REMEDIATION_ISSUES[legacyTicket - 36] ||
      issue["parentIssue"] !== 67 ||
      (classification !== "resolved-remediation" &&
        classification !== "deferred-advanced-hardening" &&
        classification !== "superseded") ||
      item["blocking"] !== false ||
      typeof item["parentLegacyTicket"] !== "number" ||
      item["parentLegacyTicket"] < 1 ||
      item["parentLegacyTicket"] > 35
    ) {
      throw new EvidenceValidationError(
        "GithubRemediationInvalid",
        `legacy Ticket ${legacyTicket} has an invalid classification`,
      );
    }
    if (
      (classification === "resolved-remediation" &&
        (issue["state"] !== "closed" || issue["status"] !== "resolved")) ||
      (classification === "superseded" && issue["status"] !== "superseded")
    ) {
      throw new EvidenceValidationError(
        "GithubRemediationStatusInvalid",
        `legacy Ticket ${legacyTicket} status contradicts its classification`,
      );
    }
  }

  const integratedAcceptance = asRecord(
    evidence["integratedAcceptance"],
    "integrated Ticket 48 evidence",
  );
  assertKeys(
    integratedAcceptance,
    ["legacyTicket", "issue", "authority", "blocking"],
    "integrated Ticket 48 evidence",
  );
  const integratedIssue = asRecord(
    integratedAcceptance["issue"],
    "integrated Ticket 48 issue",
  );
  assertKeys(
    integratedIssue,
    ["number", "parentIssue", "state", "status", "blockedBy"],
    "integrated Ticket 48 issue",
  );
  const integratedBlockedBy = requireArray(
    integratedIssue,
    "blockedBy",
    "integrated Ticket 48 issue",
  );
  if (
    integratedAcceptance["legacyTicket"] !== 48 ||
    integratedIssue["number"] !== 181 ||
    integratedIssue["parentIssue"] !== 67 ||
    integratedIssue["state"] !== "open" ||
    integratedIssue["status"] !== "claimed" ||
    integratedBlockedBy.length !== 1 ||
    integratedBlockedBy[0] !== 35 ||
    integratedAcceptance["authority"] !== "integrated-human-acceptance" ||
    integratedAcceptance["blocking"] !== false
  ) {
    throw new EvidenceValidationError(
      "GithubIntegratedAcceptanceInvalid",
      "Ticket 48 must remain the claimed, non-substitutable final acceptance authority blocked by Ticket 35",
    );
  }
}

function requirePositiveInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new EvidenceValidationError(
      "EvidenceMalformed",
      `${label}.${key} must be a positive integer`,
    );
  }
  return value;
}

function validateProviderEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): void {
  const evidence = asRecord(value, "provider evidence");
  assertKeys(
    evidence,
    [
      "schemaVersion",
      "repository",
      "version",
      "commit",
      "generatedAt",
      "evidenceClass",
      "environment",
      "provider",
      "result",
      "invocations",
    ],
    "provider evidence",
  );
  if (evidence["schemaVersion"] !== "qualigence-provider-evidence/v1") {
    throw new EvidenceValidationError(
      "EvidenceSchemaVersionInvalid",
      "provider evidence has an unsupported schema version",
    );
  }
  assertBinding(evidence, input, "provider evidence");

  const environment = asRecord(
    evidence["environment"],
    "provider evidence.environment",
  );
  assertKeys(
    environment,
    ["source", "redacted", "credentialVariables"],
    "provider evidence.environment",
  );
  if (
    environment["source"] !== "ticket-48" ||
    environment["redacted"] !== true
  ) {
    throw new EvidenceValidationError(
      "ProviderEnvironmentInvalid",
      "provider evidence must be redacted Ticket 48 evidence",
    );
  }
  const credentialVariables = assertStringArray(
    environment["credentialVariables"],
    "provider evidence.environment.credentialVariables",
  );
  if (credentialVariables.length === 0) {
    throw new EvidenceValidationError(
      "ProviderEnvironmentInvalid",
      "provider evidence must identify its redacted credential variables",
    );
  }

  const provider = asRecord(evidence["provider"], "provider evidence.provider");
  assertKeys(provider, ["id", "model"], "provider evidence.provider");
  requireString(provider, "id", "provider evidence.provider");
  requireString(provider, "model", "provider evidence.provider");

  const result = asRecord(evidence["result"], "provider evidence.result");
  assertKeys(result, ["status", "terminal"], "provider evidence.result");
  if (result["status"] !== "succeeded" || result["terminal"] !== true) {
    throw new EvidenceValidationError(
      "ProviderResultInvalid",
      "provider evidence must contain a successful terminal result",
    );
  }

  const invocations = requireArray(
    evidence,
    "invocations",
    "provider evidence",
  );
  if (invocations.length === 0) {
    throw new EvidenceValidationError(
      "ProviderInvocationMissing",
      "provider evidence must contain at least one invocation",
    );
  }
  const seen = new Set<string>();
  for (const [index, value] of invocations.entries()) {
    const label = `provider invocation ${index}`;
    const invocation = asRecord(value, label);
    assertKeys(
      invocation,
      [
        "invocationId",
        "status",
        "usageStatus",
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "providerRequestId",
      ],
      label,
    );
    const invocationId = requireString(invocation, "invocationId", label);
    if (seen.has(invocationId)) {
      throw new EvidenceValidationError(
        "EvidenceDuplicate",
        `provider invocation ${invocationId} is duplicated`,
      );
    }
    seen.add(invocationId);
    const inputTokens = requirePositiveInteger(
      invocation,
      "inputTokens",
      label,
    );
    const outputTokens = requirePositiveInteger(
      invocation,
      "outputTokens",
      label,
    );
    const totalTokens = requirePositiveInteger(
      invocation,
      "totalTokens",
      label,
    );
    if (
      invocation["status"] !== "succeeded" ||
      invocation["usageStatus"] !== "known" ||
      totalTokens !== inputTokens + outputTokens
    ) {
      throw new EvidenceValidationError(
        "ProviderInvocationInvalid",
        `${label} must be successful with internally consistent known usage`,
      );
    }
    requireString(invocation, "providerRequestId", label);
  }
}

function validateBenchmarkEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): void {
  const evidence = asRecord(value, "benchmark evidence");
  assertKeys(
    evidence,
    [
      "schemaVersion",
      "repository",
      "version",
      "commit",
      "generatedAt",
      "evidenceClass",
      "manifest",
      "report",
      "attempts",
      "invocations",
    ],
    "benchmark evidence",
  );
  if (evidence["schemaVersion"] !== "qualigence-benchmark-evidence/v1") {
    throw new EvidenceValidationError(
      "EvidenceSchemaVersionInvalid",
      "benchmark evidence has an unsupported schema version",
    );
  }
  assertBinding(evidence, input, "benchmark evidence");

  const manifest = asRecord(evidence["manifest"], "benchmark manifest");
  if (manifest["schemaVersion"] !== "detection-benchmark/v1") {
    throw new EvidenceValidationError(
      "BenchmarkManifestInvalid",
      "benchmark manifest must use detection-benchmark/v1",
    );
  }
  const benchmarkVersion = requireString(
    manifest,
    "benchmarkVersion",
    "benchmark manifest",
  );
  const profile = asRecord(
    manifest["referenceProfile"],
    "benchmark reference profile",
  );
  requireString(profile, "profileId", "benchmark reference profile");
  requireString(profile, "providerId", "benchmark reference profile");
  requireString(profile, "modelId", "benchmark reference profile");
  const repetitions = requirePositiveInteger(
    profile,
    "repetitions",
    "benchmark reference profile",
  );

  const scenarios = requireArray(manifest, "scenarios", "benchmark manifest");
  if (scenarios.length === 0) {
    throw new EvidenceValidationError(
      "BenchmarkManifestInvalid",
      "benchmark manifest must contain scenarios",
    );
  }
  const scenarioIds = new Set<string>();
  for (const [index, value] of scenarios.entries()) {
    const scenarioId = requireString(
      asRecord(value, `benchmark scenario ${index}`),
      "scenarioId",
      `benchmark scenario ${index}`,
    );
    if (scenarioIds.has(scenarioId)) {
      throw new EvidenceValidationError(
        "EvidenceDuplicate",
        `benchmark scenario ${scenarioId} is duplicated`,
      );
    }
    scenarioIds.add(scenarioId);
  }

  const report = asRecord(evidence["report"], "benchmark report");
  if (
    report["benchmarkVersion"] !== benchmarkVersion ||
    report["profileStatus"] !== "reference" ||
    report["profileSha256"] !== sha256Hex(canonicalJson(profile))
  ) {
    throw new EvidenceValidationError(
      "BenchmarkReportInvalid",
      "benchmark report must hash-bind the manifest Reference Model Profile",
    );
  }
  const gate = asRecord(report["gate"], "benchmark report.gate");
  if (
    gate["status"] !== "passed" ||
    !Array.isArray(gate["failureCodes"]) ||
    gate["failureCodes"].length !== 0
  ) {
    throw new EvidenceValidationError(
      "BenchmarkGateFailed",
      "Reference Model benchmark gate did not pass",
    );
  }
  const reportAttemptIds = assertStringArray(
    report["attemptIds"],
    "benchmark report.attemptIds",
  );
  const bindingHashes = assertStringArray(
    report["attemptBindingSha256s"],
    "benchmark report.attemptBindingSha256s",
  );

  const invocations = requireArray(
    evidence,
    "invocations",
    "benchmark evidence",
  );
  const invocationIds = new Set<string>();
  for (const [index, value] of invocations.entries()) {
    const label = `benchmark invocation ${index}`;
    const invocation = asRecord(value, label);
    const invocationId = requireString(invocation, "invocationId", label);
    if (
      invocationIds.has(invocationId) ||
      invocation["status"] !== "succeeded" ||
      invocation["usageStatus"] !== "known"
    ) {
      throw new EvidenceValidationError(
        invocationIds.has(invocationId)
          ? "EvidenceDuplicate"
          : "BenchmarkInvocationInvalid",
        `${label} must be unique, successful, and carry known usage`,
      );
    }
    invocationIds.add(invocationId);
  }

  const attempts = requireArray(evidence, "attempts", "benchmark evidence");
  const expectedAttemptCount = scenarioIds.size * repetitions;
  if (
    attempts.length !== expectedAttemptCount ||
    reportAttemptIds.length !== expectedAttemptCount ||
    bindingHashes.length !== expectedAttemptCount ||
    new Set(reportAttemptIds).size !== expectedAttemptCount ||
    new Set(bindingHashes).size !== expectedAttemptCount ||
    bindingHashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))
  ) {
    throw new EvidenceValidationError(
      "BenchmarkAttemptMatrixIncomplete",
      "benchmark report does not contain the complete unique attempt matrix",
    );
  }
  const seenSlots = new Set<string>();
  const seenAttemptIds = new Set<string>();
  for (const [index, value] of attempts.entries()) {
    const label = `benchmark attempt ${index}`;
    const attempt = asRecord(value, label);
    const attemptId = requireString(attempt, "attemptId", label);
    const scenarioId = requireString(attempt, "scenarioId", label);
    const repetition = requirePositiveInteger(attempt, "repetition", label);
    const attemptInvocationIds = assertStringArray(
      attempt["invocationIds"],
      `${label}.invocationIds`,
    );
    const slot = `${scenarioId}\u0000${repetition}`;
    if (
      !scenarioIds.has(scenarioId) ||
      repetition > repetitions ||
      seenSlots.has(slot) ||
      seenAttemptIds.has(attemptId) ||
      !reportAttemptIds.includes(attemptId) ||
      attemptInvocationIds.length === 0 ||
      attemptInvocationIds.some(
        (invocationId) => !invocationIds.has(invocationId),
      )
    ) {
      throw new EvidenceValidationError(
        "BenchmarkAttemptMatrixIncomplete",
        `${label} is not a unique, complete, invocation-bound matrix entry`,
      );
    }
    seenSlots.add(slot);
    seenAttemptIds.add(attemptId);
  }
}

interface ReleaseManifestEvaluation {
  readonly signoff: NonNullable<GraphFreezeDecisionV1["signoff"]>;
  readonly windowsEvidence: readonly GraphFreezeEvidenceReference[];
  readonly requiredCiEvidence: readonly GraphFreezeEvidenceReference[];
  readonly supplyChainEvidence: readonly GraphFreezeEvidenceReference[];
}

function manifestReference(
  value: unknown,
  label: string,
): GraphFreezeEvidenceReference {
  const record = asRecord(value, label);
  const path = requireString(record, "path", label);
  const sha256 = requireString(record, "sha256", label);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new EvidenceValidationError(
      "EvidenceHashInvalid",
      `${label}.sha256 must be lowercase SHA-256`,
    );
  }
  return { path, sha256 };
}

async function assertManifestPathConfined(
  input: FinalizeGraphFreezeInput,
  reference: GraphFreezeEvidenceReference,
  label: string,
  acceptedPrefixes: readonly string[],
): Promise<void> {
  if (
    isAbsolute(reference.path) ||
    reference.path.includes("\\") ||
    reference.path.includes("\0") ||
    reference.path
      .split("/")
      .some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) ||
    !acceptedPrefixes.some((prefix) => reference.path.startsWith(prefix))
  ) {
    throw new EvidenceValidationError(
      "EvidencePathInvalid",
      `${label} is not at an accepted confined versioned path`,
    );
  }
  const root = resolve(input.repositoryRoot);
  const path = resolve(root, ...reference.path.split("/"));
  const relativePath = relative(root, path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new EvidenceValidationError(
      "EvidencePathInvalid",
      `${label} escapes the repository root`,
    );
  }
  await assertNoSymlink(root, reference.path);
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  const canonicalRelative = relative(canonicalRoot, canonicalPath);
  if (
    canonicalRelative === "" ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelative)
  ) {
    throw new EvidenceValidationError(
      "EvidencePathInvalid",
      `${label} canonically escapes the repository root`,
    );
  }
}

function windowsChecklistPayload(bytes: Buffer): Record<string, unknown> {
  const candidates: unknown[] = [];
  const text = bytes.toString("utf8");
  try {
    candidates.push(JSON.parse(text));
  } catch {
    for (const match of text.matchAll(
      /```(?:json|jsonc)?\s*([\s\S]*?)```/giu,
    )) {
      try {
        candidates.push(JSON.parse(match[1] ?? ""));
      } catch {
        // Non-JSON examples in the signed checklist are not evidence payloads.
      }
    }
  }
  for (const candidate of candidates) {
    const record = asRecord(candidate, "signed Windows evidence");
    const nested =
      record["WindowsChecklistEvidence"] ?? record["windowsChecklistEvidence"];
    if (nested !== undefined) {
      return asRecord(nested, "WindowsChecklistEvidence");
    }
    if (record["checklistVersion"] !== undefined) {
      return record;
    }
  }
  throw new EvidenceValidationError(
    "WindowsChecklistEvidenceUnavailable",
    "signed Windows evidence has no machine-readable checklist payload",
  );
}

function verifierErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = String(error.stderr);
    const match = /^([A-Za-z][A-Za-z0-9]+):/mu.exec(stderr);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return "ReleaseManifestVerificationFailed";
}

function releaseVerifierEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (environment["NODE_ENV"] !== "test" || environment["VITEST"] !== "true") {
    delete environment["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"];
  }
  return environment;
}

async function validateReleaseManifestEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
  manifestPath: string,
  manifestReferenceValue: GraphFreezeEvidenceReference,
): Promise<ReleaseManifestEvaluation> {
  const manifest = asRecord(value, "release manifest");
  if (manifest["schemaVersion"] !== "qualigence-release-manifest/v1") {
    throw new EvidenceValidationError(
      "ManifestSchemaVersionInvalid",
      "release manifest has an unsupported schema version",
    );
  }
  if (manifest["repository"] !== input.repository) {
    throw new EvidenceValidationError(
      "EvidenceRepositoryMismatch",
      `release manifest does not bind ${input.repository}`,
    );
  }
  if (manifest["version"] !== input.version) {
    throw new EvidenceValidationError(
      "EvidenceVersionMismatch",
      `release manifest does not bind ${input.version}`,
    );
  }
  if (manifest["commit"] !== input.commit) {
    throw new EvidenceValidationError(
      "EvidenceCommitMismatch",
      `release manifest does not bind ${input.commit}`,
    );
  }
  const generatedAt = requireString(
    manifest,
    "generatedAt",
    "release manifest",
  );
  if (
    !Number.isFinite(Date.parse(generatedAt)) ||
    Date.parse(generatedAt) > Date.parse(input.decidedAt)
  ) {
    throw new EvidenceValidationError(
      "EvidenceStale",
      "release manifest.generatedAt must be valid and no later than decidedAt",
    );
  }

  const verifierPath = join(
    input.repositoryRoot,
    "scripts",
    "verify-release-manifest.mjs",
  );
  try {
    await execFileAsync(
      process.execPath,
      [
        verifierPath,
        "verify",
        "--manifest",
        manifestPath,
        "--repository",
        input.repository,
        "--commit",
        input.commit,
      ],
      {
        cwd: input.repositoryRoot,
        env: releaseVerifierEnvironment(),
        maxBuffer: 4 * 1024 * 1024,
        signal: input.signal,
        timeout: 120_000,
      },
    );
  } catch (error) {
    if (
      input.signal?.aborted === true ||
      (typeof error === "object" &&
        error !== null &&
        "killed" in error &&
        error.killed === true)
    ) {
      throw new GraphFreezeFinalizationError(
        "FinalizationAborted",
        input.signal?.aborted === true
          ? "Graph freeze finalization was cancelled during release verification"
          : "Graph freeze finalization timed out during release verification",
      );
    }
    throw new EvidenceValidationError(
      verifierErrorCode(error),
      `Ticket 34 release-manifest verification failed: ${errorMessage(error)}`,
    );
  }

  const windows = asRecord(
    manifest["windowsEvidence"],
    "release manifest.windowsEvidence",
  );
  const windowsReference = manifestReference(
    windows,
    "release manifest.windowsEvidence",
  );
  const windowsPath = resolve(
    input.repositoryRoot,
    ...windowsReference.path.split("/"),
  );
  const checklist = windowsChecklistPayload(await readFile(windowsPath));
  const productVersion = requireString(
    checklist,
    "productVersion",
    "WindowsChecklistEvidence",
  );
  if (productVersion !== input.version) {
    throw new EvidenceValidationError(
      "EvidenceVersionMismatch",
      "Windows checklist does not bind the selected release version",
    );
  }

  const sbomReference = manifestReference(
    manifest["sbom"],
    "release manifest.sbom",
  );
  const gates = requireArray(manifest, "gates", "release manifest");
  const gateReferences = gates.map((value, index) => {
    const gate = asRecord(value, `release manifest.gates[${index}]`);
    return {
      path: requireString(
        gate,
        "artifactPath",
        `release manifest.gates[${index}]`,
      ),
      sha256: requireString(
        gate,
        "artifactSha256",
        `release manifest.gates[${index}]`,
      ),
    };
  });
  const releasePrefix = `artifacts/release/${input.version}/`;
  await assertManifestPathConfined(
    input,
    windowsReference,
    "release manifest.windowsEvidence",
    [releasePrefix, `artifacts/manual-acceptance/${input.version}/`],
  );
  await assertManifestPathConfined(
    input,
    sbomReference,
    "release manifest.sbom",
    [releasePrefix],
  );
  await Promise.all(
    gateReferences.map((reference, index) =>
      assertManifestPathConfined(
        input,
        reference,
        `release manifest.gates[${index}]`,
        [releasePrefix],
      ),
    ),
  );

  return {
    signoff: {
      operatorName: requireString(
        checklist,
        "operatorName",
        "WindowsChecklistEvidence",
      ),
      reviewerName: requireString(
        checklist,
        "reviewerName",
        "WindowsChecklistEvidence",
      ),
      executedAt: requireString(
        checklist,
        "executedAt",
        "WindowsChecklistEvidence",
      ),
      checklistVersion: requireString(
        checklist,
        "checklistVersion",
        "WindowsChecklistEvidence",
      ),
      productVersion,
      windowsBuild: requireString(
        checklist,
        "windowsBuild",
        "WindowsChecklistEvidence",
      ),
    },
    windowsEvidence: [manifestReferenceValue, windowsReference],
    requiredCiEvidence: [manifestReferenceValue, ...gateReferences],
    supplyChainEvidence: [manifestReferenceValue, sbomReference],
  };
}

function replaceCapability(
  capabilities: GraphFreezeCapabilityDecision[],
  id: GraphFreezeCapabilityDecision["id"],
  update: Pick<
    GraphFreezeCapabilityDecision,
    "status" | "evidence" | "blockers"
  >,
): void {
  const index = capabilities.findIndex((capability) => capability.id === id);
  const existing = capabilities[index];
  if (index < 0 || existing === undefined) {
    throw new GraphFreezeFinalizationError(
      "FinalizerInputInvalid",
      `unknown capability ${id}`,
    );
  }
  capabilities[index] = { ...existing, ...update };
}

function duplicateEvidenceReference(
  input: FinalizeGraphFreezeInput,
  reference: GraphFreezeEvidenceReference,
): boolean {
  return (
    Object.values(input.evidence).filter(
      (candidate) => candidate?.path === reference.path,
    ).length > 1
  );
}

interface EvidenceEvaluation {
  readonly capabilities: GraphFreezeCapabilityDecision[];
  readonly signoff?: GraphFreezeDecisionV1["signoff"];
}

async function evaluateEvidence(
  input: FinalizeGraphFreezeInput,
): Promise<EvidenceEvaluation> {
  const capabilities = missingCapabilities(input);
  await evaluateReference(
    input,
    capabilities,
    "candidate-migration",
    input.evidence.candidateMigration,
    validateCandidateMigrationEvidence,
  );
  await evaluateReference(
    input,
    capabilities,
    "github-closure",
    input.evidence.githubClosure,
    validateGithubClosureEvidence,
  );
  await evaluateReference(
    input,
    capabilities,
    "graph-conformance",
    input.evidence.graphConformance,
    validateGraphConformanceEvidence,
  );
  await evaluateReference(
    input,
    capabilities,
    "native-reports",
    input.evidence.nativeReports,
    validateNativeReportsEvidence,
  );
  await evaluateReference(
    input,
    capabilities,
    "provider",
    input.evidence.provider,
    validateProviderEvidence,
  );
  await evaluateReference(
    input,
    capabilities,
    "benchmark",
    input.evidence.benchmark,
    validateBenchmarkEvidence,
  );
  try {
    await reconcileProviderBenchmarkIdentity(input, capabilities);
  } catch (error) {
    if (error instanceof GraphFreezeFinalizationError) {
      throw error;
    }
    const code =
      error instanceof EvidenceValidationError
        ? error.code
        : "EvidenceReadFailed";
    for (const [id, reference] of [
      ["provider", input.evidence.provider],
      ["benchmark", input.evidence.benchmark],
    ] as const) {
      if (reference !== undefined) {
        replaceCapability(capabilities, id, {
          status: "blocked",
          evidence: [reference],
          blockers: [`${code}: ${id}`],
        });
      }
    }
  }
  const releaseReference = input.evidence.releaseManifest;
  if (releaseReference === undefined) {
    return { capabilities };
  }
  if (duplicateEvidenceReference(input, releaseReference)) {
    for (const id of [
      "release-manifest",
      "windows-checklist",
      "required-ci",
      "sbom-provenance",
    ] as const) {
      replaceCapability(capabilities, id, {
        status: "blocked",
        evidence: [releaseReference],
        blockers: [`EvidenceDuplicate: ${id}`],
      });
    }
    return { capabilities };
  }
  try {
    const value = await readEvidenceJson(
      input,
      "release-manifest",
      releaseReference,
    );
    const release = await validateReleaseManifestEvidence(
      value,
      input,
      resolve(input.repositoryRoot, ...releaseReference.path.split("/")),
      releaseReference,
    );
    replaceCapability(capabilities, "release-manifest", {
      status: "verified",
      evidence: [releaseReference],
      blockers: [],
    });
    replaceCapability(capabilities, "windows-checklist", {
      status: "verified",
      evidence: release.windowsEvidence,
      blockers: [],
    });
    replaceCapability(capabilities, "required-ci", {
      status: "verified",
      evidence: release.requiredCiEvidence,
      blockers: [],
    });
    replaceCapability(capabilities, "sbom-provenance", {
      status: "verified",
      evidence: release.supplyChainEvidence,
      blockers: [],
    });
    return { capabilities, signoff: release.signoff };
  } catch (error) {
    if (error instanceof GraphFreezeFinalizationError) {
      throw error;
    }
    const code =
      error instanceof EvidenceValidationError
        ? error.code
        : "EvidenceReadFailed";
    for (const id of [
      "release-manifest",
      "windows-checklist",
      "required-ci",
      "sbom-provenance",
    ] as const) {
      replaceCapability(capabilities, id, {
        status: "blocked",
        evidence: [releaseReference],
        blockers: [`${code}: ${id}`],
      });
    }
    return { capabilities };
  }
}

async function evaluateReference(
  input: FinalizeGraphFreezeInput,
  capabilities: GraphFreezeCapabilityDecision[],
  id: GraphFreezeEvidenceId,
  reference: GraphFreezeEvidenceReference | undefined,
  validate: (value: unknown, input: FinalizeGraphFreezeInput) => void,
): Promise<void> {
  if (reference === undefined) {
    return;
  }
  if (duplicateEvidenceReference(input, reference)) {
    replaceCapability(capabilities, id, {
      status: "blocked",
      evidence: [reference],
      blockers: [`EvidenceDuplicate: ${id}`],
    });
    return;
  }
  try {
    const value = await readEvidenceJson(input, id, reference);
    validate(value, input);
    replaceCapability(capabilities, id, {
      status: "verified",
      evidence: [reference],
      blockers: [],
    });
  } catch (error) {
    const code =
      error instanceof EvidenceValidationError
        ? error.code
        : "EvidenceReadFailed";
    replaceCapability(capabilities, id, {
      status: "blocked",
      evidence: [reference],
      blockers: [`${code}: ${id}`],
    });
  }
}

async function reconcileProviderBenchmarkIdentity(
  input: FinalizeGraphFreezeInput,
  capabilities: GraphFreezeCapabilityDecision[],
): Promise<void> {
  const providerReference = input.evidence.provider;
  const benchmarkReference = input.evidence.benchmark;
  if (
    providerReference === undefined ||
    benchmarkReference === undefined ||
    capabilities.find((capability) => capability.id === "provider")?.status !==
      "verified" ||
    capabilities.find((capability) => capability.id === "benchmark")?.status !==
      "verified"
  ) {
    return;
  }
  const providerEvidence = asRecord(
    await readEvidenceJson(input, "provider", providerReference),
    "provider evidence",
  );
  const provider = asRecord(
    providerEvidence["provider"],
    "provider evidence.provider",
  );
  const benchmarkEvidence = asRecord(
    await readEvidenceJson(input, "benchmark", benchmarkReference),
    "benchmark evidence",
  );
  const manifest = asRecord(
    benchmarkEvidence["manifest"],
    "benchmark manifest",
  );
  const profile = asRecord(
    manifest["referenceProfile"],
    "benchmark reference profile",
  );
  if (
    provider["id"] === profile["providerId"] &&
    provider["model"] === profile["modelId"]
  ) {
    return;
  }
  for (const [id, reference] of [
    ["provider", providerReference],
    ["benchmark", benchmarkReference],
  ] as const) {
    replaceCapability(capabilities, id, {
      status: "blocked",
      evidence: [reference],
      blockers: [`ProviderBenchmarkIdentityMismatch: ${id}`],
    });
  }
}

async function publishDecision(
  path: string,
  bytes: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx" });
    abortIfRequested(signal);
    try {
      await link(temporary, path);
    } catch (error) {
      try {
        const existing = await readFile(path, "utf8");
        if (existing === bytes) {
          return;
        }
        const existingHash = createHash("sha256")
          .update(existing)
          .digest("hex");
        const expectedHash = createHash("sha256").update(bytes).digest("hex");
        throw new GraphFreezeFinalizationError(
          "DecisionArtifactConflict",
          `${path} contains ${existingHash}, not recomputed ${expectedHash}`,
        );
      } catch (reconcileError) {
        if (
          reconcileError instanceof GraphFreezeFinalizationError ||
          !hasCode(reconcileError, "ENOENT")
        ) {
          throw reconcileError;
        }
      }
      throw error;
    }
    const published = await readFile(path, "utf8");
    if (published !== bytes) {
      throw new GraphFreezeFinalizationError(
        "DecisionArtifactConflict",
        `${path} changed during terminal reconciliation`,
      );
    }
  } catch (error) {
    if (error instanceof GraphFreezeFinalizationError) {
      throw error;
    }
    throw new GraphFreezeFinalizationError(
      "DecisionArtifactWriteFailed",
      `could not atomically publish ${path}: ${errorMessage(error)}`,
    );
  } finally {
    try {
      await rm(temporary, { force: true });
    } catch (error) {
      try {
        const published = await readFile(path, "utf8");
        if (published !== bytes) {
          throw error;
        }
      } catch {
        throw new GraphFreezeFinalizationError(
          "DecisionArtifactWriteFailed",
          `could not clean terminal temporary state for ${path}: ${errorMessage(error)}`,
        );
      }
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function finalizeGraphFreezeFromEvidence(
  input: FinalizeGraphFreezeInput,
): Promise<GraphFreezeFinalizationResult> {
  validateFinalizerInput(input);
  abortIfRequested(input.signal);
  const evaluation = await evaluateEvidence(input);
  abortIfRequested(input.signal);
  const decision = graphFreezeDecision(
    input,
    evaluation.capabilities,
    evaluation.signoff,
  );
  const bytes = `${JSON.stringify(decision, null, 2)}\n`;
  const path = resolve(
    join(
      input.repositoryRoot,
      "artifacts",
      "release",
      input.version,
      "graph-freeze-decision.json",
    ),
  );
  await publishDecision(path, bytes, input.signal);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    decision,
  };
}
