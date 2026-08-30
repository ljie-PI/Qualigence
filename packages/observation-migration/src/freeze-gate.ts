import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  OBSERVATION_GRAPH_V1_VERSION,
  WEB_EXTENSION_V1_TYPE,
  observationGraphHash,
  type ObservationGraphV1,
  type ObservationNodeV1,
} from "@qualigence/observation-contracts";
import { canonicalJson, sha256Hex } from "@qualigence/skill";
import {
  OBSERVATION_FREEZE_REPORT_VERSION,
  type ObservationFreezeReportV1,
} from "./freeze-report.js";
import { OBSERVATION_MIGRATOR_VERSION } from "./pre-v1-projector.js";
import {
  GRAPH_FREEZE_DECISION_VERSION,
  GraphFreezeFinalizationError,
  REQUIRED_RUNNER_PROTOCOL_VERSION,
  REQUIRED_SHARED_CORE_FIELDS,
  REQUIRED_SECURITY_VETO_ITEM_IDS,
  REQUIRED_WINDOWS_CHECKLIST_ITEM_IDS,
  REQUIRED_WINDOWS_CHECKLIST_SECTION_COUNTS,
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
    input.version === "." ||
    input.version === ".." ||
    !/^[a-f0-9]{40}$/u.test(input.commit) ||
    !isCanonicalTimestamp(input.decidedAt) ||
    input.repositoryRoot.trim() === ""
  ) {
    throw new GraphFreezeFinalizationError(
      "FinalizerInputInvalid",
      "repository, version, commit, decidedAt, and repositoryRoot must be valid",
    );
  }
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function timestampMillis(value: string, label: string): number {
  if (!isCanonicalTimestamp(value)) {
    throw new EvidenceValidationError(
      "EvidenceStale",
      `${label} must be a canonical ISO-8601 UTC timestamp`,
    );
  }
  return Date.parse(value);
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
  const generatedTime = timestampMillis(generatedAt, `${label}.generatedAt`);
  if (generatedTime > timestampMillis(input.decidedAt, "decidedAt")) {
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

async function readEvidenceBytes(
  input: FinalizeGraphFreezeInput,
  id: GraphFreezeEvidenceId,
  reference: GraphFreezeEvidenceReference,
): Promise<Buffer> {
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
  return bytes;
}

async function readEvidenceJson(
  input: FinalizeGraphFreezeInput,
  id: GraphFreezeEvidenceId,
  reference: GraphFreezeEvidenceReference,
): Promise<unknown> {
  const bytes = await readEvidenceBytes(input, id, reference);
  return parseEvidenceJsonBytes(bytes, id);
}

function parseEvidenceJsonBytes(
  bytes: Buffer,
  id: GraphFreezeEvidenceId,
): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new EvidenceValidationError(
      "EvidenceJsonInvalid",
      `${id} is not valid JSON: ${errorMessage(error)}`,
    );
  }
}

function parseEvidenceReference(
  value: unknown,
  label: string,
): GraphFreezeEvidenceReference {
  const reference = asRecord(value, label);
  assertKeys(reference, ["path", "sha256"], label);
  return {
    path: requireString(reference, "path", label),
    sha256: requireString(reference, "sha256", label),
  };
}

async function readBoundEvidenceRecord(
  input: FinalizeGraphFreezeInput,
  id: GraphFreezeEvidenceId,
  value: unknown,
  label: string,
): Promise<{
  readonly reference: GraphFreezeEvidenceReference;
  readonly record: Record<string, unknown>;
}> {
  const reference = parseEvidenceReference(value, `${label} reference`);
  const record = asRecord(await readEvidenceJson(input, id, reference), label);
  assertBinding(record, input, label);
  return { reference, record };
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
  const generatedAt = requireString(
    report,
    "generatedAt",
    "candidate migration report",
  );
  if (
    report["version"] !== OBSERVATION_FREEZE_REPORT_VERSION ||
    report["graphSchemaVersion"] !== OBSERVATION_GRAPH_V1_VERSION ||
    report["migratorVersion"] !== OBSERVATION_MIGRATOR_VERSION ||
    report["status"] !== "candidate" ||
    timestampMillis(generatedAt, "candidate migration report.generatedAt") >
      timestampMillis(input.decidedAt, "decidedAt") ||
    timestampMillis(generatedAt, "candidate migration report.generatedAt") >
      timestampMillis(
        requireString(evidence, "generatedAt", "candidate migration evidence"),
        "candidate migration evidence.generatedAt",
      )
  ) {
    throw new EvidenceValidationError(
      "MigrationReportVersionInvalid",
      "candidate migration report versions, lifecycle, or timestamp are invalid",
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
      (assetKind === "observation" &&
        migratorVersion !== OBSERVATION_MIGRATOR_VERSION) ||
      (assetKind === "skill" &&
        migratorVersion !== `${OBSERVATION_MIGRATOR_VERSION}+skill-compiler/v1`)
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

function assertStringArrayAllowEmpty(
  value: unknown,
  label: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new EvidenceValidationError(
      "EvidenceMalformed",
      `${label} must be a string array`,
    );
  }
  const values = value as string[];
  if (new Set(values).size !== values.length) {
    throw new EvidenceValidationError(
      "EvidenceDuplicate",
      `${label} contains duplicate values`,
    );
  }
  return values;
}

async function validateConformanceTarget(
  value: unknown,
  label: string,
  desktop: boolean,
  input: FinalizeGraphFreezeInput,
): Promise<GraphFreezeEvidenceReference> {
  const { reference, record: target } = await readBoundEvidenceRecord(
    input,
    "graph-conformance",
    value,
    `${label} report`,
  );
  assertKeys(
    target,
    [
      "schemaVersion",
      "repository",
      "version",
      "commit",
      "generatedAt",
      "evidenceClass",
      "target",
      "status",
      "graphSchemaVersion",
      "sharedCoreFields",
      "command",
      ...(desktop ? ["extensionVersion", "extensionFidelity"] : []),
    ],
    label,
  );
  if (
    target["schemaVersion"] !==
      "qualigence-graph-conformance-target-report/v1" ||
    target["target"] !== (desktop ? "desktop" : "web") ||
    target["status"] !== "passed" ||
    target["graphSchemaVersion"] !== OBSERVATION_GRAPH_V1_VERSION
  ) {
    throw new EvidenceValidationError(
      "GraphConformanceInvalid",
      `${label} did not pass Observation Graph v1`,
    );
  }
  assertStringArray(target["sharedCoreFields"], `${label}.sharedCoreFields`, {
    exact: REQUIRED_SHARED_CORE_FIELDS,
  });
  const expectedCommand = desktop
    ? "corepack pnpm vitest run tests/conformance/observation/windows-uia.test.ts tests/component/windows-uia"
    : "corepack pnpm vitest run tests/conformance/observation tests/e2e/web-execution/graph-v1-producer.test.ts";
  if (target["command"] !== expectedCommand) {
    throw new EvidenceValidationError(
      "GraphConformanceInvalid",
      `${label} does not record the required conformance command`,
    );
  }
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
  return reference;
}

async function validateGraphConformanceEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): Promise<readonly GraphFreezeEvidenceReference[]> {
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
  const webReference = await validateConformanceTarget(
    evidence["web"],
    "Graph conformance web",
    false,
    input,
  );
  const desktopReference = await validateConformanceTarget(
    evidence["desktop"],
    "Graph conformance desktop",
    true,
    input,
  );
  const { reference: negotiationReference, record: negotiation } =
    await readBoundEvidenceRecord(
      input,
      "graph-conformance",
      evidence["capabilityNegotiation"],
      "Graph capability negotiation report",
    );
  assertKeys(
    negotiation,
    [
      "schemaVersion",
      "repository",
      "version",
      "commit",
      "generatedAt",
      "evidenceClass",
      "status",
      "incompatibleGraphMajor",
      "incompatibleExtensionMajor",
    ],
    "Graph capability negotiation",
  );
  if (
    negotiation["schemaVersion"] !==
      "qualigence-graph-capability-negotiation-report/v1" ||
    negotiation["status"] !== "passed" ||
    negotiation["incompatibleGraphMajor"] !== "rejected" ||
    negotiation["incompatibleExtensionMajor"] !== "rejected"
  ) {
    throw new EvidenceValidationError(
      "GraphCapabilityNegotiationInvalid",
      "incompatible Graph and extension majors must be rejected",
    );
  }
  const references = [webReference, desktopReference, negotiationReference];
  if (new Set(references.map((reference) => reference.path)).size !== 3) {
    throw new EvidenceValidationError(
      "EvidenceDuplicate",
      "Graph conformance reports must use distinct evidence paths",
    );
  }
  return references;
}

const REQUIRED_NATIVE_REPORTS = new Map([
  [
    "ticket-29-named-pipe",
    {
      schemaVersion: "qualigence-windows-named-pipe-authority/v1",
      command:
        "corepack pnpm vitest run tests/e2e/windows/named-pipe-authority.test.ts",
    },
  ],
  [
    "ticket-30-uia-companion",
    {
      schemaVersion: "qualigence-windows-uia-daemon-harness/v1",
      command:
        "corepack pnpm vitest run tests/e2e/windows/companion-daemon.test.ts",
    },
  ],
]);

async function validateNativeReportsEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): Promise<readonly GraphFreezeEvidenceReference[]> {
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
  const references: GraphFreezeEvidenceReference[] = [];
  for (const [index, value] of reports.entries()) {
    const entry = asRecord(value, `native report reference ${index}`);
    assertKeys(entry, ["name", "report"], `native report reference ${index}`);
    const name = requireString(
      entry,
      "name",
      `native report reference ${index}`,
    );
    if (seen.has(name)) {
      throw new EvidenceValidationError(
        "EvidenceDuplicate",
        `native report ${name} is duplicated`,
      );
    }
    seen.add(name);
    const { reference, record: report } = await readBoundEvidenceRecord(
      input,
      "native-reports",
      entry["report"],
      `native report ${name}`,
    );
    assertKeys(
      report,
      [
        "schemaVersion",
        "repository",
        "version",
        "commit",
        "generatedAt",
        "evidenceClass",
        "name",
        "environment",
        "status",
        "command",
      ],
      `native report ${name}`,
    );
    const expected = REQUIRED_NATIVE_REPORTS.get(name);
    if (
      expected?.schemaVersion !== report["schemaVersion"] ||
      report["name"] !== name ||
      report["environment"] !== "windows-11-native" ||
      report["status"] !== "passed" ||
      report["command"] !== expected?.command
    ) {
      throw new EvidenceValidationError(
        "NativeReportInvalid",
        `${name} is not a passing native Windows 11 report`,
      );
    }
    references.push(reference);
  }
  for (const name of REQUIRED_NATIVE_REPORTS.keys()) {
    if (!seen.has(name)) {
      throw new EvidenceValidationError(
        "NativeReportMissing",
        `native report ${name} is missing`,
      );
    }
  }
  if (
    new Set(references.map((reference) => reference.path)).size !==
    references.length
  ) {
    throw new EvidenceValidationError(
      "EvidenceDuplicate",
      "native reports must use distinct evidence paths",
    );
  }
  return references;
}

const REQUIRED_CLOSURE_ISSUES = [
  140, 145, 143, 136, 139, 138, 141, 135, 137, 144, 134, 142, 157, 147, 155,
  150, 152, 153, 156, 149, 148, 151, 146, 154, 163, 159, 160, 167, 168, 161,
  164, 158, 166, 169, 165,
] as const;

const REQUIRED_CLOSURE_DEPENDENCIES: readonly (readonly number[])[] = [
  [],
  [1],
  [2, 36],
  [3, 38],
  [4],
  [3],
  [5, 6, 20],
  [7],
  [8],
  [9],
  [10, 16],
  [11],
  [12],
  [13],
  [14],
  [1],
  [16],
  [17, 37],
  [18],
  [6, 19],
  [20],
  [19],
  [22],
  [21, 23],
  [24],
  [25],
  [26],
  [27],
  [28],
  [29],
  [],
  [],
  [32],
  [33],
  [34],
];

const REQUIRED_REMEDIATION_ISSUES = [
  162, 176, 172, 170, 177, 174, 173, 175, 178, 180, 179, 171,
] as const;

const REQUIRED_REMEDIATION_PARENTS = [
  2, 17, 3, 18, 18, 18, 18, 18, 18, 18, 21, 30,
] as const;

const REQUIRED_CLOSURE_PULL_REQUESTS = [
  69,
  71,
  76,
  85,
  92,
  91,
  102,
  106,
  109,
  111,
  115,
  119,
  122,
  125,
  128,
  70,
  72,
  75,
  86,
  99,
  101,
  90,
  97,
  107,
  110,
  112,
  116,
  118,
  120,
  123,
  null,
  131,
  132,
  133,
  "ticket-35",
] as const;

const REQUIRED_REMEDIATION_PULL_REQUESTS = [
  74,
  73,
  77,
  94,
  108,
  113,
  114,
  117,
  121,
  126,
  null,
  127,
] as const;

const REQUIRED_TICKET_34_REMEDIATION_PULL_REQUEST = 183;
const REQUIRED_TICKET_34_REVIEWED_HEAD =
  "f0e71af1a81430283983446e1a911c8bee5768b9";
const REQUIRED_TICKET_34_REMOTE_HEAD =
  "8d90bf088a66d03dc1e7c1a1edfb518fd8969584";
const REQUIRED_TICKET_34_POST_REVIEW_EVIDENCE =
  ".scratch/remaining-production-closure/issues/34-release-sbom-provenance-manifest.md";
const REQUIRED_TICKET_34_REMEDIATION_REVIEWED_HEAD =
  "dab2bc0021d3665ff00368a18ea02712346442fd";
const REQUIRED_TICKET_34_REMEDIATION_REMOTE_HEAD =
  "1e3be71ec89391f34654c48e69e3fb233c4e6252";
const REQUIRED_TICKET_34_REMEDIATION_REVIEWED_TREE =
  "6891de1111f98dc59ec63822fc7728643f4abb30";
const REQUIRED_PULL_REQUEST_CHECK_NAMES = [
  "gate-linux",
  "browser-e2e",
  "release-metadata",
] as const;
const REQUIRED_WINDOWS_ACCEPTANCE_METADATA_FIELDS = [
  "runnerVersion",
  "companionVersion",
  "observationGraphVersion",
  "skillCompilerVersion",
  "windowsEdition",
  "windowsBuild",
  "cpuArchitecture",
  "displayResolution",
  "dpiScale",
  "systemLanguage",
  "testAccount",
  "accountPrivilege",
  "runnerCertificateFingerprint",
  "companionPipe",
  "logonSid",
  "modelProvider",
  "modelProfile",
] as const;

const KNOWN_CLOSURE_PULL_REQUESTS = new Set<number>();
for (const value of [
  ...REQUIRED_CLOSURE_PULL_REQUESTS,
  ...REQUIRED_REMEDIATION_PULL_REQUESTS,
]) {
  if (typeof value === "number") {
    KNOWN_CLOSURE_PULL_REQUESTS.add(value);
  }
}
KNOWN_CLOSURE_PULL_REQUESTS.add(REQUIRED_TICKET_34_REMEDIATION_PULL_REQUEST);

const REQUIRED_PROVIDER_VARIABLES = [
  "QUALIGENCE_REFERENCE_MODEL_BASE_URL",
  "QUALIGENCE_REFERENCE_MODEL_API_KEY",
  "QUALIGENCE_MODEL_BASE_URL",
  "QUALIGENCE_MODEL_API_KEY",
  "QUALIGENCE_LIVE_MODEL_SMOKE",
  "QUALIGENCE_MODEL_NAME",
  "QUALIGENCE_DATA_DIR",
] as const;

const REQUIRED_PROVIDER_COMMANDS = [
  "CI=true corepack pnpm vitest run tests/e2e/detection-benchmark/reference-model-profile.test.ts",
  "CI=true QUALIGENCE_LIVE_MODEL_SMOKE=true corepack pnpm vitest run tests/live/remote-model-smoke.test.ts",
] as const;

const REQUIRED_PROVIDER_REDACTION_SCOPES = [
  "stdout",
  "stderr",
  "persisted-summaries",
  "artifacts",
  "local-files",
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

async function repositoryCommitGraph(
  repositoryRoot: string,
  commit: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, readonly string[]>> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, "rev-list", "--parents", commit],
      { maxBuffer: 16 * 1024 * 1024, signal },
    );
    const graph = new Map<string, readonly string[]>();
    for (const line of stdout.split(/\r?\n/u)) {
      if (line === "") {
        continue;
      }
      const [sha, ...parents] = line.split(" ");
      if (sha !== undefined) {
        graph.set(sha, parents);
      }
    }
    if (!graph.has(commit)) {
      throw new Error(`selected commit ${commit} is absent`);
    }
    return graph;
  } catch (error) {
    if (signal?.aborted === true) {
      throw new GraphFreezeFinalizationError(
        "FinalizationAborted",
        "Graph freeze finalization was cancelled during ancestry validation",
      );
    }
    throw new EvidenceValidationError(
      "GithubCommitGraphIncomplete",
      `local repository cannot prove selected commit ancestry: ${errorMessage(error)}`,
    );
  }
}

async function repositoryChangedFiles(
  repositoryRoot: string,
  fromCommit: string,
  toCommit: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        repositoryRoot,
        "diff",
        "--name-only",
        "--diff-filter=ACDMRTUXB",
        fromCommit,
        toCommit,
        "--",
      ],
      { maxBuffer: 4 * 1024 * 1024, signal },
    );
    return stdout
      .split(/\r?\n/u)
      .filter((path) => path !== "")
      .sort();
  } catch (error) {
    if (signal?.aborted === true) {
      throw new GraphFreezeFinalizationError(
        "FinalizationAborted",
        "Graph freeze finalization was cancelled during review-diff validation",
      );
    }
    throw new EvidenceValidationError(
      "GithubReviewedHeadMismatch",
      `local repository cannot verify the reviewed-to-remote diff: ${errorMessage(error)}`,
    );
  }
}

async function repositoryTreeHash(
  repositoryRoot: string,
  commit: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, "rev-parse", `${commit}^{tree}`],
      { maxBuffer: 1024 * 1024, signal },
    );
    return requireCommit(stdout.trim(), `${commit} tree`);
  } catch (error) {
    if (signal?.aborted === true) {
      throw new GraphFreezeFinalizationError(
        "FinalizationAborted",
        "Graph freeze finalization was cancelled during review-tree validation",
      );
    }
    if (error instanceof EvidenceValidationError) {
      throw error;
    }
    throw new EvidenceValidationError(
      "GithubReviewedHeadMismatch",
      `local repository cannot verify the remote review tree: ${errorMessage(error)}`,
    );
  }
}

function assertCanonicalPullRequest(
  ticket: number,
  pullRequestNumber: number,
  expectedOverride?: number,
): void {
  const expected =
    expectedOverride ??
    (ticket <= 35
      ? REQUIRED_CLOSURE_PULL_REQUESTS[ticket - 1]
      : REQUIRED_REMEDIATION_PULL_REQUESTS[ticket - 36]);
  const valid =
    expected === "ticket-35"
      ? !KNOWN_CLOSURE_PULL_REQUESTS.has(pullRequestNumber)
      : expected === pullRequestNumber;
  if (!valid) {
    throw new EvidenceValidationError(
      "GithubPullRequestUnexpected",
      `Ticket ${ticket} does not reference its canonical merged pull request`,
    );
  }
}

async function validatePullRequest(
  value: unknown,
  ticket: number,
  input: FinalizeGraphFreezeInput,
  graph: ReadonlyMap<string, readonly string[]>,
  ancestors: ReadonlySet<string>,
  seenPullRequests: Set<number>,
  expectedPullRequest?: number,
): Promise<void> {
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
      "reviewedTree",
      "remoteHead",
      "mergeCommit",
      "changedFiles",
      "checkSuite",
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
  assertCanonicalPullRequest(ticket, number, expectedPullRequest);
  seenPullRequests.add(number);
  if (
    pullRequest["url"] !==
      `https://github.com/${input.repository}/pull/${number}` ||
    pullRequest["state"] !== "closed" ||
    !isCanonicalTimestamp(requireString(pullRequest, "mergedAt", label))
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
  const reviewedTree =
    pullRequest["reviewedTree"] === undefined
      ? undefined
      : requireCommit(pullRequest["reviewedTree"], `${label}.reviewedTree`);
  if (
    number === 133 &&
    (reviewedHead !== REQUIRED_TICKET_34_REVIEWED_HEAD ||
      remoteHead !== REQUIRED_TICKET_34_REMOTE_HEAD)
  ) {
    throw new EvidenceValidationError(
      "GithubReviewedHeadMismatch",
      `${label} does not bind PR #133's canonical reviewed and remote heads`,
    );
  }
  if (
    number === REQUIRED_TICKET_34_REMEDIATION_PULL_REQUEST &&
    (reviewedHead !== REQUIRED_TICKET_34_REMEDIATION_REVIEWED_HEAD ||
      remoteHead !== REQUIRED_TICKET_34_REMEDIATION_REMOTE_HEAD ||
      reviewedTree !== REQUIRED_TICKET_34_REMEDIATION_REVIEWED_TREE)
  ) {
    throw new EvidenceValidationError(
      "GithubReviewedHeadMismatch",
      `${label} does not bind PR #183's canonical reviewed, remote, and tree identities`,
    );
  }
  if (
    reviewedTree !== undefined &&
    reviewedTree !==
      (await repositoryTreeHash(
        input.repositoryRoot,
        reviewedHead,
        input.signal,
      ))
  ) {
    throw new EvidenceValidationError(
      "GithubReviewedHeadMismatch",
      `${label} reviewed-tree binding does not match its reviewed head`,
    );
  }
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
    const postReviewFiles = [
      ...assertStringArrayAllowEmpty(
        pullRequest["postReviewFiles"],
        `${label}.postReviewFiles`,
      ),
    ].sort();
    const actualPostReviewFiles = await repositoryChangedFiles(
      input.repositoryRoot,
      reviewedHead,
      remoteHead,
      input.signal,
    );
    const treeEquivalentNormalization =
      actualPostReviewFiles.length === 0 &&
      reviewedTree !== undefined &&
      reviewedTree ===
        (await repositoryTreeHash(
          input.repositoryRoot,
          remoteHead,
          input.signal,
        ));
    if (
      !treeEquivalentNormalization &&
      !commitAncestors(graph, remoteHead).has(reviewedHead)
    ) {
      throw new EvidenceValidationError(
        "GithubReviewedHeadMismatch",
        `${label} remote head neither descends from nor tree-matches its reviewed head`,
      );
    }
    if (
      canonicalJson(postReviewFiles) !== canonicalJson(actualPostReviewFiles) ||
      postReviewFiles.some(
        (path) =>
          !(
            path === "README.md" ||
            path.startsWith("docs/") ||
            (ticket === 34 &&
              number === 133 &&
              path === REQUIRED_TICKET_34_POST_REVIEW_EVIDENCE) ||
            path ===
              `artifacts/release/${input.version}/graph-freeze-decision.json`
          ),
      )
    ) {
      throw new EvidenceValidationError(
        "GithubReviewedHeadMismatch",
        `${label} changed code or tests after its reviewed head`,
      );
    }
    if (treeEquivalentNormalization && postReviewFiles.length !== 0) {
      throw new EvidenceValidationError(
        "GithubReviewedHeadMismatch",
        `${label} records a post-review diff for a tree-equivalent normalized head`,
      );
    }
  } else if (
    (pullRequest["postReviewFiles"] !== undefined &&
      assertStringArrayAllowEmpty(
        pullRequest["postReviewFiles"],
        `${label}.postReviewFiles`,
      ).length !== 0) ||
    pullRequest["reviewedTree"] !== undefined
  ) {
    throw new EvidenceValidationError(
      "GithubReviewedHeadMismatch",
      `${label} records a post-review diff for an unchanged reviewed head`,
    );
  }
  assertStringArray(pullRequest["changedFiles"], `${label}.changedFiles`);
  const checkSuite = asRecord(pullRequest["checkSuite"], `${label}.checkSuite`);
  assertKeys(
    checkSuite,
    ["status", "conclusion", "checkCount", "requiredChecks"],
    `${label}.checkSuite`,
  );
  const checkCount = requireSafeInteger(
    checkSuite,
    "checkCount",
    `${label}.checkSuite`,
  );
  const checks = requireArray(pullRequest, "checks", label);
  const requiredChecks = assertStringArray(
    checkSuite["requiredChecks"],
    `${label}.checkSuite.requiredChecks`,
  );
  if (
    checks.length === 0 ||
    requiredChecks.length !== REQUIRED_PULL_REQUEST_CHECK_NAMES.length ||
    REQUIRED_PULL_REQUEST_CHECK_NAMES.some(
      (name) => !requiredChecks.includes(name),
    ) ||
    checkSuite["status"] !== "completed" ||
    checkSuite["conclusion"] !== "success" ||
    checkCount !== checks.length
  ) {
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
      `${label} does not prove every required check identity`,
    );
  }
}

interface GithubApiCapture {
  readonly reference: GraphFreezeEvidenceReference;
  readonly issues: ReadonlyMap<
    number,
    {
      readonly issue: Record<string, unknown>;
      readonly closingPullRequests: readonly unknown[];
    }
  >;
  readonly pullRequests: ReadonlyMap<number, Record<string, unknown>>;
}

async function readGithubApiCapture(
  capture: Record<string, unknown>,
  input: FinalizeGraphFreezeInput,
): Promise<GithubApiCapture> {
  const { reference, record } = await readBoundEvidenceRecord(
    input,
    "github-closure",
    capture["response"],
    "GitHub API response capture",
  );
  assertKeys(
    record,
    [
      "schemaVersion",
      "repository",
      "version",
      "commit",
      "generatedAt",
      "evidenceClass",
      "source",
      "apiVersion",
      "actor",
      "issueResponses",
      "pullRequestResponses",
    ],
    "GitHub API response capture",
  );
  if (
    record["schemaVersion"] !== "qualigence-github-api-capture/v1" ||
    record["source"] !== "github-graphql-and-rest-api" ||
    record["apiVersion"] !== "2022-11-28" ||
    record["actor"] !== capture["actor"] ||
    record["generatedAt"] !== capture["capturedAt"]
  ) {
    throw new EvidenceValidationError(
      "GithubCaptureInvalid",
      "GitHub response capture metadata is inconsistent",
    );
  }

  const parseResponses = (
    key: "issueResponses" | "pullRequestResponses",
    kind: "issue" | "pull-request",
  ): ReadonlyMap<number, Record<string, unknown>> => {
    const responses = requireArray(record, key, "GitHub API response capture");
    const byNumber = new Map<number, Record<string, unknown>>();
    for (const [index, value] of responses.entries()) {
      const response = asRecord(value, `GitHub API ${kind} response ${index}`);
      assertKeys(
        response,
        ["endpoint", "bodySha256", "body"],
        `GitHub API ${kind} response ${index}`,
      );
      const body = asRecord(
        response["body"],
        `GitHub API ${kind} response ${index}.body`,
      );
      const nested =
        kind === "issue"
          ? asRecord(body["issue"], `GitHub API issue ${index}`)
          : asRecord(body["pullRequest"], `GitHub API pull request ${index}`);
      const number = requireSafeInteger(
        nested,
        "number",
        `GitHub API ${kind} response ${index}`,
      );
      const expectedEndpoint = `https://api.github.com/repos/${input.repository}/${
        kind === "issue" ? "issues" : "pulls"
      }/${number}`;
      if (
        body["kind"] !== kind ||
        response["endpoint"] !== expectedEndpoint ||
        response["bodySha256"] !== sha256Hex(canonicalJson(body)) ||
        byNumber.has(number)
      ) {
        throw new EvidenceValidationError(
          "GithubCaptureInvalid",
          `GitHub API ${kind} response ${number} is malformed, duplicated, or hash-mismatched`,
        );
      }
      byNumber.set(number, body);
    }
    return byNumber;
  };

  const issueBodies = parseResponses("issueResponses", "issue");
  const issues = new Map<
    number,
    {
      readonly issue: Record<string, unknown>;
      readonly closingPullRequests: readonly unknown[];
    }
  >();
  for (const [number, body] of issueBodies) {
    issues.set(number, {
      issue: asRecord(body["issue"], `GitHub API issue ${number}`),
      closingPullRequests: requireArray(
        body,
        "closingPullRequests",
        `GitHub API issue ${number}`,
      ),
    });
  }
  const pullRequestBodies = parseResponses(
    "pullRequestResponses",
    "pull-request",
  );
  const pullRequests = new Map<number, Record<string, unknown>>();
  for (const [number, body] of pullRequestBodies) {
    pullRequests.set(
      number,
      asRecord(body["pullRequest"], `GitHub API pull request ${number}`),
    );
  }
  return { reference, issues, pullRequests };
}

function assertGithubIssueCapture(
  capture: GithubApiCapture,
  issue: Record<string, unknown>,
  expectedClosingPullRequests: readonly number[],
): void {
  const number = requireSafeInteger(issue, "number", "GitHub issue evidence");
  const captured = capture.issues.get(number);
  if (
    captured === undefined ||
    canonicalJson(captured.issue) !== canonicalJson(issue) ||
    canonicalJson(captured.closingPullRequests) !==
      canonicalJson(expectedClosingPullRequests)
  ) {
    throw new EvidenceValidationError(
      "GithubCaptureInvalid",
      `GitHub API capture does not prove issue ${number} or its closing linkage`,
    );
  }
}

function assertGithubPullRequestCapture(
  capture: GithubApiCapture,
  pullRequest: unknown,
): void {
  const record = asRecord(pullRequest, "GitHub pull request evidence");
  const number = requireSafeInteger(
    record,
    "number",
    "GitHub pull request evidence",
  );
  if (
    canonicalJson(capture.pullRequests.get(number)) !== canonicalJson(record)
  ) {
    throw new EvidenceValidationError(
      "GithubCaptureInvalid",
      `GitHub API capture does not prove pull request ${number}`,
    );
  }
}

async function validateGithubClosureEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): Promise<readonly GraphFreezeEvidenceReference[]> {
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
      "capture",
      "umbrellaIssue",
      "tickets",
      "remediation",
      "integratedAcceptance",
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
  const capture = asRecord(evidence["capture"], "GitHub API capture");
  assertKeys(
    capture,
    [
      "source",
      "apiVersion",
      "repositoryUrl",
      "actor",
      "capturedAt",
      "payloadSha256",
      "ticket35ClosingPullRequest",
      "response",
    ],
    "GitHub API capture",
  );
  const capturedAt = requireString(capture, "capturedAt", "GitHub API capture");
  const capturePayload = {
    umbrellaIssue: evidence["umbrellaIssue"],
    tickets: evidence["tickets"],
    remediation: evidence["remediation"],
    integratedAcceptance: evidence["integratedAcceptance"],
  };
  if (
    capture["source"] !== "github-graphql-and-rest-api" ||
    capture["apiVersion"] !== "2022-11-28" ||
    capture["repositoryUrl"] !==
      `https://api.github.com/repos/${input.repository}` ||
    requireString(capture, "actor", "GitHub API capture").trim() === "" ||
    capturedAt !== evidence["generatedAt"] ||
    capture["payloadSha256"] !== sha256Hex(canonicalJson(capturePayload))
  ) {
    throw new EvidenceValidationError(
      "GithubCaptureInvalid",
      "GitHub closure evidence must hash-bind one canonical URL/API capture",
    );
  }
  const apiCapture = await readGithubApiCapture(capture, input);
  if (evidence["umbrellaIssue"] !== 67) {
    throw new EvidenceValidationError(
      "GithubUmbrellaMismatch",
      "GitHub closure evidence must be rooted at Issue #67",
    );
  }
  const graph = await repositoryCommitGraph(
    input.repositoryRoot,
    input.commit,
    input.signal,
  );
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
      ["legacyTicket", "issue", "pullRequest", "remediationPullRequests"],
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
        "supersededBy",
      ],
      `legacy Ticket ${legacyTicket} issue`,
    );
    const expectedStatus = legacyTicket === 31 ? "superseded" : "resolved";
    const pullRequestNumber =
      ticket["pullRequest"] === undefined
        ? undefined
        : requireSafeInteger(
            asRecord(ticket["pullRequest"], "GitHub pull request evidence"),
            "number",
            "GitHub pull request evidence",
          );
    const remediationValue = ticket["remediationPullRequests"];
    if (
      (legacyTicket === 34 &&
        (!Array.isArray(remediationValue) ||
          remediationValue.length !== 1)) ||
      (legacyTicket !== 34 && remediationValue !== undefined)
    ) {
      throw new EvidenceValidationError(
        "GithubPullRequestNotMerged",
        "only legacy Ticket 34 must include its single producer remediation pull request",
      );
    }
    const remediationPullRequests =
      legacyTicket === 34 && Array.isArray(remediationValue)
        ? remediationValue
        : [];
    const remediationPullRequestNumbers = remediationPullRequests.map(
      (pullRequest) =>
        requireSafeInteger(
          asRecord(
            pullRequest,
            "legacy Ticket 34 remediation pull request",
          ),
          "number",
          "legacy Ticket 34 remediation pull request",
        ),
    );
    assertGithubIssueCapture(
      apiCapture,
      issue,
      legacyTicket === 35 && pullRequestNumber !== undefined
        ? [pullRequestNumber]
        : legacyTicket === 34 && pullRequestNumber !== undefined
          ? [pullRequestNumber, ...remediationPullRequestNumbers]
          : [],
    );
    if (
      issue["number"] !== REQUIRED_CLOSURE_ISSUES[legacyTicket - 1] ||
      issue["parentIssue"] !== 67 ||
      issue["state"] !== "closed" ||
      issue["status"] !== expectedStatus ||
      (expectedStatus === "superseded"
        ? issue["supersededBy"] !== 48
        : issue["supersededBy"] !== undefined)
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
    if (
      (issue["status"] === "resolved" &&
        (todoTotal === 0 || todoCompleted !== todoTotal)) ||
      (expectedStatus === "superseded" &&
        (todoCompleted > todoTotal || issue["supersededBy"] !== 48))
    ) {
      throw new EvidenceValidationError(
        "GithubTicketTodoIncomplete",
        `legacy Ticket ${legacyTicket} has incomplete work without a valid superseding authority`,
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
        dependency > 47 ||
        dependency === legacyTicket
      ) {
        throw new EvidenceValidationError(
          "GithubTicketDependencyInvalid",
          `legacy Ticket ${legacyTicket} has an invalid dependency`,
        );
      }
      return dependency;
    });
    const expectedDependencies =
      REQUIRED_CLOSURE_DEPENDENCIES[legacyTicket - 1];
    if (
      expectedDependencies === undefined ||
      blockedBy.length !== expectedDependencies.length ||
      expectedDependencies.some(
        (dependency) => !blockedBy.includes(dependency),
      ) ||
      new Set(blockedBy).size !== blockedBy.length
    ) {
      throw new EvidenceValidationError(
        "GithubTicketDependencyInvalid",
        `legacy Ticket ${legacyTicket} does not match the authoritative dependency graph`,
      );
    }
    if (expectedStatus === "resolved") {
      if (ticket["pullRequest"] === undefined) {
        throw new EvidenceValidationError(
          "GithubPullRequestNotMerged",
          `resolved legacy Ticket ${legacyTicket} has no merged pull request`,
        );
      }
      assertGithubPullRequestCapture(apiCapture, ticket["pullRequest"]);
      await validatePullRequest(
        ticket["pullRequest"],
        legacyTicket,
        input,
        graph,
        ancestors,
        seenPullRequests,
      );
    } else if (ticket["pullRequest"] !== undefined) {
      assertGithubPullRequestCapture(apiCapture, ticket["pullRequest"]);
      await validatePullRequest(
        ticket["pullRequest"],
        legacyTicket,
        input,
        graph,
        ancestors,
        seenPullRequests,
      );
    }
    for (const remediationPullRequest of remediationPullRequests) {
      assertGithubPullRequestCapture(apiCapture, remediationPullRequest);
      await validatePullRequest(
        remediationPullRequest,
        legacyTicket,
        input,
        graph,
        ancestors,
        seenPullRequests,
        REQUIRED_TICKET_34_REMEDIATION_PULL_REQUEST,
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
        "pullRequest",
        "supersededBy",
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
    assertGithubIssueCapture(apiCapture, issue, []);
    const classificationIsAllowed =
      legacyTicket === 46
        ? classification === "superseded"
        : classification === "resolved-remediation" ||
          classification === "deferred-advanced-hardening";
    if (
      issue["number"] !== REQUIRED_REMEDIATION_ISSUES[legacyTicket - 36] ||
      issue["parentIssue"] !== 67 ||
      !classificationIsAllowed ||
      item["blocking"] !== false ||
      item["parentLegacyTicket"] !==
        REQUIRED_REMEDIATION_PARENTS[legacyTicket - 36]
    ) {
      throw new EvidenceValidationError(
        "GithubRemediationInvalid",
        `legacy Ticket ${legacyTicket} has an invalid classification`,
      );
    }
    if (
      (classification === "resolved-remediation" &&
        (issue["state"] !== "closed" || issue["status"] !== "resolved")) ||
      (classification === "deferred-advanced-hardening" &&
        (issue["state"] !== "open" || issue["status"] !== "deferred")) ||
      (classification === "superseded" &&
        (issue["state"] !== "closed" ||
          issue["status"] !== "superseded" ||
          item["supersededBy"] !== 48))
    ) {
      throw new EvidenceValidationError(
        "GithubRemediationStatusInvalid",
        `legacy Ticket ${legacyTicket} status contradicts its classification`,
      );
    }
    if (classification === "resolved-remediation") {
      if (item["pullRequest"] === undefined) {
        throw new EvidenceValidationError(
          "GithubPullRequestNotMerged",
          `resolved remediation Ticket ${legacyTicket} has no merged pull request`,
        );
      }
      assertGithubPullRequestCapture(apiCapture, item["pullRequest"]);
      await validatePullRequest(
        item["pullRequest"],
        legacyTicket,
        input,
        graph,
        ancestors,
        seenPullRequests,
      );
    } else if (item["pullRequest"] !== undefined) {
      assertGithubPullRequestCapture(apiCapture, item["pullRequest"]);
      await validatePullRequest(
        item["pullRequest"],
        legacyTicket,
        input,
        graph,
        ancestors,
        seenPullRequests,
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
  assertGithubIssueCapture(apiCapture, integratedIssue, []);
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
    integratedIssue["status"] !== "ready-for-human" ||
    integratedBlockedBy.length !== 1 ||
    integratedBlockedBy[0] !== 35 ||
    integratedAcceptance["authority"] !== "integrated-human-acceptance" ||
    integratedAcceptance["blocking"] !== false
  ) {
    throw new EvidenceValidationError(
      "GithubIntegratedAcceptanceInvalid",
      "Ticket 48 must remain the ready-for-human, non-substitutable final acceptance authority blocked by Ticket 35",
    );
  }
  const ticket35 = tickets.find(
    (value) => asRecord(value, "GitHub closure ticket")["legacyTicket"] === 35,
  );
  const ticket35PullRequest =
    ticket35 === undefined
      ? undefined
      : asRecord(
          asRecord(ticket35, "legacy Ticket 35")["pullRequest"],
          "legacy Ticket 35 pull request",
        )["number"];
  if (capture["ticket35ClosingPullRequest"] !== ticket35PullRequest) {
    throw new EvidenceValidationError(
      "GithubPullRequestUnexpected",
      "Ticket 35 must use the closing pull request linked by the Issue #165 API capture",
    );
  }
  if (
    apiCapture.issues.size !== 48 ||
    apiCapture.pullRequests.size !== seenPullRequests.size
  ) {
    throw new EvidenceValidationError(
      "GithubCaptureInvalid",
      "GitHub API capture contains missing or unrelated issue/PR responses",
    );
  }
  return [apiCapture.reference];
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

async function validateProviderEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): Promise<readonly GraphFreezeEvidenceReference[]> {
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
      "commands",
      "provider",
      "result",
      "invocationCount",
      "invocations",
      "smokeReport",
      "redactionScans",
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
    ["source", "redacted", "requiredVariables"],
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
  assertStringArray(
    environment["requiredVariables"],
    "provider evidence.environment.requiredVariables",
    { exact: REQUIRED_PROVIDER_VARIABLES },
  );
  assertStringArray(evidence["commands"], "provider evidence.commands", {
    exact: REQUIRED_PROVIDER_COMMANDS,
  });

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
  if (evidence["invocationCount"] !== invocations.length) {
    throw new EvidenceValidationError(
      "ProviderInvocationInvalid",
      "provider evidence invocationCount must match its invocation records",
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

  const { reference: smokeReference, record: smokeReport } =
    await readBoundEvidenceRecord(
      input,
      "provider",
      evidence["smokeReport"],
      "provider smoke report",
    );
  assertKeys(
    smokeReport,
    [
      "schemaVersion",
      "repository",
      "version",
      "commit",
      "generatedAt",
      "evidenceClass",
      "provider",
      "result",
      "invocationCount",
      "invocations",
    ],
    "provider smoke report",
  );
  if (
    smokeReport["schemaVersion"] !== "qualigence-provider-smoke-report/v1" ||
    canonicalJson(smokeReport["provider"]) !== canonicalJson(provider) ||
    canonicalJson(smokeReport["result"]) !== canonicalJson(result) ||
    smokeReport["invocationCount"] !== invocations.length ||
    canonicalJson(smokeReport["invocations"]) !== canonicalJson(invocations)
  ) {
    throw new EvidenceValidationError(
      "ProviderReportInvalid",
      "provider smoke report does not bind the recorded identity, result, and invocations",
    );
  }

  const scanEntries = requireArray(
    evidence,
    "redactionScans",
    "provider evidence",
  );
  if (scanEntries.length !== REQUIRED_PROVIDER_REDACTION_SCOPES.length) {
    throw new EvidenceValidationError(
      "ProviderRedactionEvidenceInvalid",
      "provider evidence must include every required redaction scan",
    );
  }
  const references = [smokeReference];
  const seenScopes = new Set<string>();
  for (const [index, value] of scanEntries.entries()) {
    const entry = asRecord(value, `provider redaction scan ${index}`);
    assertKeys(entry, ["scope", "report"], `provider redaction scan ${index}`);
    const scope = requireString(
      entry,
      "scope",
      `provider redaction scan ${index}`,
    );
    if (
      !REQUIRED_PROVIDER_REDACTION_SCOPES.includes(
        scope as (typeof REQUIRED_PROVIDER_REDACTION_SCOPES)[number],
      ) ||
      seenScopes.has(scope)
    ) {
      throw new EvidenceValidationError(
        "ProviderRedactionEvidenceInvalid",
        `provider redaction scan scope ${scope} is unexpected or duplicated`,
      );
    }
    seenScopes.add(scope);
    const { reference, record: scan } = await readBoundEvidenceRecord(
      input,
      "provider",
      entry["report"],
      `provider ${scope} redaction report`,
    );
    assertKeys(
      scan,
      [
        "schemaVersion",
        "repository",
        "version",
        "commit",
        "generatedAt",
        "evidenceClass",
        "scope",
        "status",
        "scannedArtifactSha256",
        "scannedArtifact",
      ],
      `provider ${scope} redaction report`,
    );
    const scannedArtifact = parseEvidenceReference(
      scan["scannedArtifact"],
      `provider ${scope} scanned artifact`,
    );
    if (
      scan["schemaVersion"] !== "qualigence-provider-redaction-scan/v1" ||
      scan["scope"] !== scope ||
      scan["status"] !== "clean" ||
      typeof scan["scannedArtifactSha256"] !== "string" ||
      !/^[a-f0-9]{64}$/u.test(scan["scannedArtifactSha256"]) ||
      scan["scannedArtifactSha256"] !== scannedArtifact.sha256
    ) {
      throw new EvidenceValidationError(
        "ProviderRedactionEvidenceInvalid",
        `provider ${scope} redaction report is not clean and hash-bound`,
      );
    }
    await readEvidenceBytes(input, "provider", scannedArtifact);
    references.push(reference, scannedArtifact);
  }
  if (
    new Set(references.map((reference) => reference.path)).size !==
    references.length
  ) {
    throw new EvidenceValidationError(
      "EvidenceDuplicate",
      "provider reports must use distinct evidence paths",
    );
  }
  return references;
}

async function repositoryJsonAtCommit(
  input: FinalizeGraphFreezeInput,
  path: string,
): Promise<{ readonly value: unknown; readonly sha256: string }> {
  const source = await repositoryFileAtCommit(input, path);
  try {
    return {
      value: JSON.parse(source.text),
      sha256: source.sha256,
    };
  } catch (error) {
    throw new EvidenceValidationError(
      "BenchmarkSourceInvalid",
      `${path} in the selected commit is not valid JSON: ${errorMessage(error)}`,
    );
  }
}

async function repositoryFileAtCommit(
  input: FinalizeGraphFreezeInput,
  path: string,
  errorCode = "BenchmarkSourceInvalid",
  commit = input.commit,
): Promise<{ readonly text: string; readonly sha256: string }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", input.repositoryRoot, "show", `${commit}:${path}`],
      {
        maxBuffer: 16 * 1024 * 1024,
        signal: input.signal,
      },
    );
    return {
      text: stdout,
      sha256: sha256Hex(stdout),
    };
  } catch (error) {
    if (input.signal?.aborted === true) {
      throw new GraphFreezeFinalizationError(
        "FinalizationAborted",
        "Graph freeze finalization was cancelled during benchmark-source validation",
      );
    }
    throw new EvidenceValidationError(
      errorCode,
      `cannot read ${path} from commit ${commit}: ${errorMessage(error)}`,
    );
  }
}

function canonicalBenchmarkScenarioBinding(value: unknown): {
  readonly binding: Record<string, unknown>;
  readonly origins: readonly string[];
} {
  const scenario = asRecord(value, "canonical benchmark scenario");
  const scenarioId = requireString(
    scenario,
    "scenarioId",
    "canonical benchmark scenario",
  );
  const mode = scenario["mode"];
  if (mode !== "normal" && mode !== "fault") {
    throw new EvidenceValidationError(
      "BenchmarkSourceInvalid",
      `canonical benchmark scenario ${scenarioId} has an invalid mode`,
    );
  }
  const seedUrl = new URL(
    requireString(scenario, "seedUrl", `canonical scenario ${scenarioId}`),
  );
  const origins = new Set<string>([seedUrl.origin]);
  const states = requireArray(
    scenario,
    "states",
    `canonical scenario ${scenarioId}`,
  ).map((value, stateIndex) => {
    const state = asRecord(
      value,
      `canonical scenario ${scenarioId} state ${stateIndex}`,
    );
    const stateId = requireString(
      state,
      "id",
      `canonical scenario ${scenarioId} state ${stateIndex}`,
    );
    const stateUrl = new URL(
      requireString(
        state,
        "url",
        `canonical scenario ${scenarioId} state ${stateId}`,
      ),
    );
    origins.add(stateUrl.origin);
    const nodes = requireArray(
      state,
      "nodes",
      `canonical scenario ${scenarioId} state ${stateId}`,
    ).map((value, nodeIndex): ObservationNodeV1 => {
      const node = asRecord(
        value,
        `canonical scenario ${scenarioId} state ${stateId} node ${nodeIndex}`,
      );
      const confidence = node["confidence"];
      if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
        throw new EvidenceValidationError(
          "BenchmarkSourceInvalid",
          `canonical scenario ${scenarioId} node ${nodeIndex} has invalid confidence`,
        );
      }
      const text = node["text"];
      const disabled = node["disabled"];
      return {
        id: requireString(
          node,
          "id",
          `canonical scenario ${scenarioId} node ${nodeIndex}`,
        ),
        role: requireString(
          node,
          "role",
          `canonical scenario ${scenarioId} node ${nodeIndex}`,
        ),
        ...(typeof node["name"] === "string" ? { name: node["name"] } : {}),
        ...(typeof node["value"] === "string" ? { value: node["value"] } : {}),
        state: {
          ...(typeof text === "string" ? { text } : {}),
          ...(typeof disabled === "boolean" ? { disabled } : {}),
        },
        relations: [],
        source: {
          adapterId: "benchmark-scenario",
          sourceKind: "fixture",
        },
        confidence,
        sensitivity: "public",
        extensions: {},
        evidenceRefs: [],
      };
    });
    const root: ObservationNodeV1 = {
      id: `${scenarioId}:${stateId}:root`,
      role: "document",
      ...(typeof state["title"] === "string" ? { name: state["title"] } : {}),
      state: {},
      relations: nodes.map((node) => ({
        type: "child",
        targetNodeId: node.id,
      })),
      source: {
        adapterId: "benchmark-scenario",
        sourceKind: "fixture",
      },
      confidence: 1,
      sensitivity: "public",
      extensions: {},
      evidenceRefs: [],
    };
    const graph: ObservationGraphV1 = {
      schema: OBSERVATION_GRAPH_V1_SCHEMA,
      graphId: `${scenarioId}:${stateId}`,
      target: { kind: "web", targetId: stateUrl.origin },
      capturedAt: "1970-01-01T00:00:00.000Z",
      rootNodeIds: [root.id],
      nodes: [root, ...nodes],
      evidenceRefs: [],
      extensions: {
        [WEB_EXTENSION_V1_TYPE]: {
          type: WEB_EXTENSION_V1_TYPE,
          version: "1.0",
          payload: {
            origin: stateUrl.origin,
            pathname: stateUrl.pathname,
            title: typeof state["title"] === "string" ? state["title"] : "",
            viewport: {
              width: 1280,
              height: 720,
              devicePixelRatio: 1,
            },
            query: {},
          },
        },
      },
    };
    return {
      id: stateId,
      advanceNodeId: state["advanceNodeId"] ?? null,
      signals: state["signals"] ?? [],
      observationGraphSha256: observationGraphHash(graph),
    };
  });
  return {
    binding: {
      scenarioId,
      mode,
      seedUrl: { origin: seedUrl.origin, pathname: seedUrl.pathname },
      states,
    },
    origins: [...origins].sort(),
  };
}

async function validateBenchmarkEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
): Promise<void> {
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
      "sourceFiles",
      "manifest",
      "groundTruth",
      "runnerInputs",
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

  const requiredSourcePaths = [
    "benchmarks/detection-v1/manifest.json",
    "benchmarks/detection-v1/ground-truth/cart.json",
    "benchmarks/detection-v1/scenarios/cart-normal.json",
    "benchmarks/detection-v1/scenarios/cart-known-bugs.json",
  ] as const;
  const sourceFiles = requireArray(
    evidence,
    "sourceFiles",
    "benchmark evidence",
  );
  if (sourceFiles.length !== requiredSourcePaths.length) {
    throw new EvidenceValidationError(
      "BenchmarkSourceInvalid",
      "benchmark evidence must bind every canonical Detection Benchmark v1 source",
    );
  }
  const canonicalSources = new Map<string, unknown>();
  for (const requiredPath of requiredSourcePaths) {
    const matches = sourceFiles.filter(
      (value) =>
        asRecord(value, "benchmark source file")["path"] === requiredPath,
    );
    if (matches.length !== 1) {
      throw new EvidenceValidationError(
        "BenchmarkSourceInvalid",
        `benchmark source ${requiredPath} is missing or duplicated`,
      );
    }
    const source = asRecord(matches[0], `benchmark source ${requiredPath}`);
    assertKeys(source, ["path", "sha256"], `benchmark source ${requiredPath}`);
    const canonical = await repositoryJsonAtCommit(input, requiredPath);
    if (source["sha256"] !== canonical.sha256) {
      throw new EvidenceValidationError(
        "BenchmarkSourceInvalid",
        `benchmark source ${requiredPath} does not bind the selected commit bytes`,
      );
    }
    canonicalSources.set(requiredPath, canonical.value);
  }
  const canonicalScenarioBindings = new Map<string, Record<string, unknown>>();
  const canonicalOrigins = new Set<string>();
  for (const sourcePath of requiredSourcePaths.slice(2)) {
    const source = canonicalSources.get(sourcePath);
    const canonical = canonicalBenchmarkScenarioBinding(source);
    const scenarioId = requireString(
      canonical.binding,
      "scenarioId",
      `canonical benchmark source ${sourcePath}`,
    );
    canonicalScenarioBindings.set(scenarioId, canonical.binding);
    canonical.origins.forEach((origin) => canonicalOrigins.add(origin));
  }

  const manifest = asRecord(evidence["manifest"], "benchmark manifest");
  if (
    canonicalJson(manifest) !==
    canonicalJson(canonicalSources.get(requiredSourcePaths[0]))
  ) {
    throw new EvidenceValidationError(
      "BenchmarkSourceInvalid",
      "benchmark manifest does not match the selected commit",
    );
  }
  assertKeys(
    manifest,
    [
      "schemaVersion",
      "benchmarkVersion",
      "referenceProfile",
      "scenarios",
      "thresholds",
    ],
    "benchmark manifest",
  );
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
  assertKeys(
    profile,
    [
      "profileId",
      "providerId",
      "modelId",
      "promptVersion",
      "policyBundleSha256",
      "skillPackSha256",
      "browserVersion",
      "fixtureVersions",
      "maximumSteps",
      "maximumWallClockMs",
      "maximumModelTokens",
      "repetitions",
    ],
    "benchmark reference profile",
  );
  for (const key of [
    "profileId",
    "providerId",
    "modelId",
    "promptVersion",
    "browserVersion",
  ]) {
    requireString(profile, key, "benchmark reference profile");
  }
  for (const key of ["policyBundleSha256", "skillPackSha256"]) {
    if (
      !/^[a-f0-9]{64}$/u.test(
        requireString(profile, key, "benchmark reference profile"),
      )
    ) {
      throw new EvidenceValidationError(
        "BenchmarkManifestInvalid",
        `benchmark reference profile.${key} must be SHA-256`,
      );
    }
  }
  for (const key of [
    "maximumSteps",
    "maximumWallClockMs",
    "maximumModelTokens",
  ]) {
    requirePositiveInteger(profile, key, "benchmark reference profile");
  }
  const maximumModelTokens = requirePositiveInteger(
    profile,
    "maximumModelTokens",
    "benchmark reference profile",
  );
  const repetitions = requirePositiveInteger(
    profile,
    "repetitions",
    "benchmark reference profile",
  );
  const fixtureVersions = asRecord(
    profile["fixtureVersions"],
    "benchmark reference profile.fixtureVersions",
  );
  if (
    Object.keys(fixtureVersions).length === 0 ||
    Object.values(fixtureVersions).some(
      (fixtureVersion) =>
        typeof fixtureVersion !== "string" || fixtureVersion.trim() === "",
    )
  ) {
    throw new EvidenceValidationError(
      "BenchmarkManifestInvalid",
      "benchmark reference profile must bind fixture versions",
    );
  }

  const scenarios = requireArray(manifest, "scenarios", "benchmark manifest");
  if (scenarios.length === 0) {
    throw new EvidenceValidationError(
      "BenchmarkManifestInvalid",
      "benchmark manifest must contain scenarios",
    );
  }
  const scenarioIds = new Set<string>();
  const scenariosById = new Map<string, Record<string, unknown>>();
  const scenarioModes = new Map<string, "normal" | "fault">();
  const expectedDefectsByScenario = new Map<string, ReadonlySet<string>>();
  for (const [index, value] of scenarios.entries()) {
    const scenario = asRecord(value, `benchmark scenario ${index}`);
    assertKeys(
      scenario,
      [
        "scenarioId",
        "fixtureId",
        "fixtureVersion",
        "mode",
        "missionRef",
        "groundTruthRef",
        "expectedDefectIds",
      ],
      `benchmark scenario ${index}`,
    );
    const scenarioId = requireString(
      scenario,
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
    scenariosById.set(scenarioId, scenario);
    const fixtureId = requireString(
      scenario,
      "fixtureId",
      `benchmark scenario ${index}`,
    );
    if (
      scenario["fixtureVersion"] !== fixtureVersions[fixtureId] ||
      (scenario["mode"] !== "normal" && scenario["mode"] !== "fault")
    ) {
      throw new EvidenceValidationError(
        "BenchmarkManifestInvalid",
        `benchmark scenario ${scenarioId} does not bind its frozen fixture or mode`,
      );
    }
    requireString(scenario, "missionRef", `benchmark scenario ${index}`);
    requireString(scenario, "groundTruthRef", `benchmark scenario ${index}`);
    const expectedDefectIds = scenario["expectedDefectIds"];
    if (
      !Array.isArray(expectedDefectIds) ||
      expectedDefectIds.some(
        (defectId) => typeof defectId !== "string" || defectId.trim() === "",
      ) ||
      new Set(expectedDefectIds).size !== expectedDefectIds.length
    ) {
      throw new EvidenceValidationError(
        "BenchmarkManifestInvalid",
        `benchmark scenario ${scenarioId} has invalid expected defects`,
      );
    }
    scenarioModes.set(scenarioId, scenario["mode"]);
    expectedDefectsByScenario.set(
      scenarioId,
      new Set(expectedDefectIds as string[]),
    );
  }
  const thresholds = asRecord(manifest["thresholds"], "benchmark thresholds");
  const frozenThresholds = {
    p0RecallMinimum: 1,
    knownBugRecallMinimum: 0.8,
    findingPrecisionMinimum: 0.6,
    stableReproductionRateMinimum: 0.7,
    maximumHighConfidenceFalsePositivesPerNormalMission: 1,
  };
  if (
    Object.keys(thresholds).length !== Object.keys(frozenThresholds).length ||
    Object.entries(frozenThresholds).some(
      ([key, threshold]) => thresholds[key] !== threshold,
    )
  ) {
    throw new EvidenceValidationError(
      "BenchmarkManifestInvalid",
      "benchmark manifest does not carry the frozen v1 thresholds",
    );
  }

  const groundTruth = asRecord(
    evidence["groundTruth"],
    "benchmark ground truth",
  );
  if (
    canonicalJson(groundTruth) !==
    canonicalJson(canonicalSources.get(requiredSourcePaths[1]))
  ) {
    throw new EvidenceValidationError(
      "BenchmarkSourceInvalid",
      "benchmark ground truth does not match the selected commit",
    );
  }
  assertKeys(
    groundTruth,
    ["benchmarkVersion", "defects"],
    "benchmark ground truth",
  );
  if (groundTruth["benchmarkVersion"] !== benchmarkVersion) {
    throw new EvidenceValidationError(
      "BenchmarkGroundTruthInvalid",
      "benchmark ground truth version does not match the manifest",
    );
  }
  const defects = requireArray(
    groundTruth,
    "defects",
    "benchmark ground truth",
  );
  const defectKeys = new Set<string>();
  const truthDefectsByScenario = new Map<string, Set<string>>();
  const parsedDefects: {
    readonly scenarioId: string;
    readonly defectId: string;
    readonly severity: "P0" | "P1" | "P2";
    readonly stable: boolean;
  }[] = [];
  for (const [index, value] of defects.entries()) {
    const defect = asRecord(value, `benchmark defect ${index}`);
    assertKeys(
      defect,
      ["scenarioId", "defectId", "severity", "stable"],
      `benchmark defect ${index}`,
    );
    const scenarioId = requireString(
      defect,
      "scenarioId",
      `benchmark defect ${index}`,
    );
    const defectId = requireString(
      defect,
      "defectId",
      `benchmark defect ${index}`,
    );
    const severity = defect["severity"];
    const key = `${scenarioId}\0${defectId}`;
    if (
      !scenarioIds.has(scenarioId) ||
      (severity !== "P0" && severity !== "P1" && severity !== "P2") ||
      typeof defect["stable"] !== "boolean" ||
      defectKeys.has(key)
    ) {
      throw new EvidenceValidationError(
        "BenchmarkGroundTruthInvalid",
        `benchmark defect ${key} is invalid or duplicated`,
      );
    }
    defectKeys.add(key);
    const scenarioDefects =
      truthDefectsByScenario.get(scenarioId) ?? new Set<string>();
    scenarioDefects.add(defectId);
    truthDefectsByScenario.set(scenarioId, scenarioDefects);
    parsedDefects.push({
      scenarioId,
      defectId,
      severity,
      stable: defect["stable"],
    });
  }
  for (const scenarioId of scenarioIds) {
    const expected = expectedDefectsByScenario.get(scenarioId);
    const actual = truthDefectsByScenario.get(scenarioId) ?? new Set<string>();
    if (
      expected === undefined ||
      expected.size !== actual.size ||
      [...expected].some((defectId) => !actual.has(defectId))
    ) {
      throw new EvidenceValidationError(
        "BenchmarkGroundTruthInvalid",
        `benchmark scenario ${scenarioId} does not exactly bind ground truth`,
      );
    }
  }

  const report = asRecord(evidence["report"], "benchmark report");
  const manifestHash = sha256Hex(canonicalJson(manifest));
  const profileHash = sha256Hex(canonicalJson(profile));
  const groundTruthHash = sha256Hex(canonicalJson(groundTruth));
  const runnerInputs = asRecord(
    evidence["runnerInputs"],
    "benchmark runner inputs",
  );
  assertKeys(
    runnerInputs,
    ["policy", "scenarioDefinitions"],
    "benchmark runner inputs",
  );
  const policy = asRecord(runnerInputs["policy"], "benchmark runner policy");
  assertKeys(
    policy,
    [
      "seedSkillBundleIds",
      "allowedActionKinds",
      "allowedOrigins",
      "maximumSteps",
      "maximumWallClockMs",
      "maximumModelTokens",
      "maximumStateVisits",
      "maximumRecoveries",
      "riskCeiling",
    ],
    "benchmark runner policy",
  );
  if (
    !Array.isArray(policy["seedSkillBundleIds"]) ||
    policy["seedSkillBundleIds"].length !== 0 ||
    canonicalJson(policy["allowedActionKinds"]) !==
      canonicalJson(["navigate", "click", "input"]) ||
    !Array.isArray(policy["allowedOrigins"]) ||
    policy["allowedOrigins"].length === 0 ||
    policy["allowedOrigins"].some((origin) => {
      if (typeof origin !== "string" || origin.trim() === "") {
        return true;
      }
      try {
        return new URL(origin).origin !== origin;
      } catch {
        return true;
      }
    }) ||
    new Set(policy["allowedOrigins"]).size !==
      policy["allowedOrigins"].length ||
    canonicalJson([...policy["allowedOrigins"]].sort()) !==
      canonicalJson([...canonicalOrigins].sort()) ||
    policy["maximumSteps"] !== profile["maximumSteps"] ||
    policy["maximumWallClockMs"] !== profile["maximumWallClockMs"] ||
    policy["maximumModelTokens"] !== profile["maximumModelTokens"] ||
    policy["maximumStateVisits"] !== profile["maximumSteps"] ||
    policy["maximumRecoveries"] !== 0 ||
    policy["riskCeiling"] !== "RecoverableMutation"
  ) {
    throw new EvidenceValidationError(
      "BenchmarkRunnerBindingInvalid",
      "benchmark runner policy does not match the frozen Reference Model profile",
    );
  }
  const scenarioDefinitions = requireArray(
    runnerInputs,
    "scenarioDefinitions",
    "benchmark runner inputs",
  );
  const definitionsByScenario = new Map<string, Record<string, unknown>>();
  for (const [index, value] of scenarioDefinitions.entries()) {
    const definition = asRecord(
      value,
      `benchmark scenario definition ${index}`,
    );
    assertKeys(
      definition,
      ["scenarioId", "mode", "seedUrl", "states"],
      `benchmark scenario definition ${index}`,
    );
    const scenarioId = requireString(
      definition,
      "scenarioId",
      `benchmark scenario definition ${index}`,
    );
    const states = requireArray(
      definition,
      "states",
      `benchmark scenario definition ${scenarioId}`,
    );
    if (
      definitionsByScenario.has(scenarioId) ||
      !scenarioIds.has(scenarioId) ||
      definition["mode"] !== scenarioModes.get(scenarioId) ||
      states.length === 0
    ) {
      throw new EvidenceValidationError(
        "BenchmarkRunnerBindingInvalid",
        `benchmark scenario definition ${scenarioId} is missing, duplicated, or inconsistent`,
      );
    }
    const canonicalBinding = canonicalScenarioBindings.get(scenarioId);
    if (canonicalBinding === undefined) {
      throw new EvidenceValidationError(
        "BenchmarkSourceInvalid",
        `benchmark scenario ${scenarioId} has no selected-commit source`,
      );
    }
    if (canonicalJson(definition) !== canonicalJson(canonicalBinding)) {
      throw new EvidenceValidationError(
        "BenchmarkSourceInvalid",
        `benchmark runner binding for ${scenarioId} does not match its selected-commit scenario`,
      );
    }
    if (definition["seedUrl"] !== undefined) {
      const seedUrl = asRecord(
        definition["seedUrl"],
        `benchmark scenario definition ${scenarioId}.seedUrl`,
      );
      assertKeys(
        seedUrl,
        ["origin", "pathname"],
        `benchmark scenario definition ${scenarioId}.seedUrl`,
      );
      if (
        typeof seedUrl["origin"] !== "string" ||
        !policy["allowedOrigins"].includes(seedUrl["origin"]) ||
        typeof seedUrl["pathname"] !== "string" ||
        !seedUrl["pathname"].startsWith("/")
      ) {
        throw new EvidenceValidationError(
          "BenchmarkRunnerBindingInvalid",
          `benchmark scenario definition ${scenarioId} has an invalid seed URL binding`,
        );
      }
    }
    const stateIds = new Set<string>();
    for (const [stateIndex, value] of states.entries()) {
      const state = asRecord(
        value,
        `benchmark scenario definition ${scenarioId} state ${stateIndex}`,
      );
      assertKeys(
        state,
        ["id", "advanceNodeId", "signals", "observationGraphSha256"],
        `benchmark scenario definition ${scenarioId} state ${stateIndex}`,
      );
      const stateId = requireString(
        state,
        "id",
        `benchmark scenario definition ${scenarioId} state ${stateIndex}`,
      );
      if (
        stateIds.has(stateId) ||
        (state["advanceNodeId"] !== null &&
          (typeof state["advanceNodeId"] !== "string" ||
            state["advanceNodeId"].trim() === "")) ||
        !Array.isArray(state["signals"]) ||
        typeof state["observationGraphSha256"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(state["observationGraphSha256"])
      ) {
        throw new EvidenceValidationError(
          "BenchmarkRunnerBindingInvalid",
          `benchmark scenario definition ${scenarioId} state ${stateId} is malformed`,
        );
      }
      stateIds.add(stateId);
    }
    definitionsByScenario.set(scenarioId, definition);
  }
  if (definitionsByScenario.size !== scenarioIds.size) {
    throw new EvidenceValidationError(
      "BenchmarkRunnerBindingInvalid",
      "benchmark runner inputs do not contain every scenario definition",
    );
  }
  const policyBindingHash = sha256Hex(canonicalJson(policy));
  const seedBindingHash = sha256Hex(
    canonicalJson({
      policySeedSkillBundleIds: policy["seedSkillBundleIds"],
      seeds: [],
    }),
  );
  const expectedInputSha256 = sha256Hex(
    canonicalJson({
      manifestSha256: manifestHash,
      profileSha256: profileHash,
      groundTruthSha256: groundTruthHash,
      policyBindingHash,
      seedBindingHash,
      scenarioDefinitions: [...definitionsByScenario.values()].sort(
        (left, right) => {
          const leftId = String(left["scenarioId"]).normalize("NFC");
          const rightId = String(right["scenarioId"]).normalize("NFC");
          return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
        },
      ),
    }),
  );
  if (
    report["benchmarkVersion"] !== benchmarkVersion ||
    report["profileStatus"] !== "reference" ||
    report["profileSha256"] !== profileHash ||
    report["manifestSha256"] !== manifestHash ||
    report["groundTruthSha256"] !== groundTruthHash ||
    report["inputSha256"] !== expectedInputSha256 ||
    timestampMillis(
      requireString(report, "createdAt", "benchmark report"),
      "benchmark report.createdAt",
    ) > timestampMillis(input.decidedAt, "decidedAt")
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
  const sortedAttemptIds = [...reportAttemptIds].sort();
  const sortedBindingHashes = [...bindingHashes].sort();
  const expectedReportId = sha256Hex(
    canonicalJson({
      manifestHash,
      profileHash,
      truthHash: groundTruthHash,
      inputSha256: report["inputSha256"],
      attemptIds: sortedAttemptIds,
      attemptBindingSha256s: sortedBindingHashes,
    }),
  );
  if (
    report["reportId"] !== expectedReportId ||
    reportAttemptIds.some(
      (attemptId, index) => attemptId !== sortedAttemptIds[index],
    ) ||
    bindingHashes.some(
      (bindingHash, index) => bindingHash !== sortedBindingHashes[index],
    )
  ) {
    throw new EvidenceValidationError(
      "BenchmarkReportInvalid",
      "benchmark report identity or canonical ordering is invalid",
    );
  }

  const invocations = requireArray(
    evidence,
    "invocations",
    "benchmark evidence",
  );
  const invocationIds = new Set<string>();
  const invocationAttempts = new Map<string, string>();
  const invocationTokens = new Map<string, number>();
  for (const [index, value] of invocations.entries()) {
    const label = `benchmark invocation ${index}`;
    const invocation = asRecord(value, label);
    assertKeys(
      invocation,
      [
        "invocationId",
        "attemptId",
        "status",
        "usageStatus",
        "inputTokens",
        "outputTokens",
        "totalTokens",
      ],
      label,
    );
    const invocationId = requireString(invocation, "invocationId", label);
    const invocationAttemptId = requireString(invocation, "attemptId", label);
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
      invocationIds.has(invocationId) ||
      invocation["status"] !== "succeeded" ||
      invocation["usageStatus"] !== "known" ||
      totalTokens !== inputTokens + outputTokens
    ) {
      throw new EvidenceValidationError(
        invocationIds.has(invocationId)
          ? "EvidenceDuplicate"
          : "BenchmarkInvocationInvalid",
        `${label} must be unique, successful, and carry internally consistent known usage`,
      );
    }
    invocationIds.add(invocationId);
    invocationAttempts.set(invocationId, invocationAttemptId);
    invocationTokens.set(invocationId, totalTokens);
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
  const seenBindings = new Set<string>();
  const seenInvocationIds = new Set<string>();
  const runId = sha256Hex(expectedInputSha256);
  const parsedAttempts: {
    readonly scenarioId: string;
    readonly repetition: number;
    readonly findings: readonly {
      readonly defectId: string;
      readonly confidence: "low" | "medium" | "high";
    }[];
  }[] = [];
  for (const [index, value] of attempts.entries()) {
    const label = `benchmark attempt ${index}`;
    const attempt = asRecord(value, label);
    const attemptId = requireString(attempt, "attemptId", label);
    const bindingSha256 = requireString(attempt, "bindingSha256", label);
    const scenarioId = requireString(attempt, "scenarioId", label);
    const repetition = requirePositiveInteger(attempt, "repetition", label);
    const attemptInvocationIds = assertStringArray(
      attempt["invocationIds"],
      `${label}.invocationIds`,
    );
    const findings = requireArray(attempt, "findings", label).map(
      (
        value,
        findingIndex,
      ): {
        readonly defectId: string;
        readonly confidence: "low" | "medium" | "high";
      } => {
        const finding = asRecord(value, `${label}.findings[${findingIndex}]`);
        const defectId = requireString(
          finding,
          "defectId",
          `${label}.findings[${findingIndex}]`,
        );
        const confidence = finding["confidence"];
        if (
          confidence !== "low" &&
          confidence !== "medium" &&
          confidence !== "high"
        ) {
          throw new EvidenceValidationError(
            "BenchmarkAttemptInvalid",
            `${label} has an invalid finding confidence`,
          );
        }
        return { defectId, confidence };
      },
    );
    const slot = `${scenarioId}\u0000${repetition}`;
    const attemptTotalTokens = attemptInvocationIds.reduce(
      (sum, invocationId) => sum + (invocationTokens.get(invocationId) ?? 0),
      0,
    );
    const manifestScenario = scenariosById.get(scenarioId);
    const scenarioDefinition = definitionsByScenario.get(scenarioId);
    const sourceBindingHash =
      manifestScenario === undefined || scenarioDefinition === undefined
        ? undefined
        : sha256Hex(
            canonicalJson({
              benchmarkVersion,
              manifestSha256: manifestHash,
              profileSha256: profileHash,
              groundTruthSha256: groundTruthHash,
              scenario: manifestScenario,
              scenarioDefinition,
              repetition,
            }),
          );
    const expectedBindingHash =
      sourceBindingHash === undefined
        ? undefined
        : sha256Hex(
            canonicalJson({
              runId,
              sourceBindingHash,
              policyBindingHash,
              seedBindingHash,
              scenarioId,
              repetition,
            }),
          );
    if (
      !scenarioIds.has(scenarioId) ||
      attempt["mode"] !== scenarioModes.get(scenarioId) ||
      attempt["profileSha256"] !== profileHash ||
      !bindingHashes.includes(bindingSha256) ||
      seenBindings.has(bindingSha256) ||
      bindingSha256 !== expectedBindingHash ||
      attemptId !== `${runId}:${bindingSha256}` ||
      repetition > repetitions ||
      seenSlots.has(slot) ||
      seenAttemptIds.has(attemptId) ||
      !reportAttemptIds.includes(attemptId) ||
      attemptInvocationIds.length === 0 ||
      attemptInvocationIds.some(
        (invocationId) =>
          !invocationIds.has(invocationId) ||
          invocationAttempts.get(invocationId) !== attemptId ||
          seenInvocationIds.has(invocationId),
      )
    ) {
      throw new EvidenceValidationError(
        "BenchmarkAttemptMatrixIncomplete",
        `${label} is not a unique, complete, invocation-bound matrix entry`,
      );
    }
    if (attemptTotalTokens > maximumModelTokens) {
      throw new EvidenceValidationError(
        "BenchmarkInvocationInvalid",
        `${label} exceeds the Reference Model token budget`,
      );
    }
    seenSlots.add(slot);
    seenAttemptIds.add(attemptId);
    seenBindings.add(bindingSha256);
    for (const invocationId of attemptInvocationIds) {
      seenInvocationIds.add(invocationId);
    }
    parsedAttempts.push({ scenarioId, repetition, findings });
  }
  if (seenInvocationIds.size !== invocationIds.size) {
    throw new EvidenceValidationError(
      "BenchmarkInvocationInvalid",
      "every persisted benchmark invocation must bind exactly one attempt",
    );
  }

  const attemptsByScenario = new Map<
    string,
    (typeof parsedAttempts)[number][]
  >();
  for (const attempt of parsedAttempts) {
    const entries = attemptsByScenario.get(attempt.scenarioId) ?? [];
    entries.push(attempt);
    attemptsByScenario.set(attempt.scenarioId, entries);
  }
  const ratio = (numerator: number, denominator: number) => ({
    numerator,
    denominator,
    value: denominator === 0 ? 1 : numerator / denominator,
  });
  const detectedDefects = new Set<string>();
  let highConfidenceTotal = 0;
  let highConfidenceTrue = 0;
  for (const attempt of parsedAttempts) {
    for (const finding of attempt.findings) {
      const key = `${attempt.scenarioId}\0${finding.defectId}`;
      detectedDefects.add(key);
      if (finding.confidence === "high") {
        highConfidenceTotal += 1;
        if (defectKeys.has(key)) {
          highConfidenceTrue += 1;
        }
      }
    }
  }
  const p0Defects = parsedDefects.filter((defect) => defect.severity === "P0");
  const p0Hits = p0Defects.filter((defect) =>
    detectedDefects.has(`${defect.scenarioId}\0${defect.defectId}`),
  ).length;
  const knownHits = parsedDefects.filter((defect) =>
    detectedDefects.has(`${defect.scenarioId}\0${defect.defectId}`),
  ).length;
  let stableSlots = 0;
  let stableHits = 0;
  for (const defect of parsedDefects.filter((entry) => entry.stable)) {
    for (const attempt of attemptsByScenario.get(defect.scenarioId) ?? []) {
      stableSlots += 1;
      if (
        attempt.findings.some((finding) => finding.defectId === defect.defectId)
      ) {
        stableHits += 1;
      }
    }
  }
  const falsePositivesByNormalMission: Record<string, number> = {};
  for (const [scenarioId, mode] of scenarioModes) {
    if (mode !== "normal") {
      continue;
    }
    falsePositivesByNormalMission[scenarioId] = (
      attemptsByScenario.get(scenarioId) ?? []
    ).reduce(
      (count, attempt) =>
        count +
        attempt.findings.filter(
          (finding) =>
            finding.confidence === "high" &&
            !defectKeys.has(`${scenarioId}\0${finding.defectId}`),
        ).length,
      0,
    );
  }
  const computedMetrics = {
    p0Recall:
      p0Defects.length === 0
        ? { numerator: 0, denominator: 0, value: 0 }
        : ratio(p0Hits, p0Defects.length),
    knownBugRecall: ratio(knownHits, parsedDefects.length),
    findingPrecision: ratio(highConfidenceTrue, highConfidenceTotal),
    stableReproductionRate: ratio(stableHits, stableSlots),
    highConfidenceFalsePositivesByNormalMission: falsePositivesByNormalMission,
  };
  if (
    canonicalJson(report["metrics"]) !== canonicalJson(computedMetrics) ||
    computedMetrics.p0Recall.denominator === 0 ||
    computedMetrics.p0Recall.value < frozenThresholds.p0RecallMinimum ||
    computedMetrics.knownBugRecall.value <
      frozenThresholds.knownBugRecallMinimum ||
    computedMetrics.findingPrecision.value <
      frozenThresholds.findingPrecisionMinimum ||
    computedMetrics.stableReproductionRate.value <
      frozenThresholds.stableReproductionRateMinimum ||
    Object.values(falsePositivesByNormalMission).some(
      (count) =>
        count >
        frozenThresholds.maximumHighConfidenceFalsePositivesPerNormalMission,
    )
  ) {
    throw new EvidenceValidationError(
      "BenchmarkGateFailed",
      "benchmark metrics do not match attempts or frozen thresholds",
    );
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

async function readManifestEvidenceBytes(
  input: FinalizeGraphFreezeInput,
  reference: GraphFreezeEvidenceReference,
  label: string,
  acceptedPrefixes: readonly string[],
): Promise<Buffer> {
  await assertManifestPathConfined(input, reference, label, acceptedPrefixes);
  const path = resolve(input.repositoryRoot, ...reference.path.split("/"));
  const bytes = await readFile(path);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== reference.sha256) {
    throw new EvidenceValidationError(
      "EvidenceHashMismatch",
      `${label} expected ${reference.sha256} but found ${actualHash}`,
    );
  }
  return bytes;
}

interface WindowsChecklistPayload {
  readonly checklist: Record<string, unknown>;
  readonly signatures: unknown;
}

function windowsChecklistPayload(bytes: Buffer): WindowsChecklistPayload {
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
      const checklist = asRecord(nested, "WindowsChecklistEvidence");
      return {
        checklist,
        signatures:
          record["WindowsChecklistSignatures"] ??
          record["windowsChecklistSignatures"] ??
          checklist["signatures"],
      };
    }
    if (record["checklistVersion"] !== undefined) {
      return { checklist: record, signatures: record["signatures"] };
    }
  }
  throw new EvidenceValidationError(
    "WindowsChecklistEvidenceUnavailable",
    "signed Windows evidence has no machine-readable checklist payload",
  );
}

function validateCompleteWindowsChecklist(
  payload: WindowsChecklistPayload,
  manifestWindows: Record<string, unknown>,
  input: FinalizeGraphFreezeInput,
): void {
  const { checklist } = payload;
  const acceptanceEnvironmentValue = checklist["acceptanceEnvironment"];
  if (
    acceptanceEnvironmentValue === null ||
    typeof acceptanceEnvironmentValue !== "object" ||
    Array.isArray(acceptanceEnvironmentValue)
  ) {
    throw new EvidenceValidationError(
      "WindowsEvidenceEnvironmentInvalid",
      "Windows checklist acceptance metadata is missing",
    );
  }
  const acceptanceEnvironment = acceptanceEnvironmentValue as Record<
    string,
    unknown
  >;
  for (const field of REQUIRED_WINDOWS_ACCEPTANCE_METADATA_FIELDS) {
    const value = acceptanceEnvironment[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new EvidenceValidationError(
        "WindowsEvidenceEnvironmentInvalid",
        `Windows checklist acceptance metadata ${field} is missing`,
      );
    }
  }
  if (acceptanceEnvironment["accountPrivilege"] !== "standard-user") {
    throw new EvidenceValidationError(
      "WindowsEvidenceEnvironmentInvalid",
      "Windows checklist acceptance metadata must use a standard-user account",
    );
  }
  const sessionTypes = assertStringArray(
    acceptanceEnvironment["interactiveSessionTypes"],
    "WindowsChecklistEvidence.acceptanceEnvironment.interactiveSessionTypes",
  );
  if (
    sessionTypes.length !== 2 ||
    !sessionTypes.includes("local") ||
    !sessionTypes.includes("rdp")
  ) {
    throw new EvidenceValidationError(
      "WindowsEvidenceEnvironmentInvalid",
      "Windows checklist acceptance metadata must prove local and RDP sessions",
    );
  }
  if (acceptanceEnvironment["windowsBuild"] !== checklist["windowsBuild"]) {
    throw new EvidenceValidationError(
      "WindowsEvidenceEnvironmentInvalid",
      "Windows checklist acceptance metadata contradicts the signed Windows build",
    );
  }
  const securityVetoIds = assertStringArray(
    checklist["securityVetoItemIds"],
    "WindowsChecklistEvidence.securityVetoItemIds",
  );
  if (
    new Set(securityVetoIds).size !== securityVetoIds.length ||
    securityVetoIds.length !== REQUIRED_SECURITY_VETO_ITEM_IDS.length ||
    REQUIRED_SECURITY_VETO_ITEM_IDS.some(
      (requiredId) => !securityVetoIds.includes(requiredId),
    )
  ) {
    throw new EvidenceValidationError(
      "WindowsEvidenceVetoInvalid",
      "Windows checklist security-veto ids are duplicated or non-canonical",
    );
  }

  const items = requireArray(checklist, "items", "WindowsChecklistEvidence");
  const seenItemIds = new Set<string>();
  const sectionCounts = new Map<string, number>();
  for (const [index, value] of items.entries()) {
    const item = asRecord(value, `WindowsChecklistEvidence.items[${index}]`);
    assertKeys(
      item,
      ["section", "id", "description", "result", "note"],
      `WindowsChecklistEvidence.items[${index}]`,
    );
    const id = requireString(
      item,
      "id",
      `WindowsChecklistEvidence.items[${index}]`,
    );
    const section = requireString(
      item,
      "section",
      `WindowsChecklistEvidence.items[${index}]`,
    );
    requireString(
      item,
      "description",
      `WindowsChecklistEvidence.items[${index}]`,
    );
    if (
      seenItemIds.has(id) ||
      id.split(".", 1)[0] !== section ||
      (item["result"] !== "pass" && item["result"] !== "not_applicable")
    ) {
      throw new EvidenceValidationError(
        seenItemIds.has(id)
          ? "WindowsEvidenceItemDuplicate"
          : id.split(".", 1)[0] !== section
            ? "WindowsEvidenceItemInvalid"
            : "WindowsEvidenceItemIncomplete",
        `Windows checklist item ${id} is duplicated or incomplete`,
      );
    }
    seenItemIds.add(id);
    sectionCounts.set(section, (sectionCounts.get(section) ?? 0) + 1);
  }
  for (const [section, count] of Object.entries(
    REQUIRED_WINDOWS_CHECKLIST_SECTION_COUNTS,
  )) {
    if (sectionCounts.get(section) !== count) {
      throw new EvidenceValidationError(
        "WindowsEvidenceItemMissing",
        `Windows checklist section ${section} does not contain all ${count} versioned items`,
      );
    }
  }
  if (
    sectionCounts.size !==
    Object.keys(REQUIRED_WINDOWS_CHECKLIST_SECTION_COUNTS).length
  ) {
    throw new EvidenceValidationError(
      "WindowsEvidenceItemInvalid",
      "Windows checklist contains an unknown executable section",
    );
  }
  if (
    seenItemIds.size !== REQUIRED_WINDOWS_CHECKLIST_ITEM_IDS.length ||
    REQUIRED_WINDOWS_CHECKLIST_ITEM_IDS.some((id) => !seenItemIds.has(id))
  ) {
    throw new EvidenceValidationError(
      "WindowsEvidenceItemInvalid",
      "Windows checklist does not contain the canonical versioned item ids",
    );
  }
  const conclusions = items
    .map((value) => asRecord(value, "Windows checklist conclusion"))
    .filter((item) => item["section"] === "17");
  if (
    conclusions.filter((item) => item["result"] === "pass").length !== 1 ||
    conclusions.some(
      (item) =>
        item["result"] !== "pass" && item["result"] !== "not_applicable",
    )
  ) {
    throw new EvidenceValidationError(
      "WindowsEvidenceConclusionInvalid",
      "Windows checklist must contain exactly one passing acceptance conclusion",
    );
  }

  const operatorName = requireString(
    checklist,
    "operatorName",
    "WindowsChecklistEvidence",
  ).trim();
  const reviewerName = requireString(
    checklist,
    "reviewerName",
    "WindowsChecklistEvidence",
  ).trim();
  const requiredSigners = new Set([operatorName, reviewerName]);
  for (const [label, value] of [
    ["embedded", payload.signatures],
    ["manifest", manifestWindows["signatures"]],
  ] as const) {
    if (!Array.isArray(value) || value.length !== requiredSigners.size) {
      throw new EvidenceValidationError(
        "WindowsEvidenceSignerInvalid",
        `${label} Windows signatures must contain exactly the operator and reviewer`,
      );
    }
    const signers = value.map((signature, index) =>
      requireString(
        asRecord(signature, `${label} Windows signature ${index}`),
        "signer",
        `${label} Windows signature ${index}`,
      ).trim(),
    );
    if (
      new Set(signers).size !== signers.length ||
      signers.some((signer) => !requiredSigners.has(signer))
    ) {
      throw new EvidenceValidationError(
        "WindowsEvidenceSignerInvalid",
        `${label} Windows signatures are duplicated or use an unexpected identity`,
      );
    }
  }

  const executedAt = requireString(
    checklist,
    "executedAt",
    "WindowsChecklistEvidence",
  );
  if (
    timestampMillis(executedAt, "WindowsChecklistEvidence.executedAt") >
    timestampMillis(input.decidedAt, "decidedAt")
  ) {
    throw new EvidenceValidationError(
      "EvidenceStale",
      "Windows checklist was executed after the decision timestamp",
    );
  }
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
  const allowed = new Set([
    "path",
    "pathext",
    "systemroot",
    "windir",
    "home",
    "userprofile",
    "tmp",
    "temp",
    "gh_token",
    "github_token",
    "gh_host",
    "gh_config_dir",
    "xdg_config_home",
    "qualigence_verify_attestations",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase()) && value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

interface ReleaseVerifierInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

type ReleaseVerifierRunner = (
  invocation: ReleaseVerifierInvocation,
) => Promise<void>;

type ReleaseVerifierSnapshotRemover = (snapshotRoot: string) => Promise<void>;

let releaseVerifierRunnerForTests: ReleaseVerifierRunner | undefined;
let releaseVerifierSnapshotRemoverForTests:
  | ReleaseVerifierSnapshotRemover
  | undefined;
const releaseVerifierCleanupFailures = new WeakMap<object, unknown>();

export function setReleaseVerifierRunnerForTests(
  runner: ReleaseVerifierRunner,
): () => void {
  if (process.env["NODE_ENV"] !== "test" || process.env["VITEST"] !== "true") {
    throw new GraphFreezeFinalizationError(
      "FinalizerInputInvalid",
      "the release-verifier test seam is available only inside Vitest",
    );
  }
  if (releaseVerifierRunnerForTests !== undefined) {
    throw new GraphFreezeFinalizationError(
      "FinalizerInputInvalid",
      "the release-verifier test seam is already active",
    );
  }
  releaseVerifierRunnerForTests = runner;
  return () => {
    releaseVerifierRunnerForTests = undefined;
  };
}

export function setReleaseVerifierSnapshotRemoverForTests(
  remover: ReleaseVerifierSnapshotRemover,
): () => void {
  if (process.env["NODE_ENV"] !== "test" || process.env["VITEST"] !== "true") {
    throw new GraphFreezeFinalizationError(
      "FinalizerInputInvalid",
      "the release-verifier cleanup test seam is available only inside Vitest",
    );
  }
  if (releaseVerifierSnapshotRemoverForTests !== undefined) {
    throw new GraphFreezeFinalizationError(
      "FinalizerInputInvalid",
      "the release-verifier cleanup test seam is already active",
    );
  }
  releaseVerifierSnapshotRemoverForTests = remover;
  return () => {
    releaseVerifierSnapshotRemoverForTests = undefined;
  };
}

interface ReleaseVerifierSnapshotReference {
  readonly reference: GraphFreezeEvidenceReference;
  readonly label: string;
  readonly acceptedPrefixes: readonly string[];
}

function releaseVerifierSnapshotReferences(
  input: FinalizeGraphFreezeInput,
  manifest: Record<string, unknown>,
): readonly ReleaseVerifierSnapshotReference[] {
  const releasePrefix = `artifacts/release/${input.version}/`;
  const references: ReleaseVerifierSnapshotReference[] = [
    {
      reference: manifestReference(
        manifest["sbom"],
        "release manifest.sbom",
      ),
      label: "release manifest.sbom",
      acceptedPrefixes: [releasePrefix],
    },
    {
      reference: manifestReference(
        manifest["windowsEvidence"],
        "release manifest.windowsEvidence",
      ),
      label: "release manifest.windowsEvidence",
      acceptedPrefixes: [
        releasePrefix,
        `artifacts/manual-acceptance/${input.version}/`,
      ],
    },
  ];
  const gateEvidence = asRecord(
    manifest["gateEvidence"],
    "release manifest.gateEvidence",
  );
  if (typeof gateEvidence["path"] === "string") {
    references.push({
      reference: manifestReference(
        gateEvidence,
        "release manifest.gateEvidence",
      ),
      label: "release manifest.gateEvidence",
      acceptedPrefixes: [releasePrefix],
    });
  }
  for (const [index, value] of requireArray(
    manifest,
    "gates",
    "release manifest",
  ).entries()) {
    const gate = asRecord(value, `release manifest.gates[${index}]`);
    if (typeof gate["artifactPath"] !== "string") {
      continue;
    }
    references.push({
      reference: {
        path: gate["artifactPath"],
        sha256: requireString(
          gate,
          "artifactSha256",
          `release manifest.gates[${index}]`,
        ),
      },
      label: `release manifest.gates[${index}]`,
      acceptedPrefixes: [releasePrefix],
    });
  }
  if (manifest["releaseCompose"] !== undefined) {
    references.push({
      reference: manifestReference(
        manifest["releaseCompose"],
        "release manifest.releaseCompose",
      ),
      label: "release manifest.releaseCompose",
      acceptedPrefixes: [
        releasePrefix,
        "deployments/self-hosted/compose/",
      ],
    });
  }
  return references;
}

async function runSelectedReleaseVerifier(
  input: FinalizeGraphFreezeInput,
  manifest: Record<string, unknown>,
  manifestBytes: Buffer,
): Promise<void> {
  const source = await repositoryFileAtCommit(
    input,
    "scripts/verify-release-manifest.mjs",
    "ReleaseManifestVerifierInvalid",
    REQUIRED_TICKET_34_REMEDIATION_REMOTE_HEAD,
  );
  const snapshotRoot = await mkdtemp(
    join(input.repositoryRoot, ".tmp-release-verifier-"),
  );
  const verifierPath = join(
    snapshotRoot,
    "scripts",
    "verify-release-manifest.mjs",
  );
  const manifestSnapshotPath = join(
    snapshotRoot,
    "artifacts",
    "release",
    input.version,
    "release-manifest.json",
  );
  let primaryError: unknown;
  try {
    await Promise.all([
      mkdir(dirname(verifierPath), { recursive: true }),
      mkdir(dirname(manifestSnapshotPath), { recursive: true }),
    ]);
    await writeFile(verifierPath, source.text, {
      encoding: "utf8",
      flag: "wx",
    });
    await writeFile(manifestSnapshotPath, manifestBytes, { flag: "wx" });
    const snapshotFiles = new Map<string, Buffer>();
    for (const snapshotReference of releaseVerifierSnapshotReferences(
      input,
      manifest,
    )) {
      const bytes = await readManifestEvidenceBytes(
        input,
        snapshotReference.reference,
        snapshotReference.label,
        snapshotReference.acceptedPrefixes,
      );
      const existing = snapshotFiles.get(snapshotReference.reference.path);
      if (existing !== undefined && !existing.equals(bytes)) {
        throw new EvidenceValidationError(
          "EvidenceDuplicate",
          `${snapshotReference.label} conflicts with another manifest reference`,
        );
      }
      snapshotFiles.set(snapshotReference.reference.path, bytes);
    }
    await Promise.all(
      [...snapshotFiles].map(async ([path, bytes]) => {
        const snapshotPath = join(snapshotRoot, ...path.split("/"));
        await mkdir(dirname(snapshotPath), { recursive: true });
        await writeFile(snapshotPath, bytes, { flag: "wx" });
      }),
    );
    const invocation: ReleaseVerifierInvocation = {
      executable: process.execPath,
      args: [
        verifierPath,
        "verify",
        "--manifest",
        manifestSnapshotPath,
        "--repository",
        input.repository,
        "--commit",
        input.commit,
      ],
      cwd: snapshotRoot,
      env: releaseVerifierEnvironment(),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const runner = releaseVerifierRunnerForTests;
    if (runner === undefined) {
      await execFileAsync(invocation.executable, [...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.env,
        maxBuffer: 4 * 1024 * 1024,
        signal: invocation.signal,
        timeout: 120_000,
      });
    } else {
      await runner(invocation);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      const remover = releaseVerifierSnapshotRemoverForTests;
      if (remover === undefined) {
        await rm(snapshotRoot, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      } else {
        await remover(snapshotRoot);
      }
    } catch (cleanupError) {
      if (
        (typeof primaryError === "object" && primaryError !== null) ||
        typeof primaryError === "function"
      ) {
        releaseVerifierCleanupFailures.set(primaryError, cleanupError);
        throw primaryError;
      }
      throw new GraphFreezeFinalizationError(
        "ReleaseVerifierCleanupFailed",
        `release-verifier snapshot cleanup failed: ${errorMessage(cleanupError)}`,
      );
    }
  }
}

async function validateReleaseManifestEvidence(
  value: unknown,
  input: FinalizeGraphFreezeInput,
  manifestPath: string,
  manifestReferenceValue: GraphFreezeEvidenceReference,
  manifestBytes: Buffer,
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
    timestampMillis(generatedAt, "release manifest.generatedAt") >
    timestampMillis(input.decidedAt, "decidedAt")
  ) {
    throw new EvidenceValidationError(
      "EvidenceStale",
      "release manifest.generatedAt must be valid and no later than decidedAt",
    );
  }

  try {
    await runSelectedReleaseVerifier(input, manifest, manifestBytes);
  } catch (error) {
    const cleanupFailure =
      (typeof error === "object" && error !== null) ||
      typeof error === "function"
        ? releaseVerifierCleanupFailures.get(error)
        : undefined;
    const cleanupSuffix =
      cleanupFailure === undefined
        ? ""
        : `; snapshot cleanup also failed: ${errorMessage(cleanupFailure)}`;
    if (error instanceof GraphFreezeFinalizationError) {
      throw error;
    }
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
          ? `Graph freeze finalization was cancelled during release verification${cleanupSuffix}`
          : `Graph freeze finalization timed out during release verification${cleanupSuffix}`,
      );
    }
    throw new EvidenceValidationError(
      verifierErrorCode(error),
      `Ticket 34 release-manifest verification failed: ${errorMessage(error)}${cleanupSuffix}`,
    );
  }
  await readEvidenceBytes(input, "release-manifest", manifestReferenceValue);

  const windows = asRecord(
    manifest["windowsEvidence"],
    "release manifest.windowsEvidence",
  );
  const windowsReference = manifestReference(
    windows,
    "release manifest.windowsEvidence",
  );
  const releasePrefix = `artifacts/release/${input.version}/`;
  const windowsPayload = windowsChecklistPayload(
    await readManifestEvidenceBytes(
      input,
      windowsReference,
      "release manifest.windowsEvidence",
      [releasePrefix, `artifacts/manual-acceptance/${input.version}/`],
    ),
  );
  const checklist = windowsPayload.checklist;
  validateCompleteWindowsChecklist(windowsPayload, windows, input);
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
  if (
    requireString(
      checklist,
      "runnerProtocolVersion",
      "WindowsChecklistEvidence",
    ) !== REQUIRED_RUNNER_PROTOCOL_VERSION
  ) {
    throw new EvidenceValidationError(
      "WindowsEvidenceProtocolInvalid",
      `Windows checklist does not bind ${REQUIRED_RUNNER_PROTOCOL_VERSION}`,
    );
  }

  const sbomReference = manifestReference(
    manifest["sbom"],
    "release manifest.sbom",
  );
  const gates = requireArray(manifest, "gates", "release manifest");
  const gateReferences = gates.flatMap((value, index) => {
    const gate = asRecord(value, `release manifest.gates[${index}]`);
    const artifactSha256 = requireString(
      gate,
      "artifactSha256",
      `release manifest.gates[${index}]`,
    );
    return typeof gate["artifactPath"] === "string"
      ? [
          {
            path: requireString(
              gate,
              "artifactPath",
              `release manifest.gates[${index}]`,
            ),
            sha256: artifactSha256,
          },
        ]
      : [];
  });
  await Promise.all([
    readManifestEvidenceBytes(input, sbomReference, "release manifest.sbom", [
      releasePrefix,
    ]),
    ...gateReferences.map((reference, index) =>
      readManifestEvidenceBytes(
        input,
        reference,
        `release manifest.gates[${index}]`,
        [releasePrefix],
      ),
    ),
  ]);

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
    const manifestBytes = await readEvidenceBytes(
      input,
      "release-manifest",
      releaseReference,
    );
    const value = parseEvidenceJsonBytes(manifestBytes, "release-manifest");
    const release = await validateReleaseManifestEvidence(
      value,
      input,
      resolve(input.repositoryRoot, ...releaseReference.path.split("/")),
      releaseReference,
      manifestBytes,
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
  validate: (
    value: unknown,
    input: FinalizeGraphFreezeInput,
  ) =>
    | void
    | readonly GraphFreezeEvidenceReference[]
    | Promise<void | readonly GraphFreezeEvidenceReference[]>,
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
    const nestedEvidence = await validate(value, input);
    replaceCapability(capabilities, id, {
      status: "verified",
      evidence: [reference, ...(nestedEvidence ?? [])],
      blockers: [],
    });
  } catch (error) {
    if (error instanceof GraphFreezeFinalizationError) {
      throw error;
    }
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

type DecisionTemporaryRemover = (temporaryPath: string) => Promise<void>;

let decisionTemporaryRemoverForTests: DecisionTemporaryRemover | undefined;

export function setDecisionTemporaryRemoverForTests(
  remover: DecisionTemporaryRemover,
): () => void {
  if (process.env["NODE_ENV"] !== "test" || process.env["VITEST"] !== "true") {
    throw new GraphFreezeFinalizationError(
      "FinalizerInputInvalid",
      "the decision-temporary cleanup test seam is available only inside Vitest",
    );
  }
  if (decisionTemporaryRemoverForTests !== undefined) {
    throw new GraphFreezeFinalizationError(
      "FinalizerInputInvalid",
      "the decision-temporary cleanup test seam is already active",
    );
  }
  decisionTemporaryRemoverForTests = remover;
  return () => {
    decisionTemporaryRemoverForTests = undefined;
  };
}

async function publishDecision(
  repositoryRoot: string,
  path: string,
  bytes: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let primaryError: GraphFreezeFinalizationError | undefined;
  try {
    await assertDecisionOutputPath(repositoryRoot, path);
    await mkdir(dirname(path), { recursive: true });
    await assertDecisionOutputPath(repositoryRoot, path);
    await writeFile(temporary, bytes, { encoding: "utf8", flag: "wx" });
    abortIfRequested(signal);
    await assertDecisionOutputPath(repositoryRoot, path);
    try {
      await link(temporary, path);
    } catch (error) {
      try {
        await assertDecisionOutputPath(repositoryRoot, path);
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
    await assertDecisionOutputPath(repositoryRoot, path);
    const published = await readFile(path, "utf8");
    if (published !== bytes) {
      throw new GraphFreezeFinalizationError(
        "DecisionArtifactConflict",
        `${path} changed during terminal reconciliation`,
      );
    }
  } catch (error) {
    primaryError =
      error instanceof GraphFreezeFinalizationError
        ? error
        : new GraphFreezeFinalizationError(
            "DecisionArtifactWriteFailed",
            `could not atomically publish ${path}: ${errorMessage(error)}`,
          );
    throw primaryError;
  } finally {
    try {
      const remover = decisionTemporaryRemoverForTests;
      if (remover === undefined) {
        await rm(temporary, { force: true });
      } else {
        await remover(temporary);
      }
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        const prefix = `${primaryError.code}: `;
        const primaryMessage = primaryError.message.startsWith(prefix)
          ? primaryError.message.slice(prefix.length)
          : primaryError.message;
        throw new GraphFreezeFinalizationError(
          primaryError.code,
          `${primaryMessage}; temporary cleanup also failed: ${errorMessage(cleanupError)}`,
        );
      }
      try {
        await assertDecisionOutputPath(repositoryRoot, path);
        const published = await readFile(path, "utf8");
        if (published !== bytes) {
          throw cleanupError;
        }
      } catch {
        throw new GraphFreezeFinalizationError(
          "DecisionArtifactWriteFailed",
          `could not clean terminal temporary state for ${path}: ${errorMessage(cleanupError)}`,
        );
      }
    }
  }
}

async function assertDecisionOutputPath(
  repositoryRoot: string,
  path: string,
): Promise<void> {
  const absoluteRoot = resolve(repositoryRoot);
  const absolutePath = resolve(path);
  const lexicalRelative = relative(absoluteRoot, absolutePath);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new GraphFreezeFinalizationError(
      "DecisionArtifactWriteFailed",
      `${path} is outside repository root ${repositoryRoot}`,
    );
  }

  const canonicalRoot = await realpath(absoluteRoot);
  let cursor = absoluteRoot;
  const components = lexicalRelative.split(sep).filter((part) => part !== "");
  for (const [index, component] of components.entries()) {
    cursor = join(cursor, component);
    let stats;
    try {
      stats = await lstat(cursor);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new GraphFreezeFinalizationError(
        "DecisionArtifactWriteFailed",
        `${cursor} is a symbolic-link or junction component`,
      );
    }
    if (index < components.length - 1 && !stats.isDirectory()) {
      throw new GraphFreezeFinalizationError(
        "DecisionArtifactWriteFailed",
        `${cursor} is not a directory`,
      );
    }
    const canonicalCursor = await realpath(cursor);
    const canonicalRelative = relative(canonicalRoot, canonicalCursor);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    ) {
      throw new GraphFreezeFinalizationError(
        "DecisionArtifactWriteFailed",
        `${cursor} resolves outside repository root ${repositoryRoot}`,
      );
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
  await publishDecision(input.repositoryRoot, path, bytes, input.signal);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    decision,
  };
}
