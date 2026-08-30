#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REQUIRED_GATES = ["gate-linux", "gate-windows-rust", "gate-self-hosted", "browser-e2e"];
const REQUIRED_SECURITY_VETO_ITEM_IDS = [
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
];
const MANIFEST_SCHEMA_VERSION = "qualigence-release-manifest/v1";
const WINDOWS_M3_CHECKLIST_VERSION = "windows-m3-manual-checklist/v1";
const SPDX_SCHEMA_VERSION = "SPDX-2.3";
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

class ReleaseManifestError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function asObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseManifestError("ManifestShapeInvalid", `${name} must be an object`);
  }
  return value;
}

function asNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReleaseManifestError("ManifestShapeInvalid", `${name} must be a non-empty string`);
  }
  return value;
}

function assertKeys(record, allowedKeys, name) {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new ReleaseManifestError("ManifestSchemaInvalid", `${name} contains unsupported field ${key}`);
    }
  }
}

function assertSha256(value, name) {
  const text = asNonEmptyString(value, name);
  if (!SHA256_HEX.test(text)) throw new ReleaseManifestError("HashInvalid", `${name} must be lowercase sha256 hex`);
  return text;
}

function assertDigest(value, name) {
  const text = asNonEmptyString(value, name);
  if (!DIGEST.test(text)) throw new ReleaseManifestError("ImageDigestInvalid", `${name} must be sha256:<64 lowercase hex>`);
  return text;
}

function assertDigestReference(value, name) {
  const text = asNonEmptyString(value, name);
  const parts = text.split("@sha256:");
  if (parts.length !== 2 || !SHA256_HEX.test(parts[1])) {
    throw new ReleaseManifestError("MutableImageReference", `${name} must be name@sha256:<digest>`);
  }
  const imageName = parts[0];
  const lastSegment = imageName.slice(imageName.lastIndexOf("/") + 1);
  if (lastSegment.includes(":")) {
    throw new ReleaseManifestError("MutableImageReference", `${name} must not include a tag before the digest`);
  }
  return text;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function writeAtomicNew(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  try {
    await link(temporary, path);
  } catch (error) {
    if (error && error.code === "EEXIST") throw new ReleaseManifestError("ReleaseArtifactAlreadyExists", `${path} already exists`);
    throw new ReleaseManifestError("ReleaseArtifactWriteFailed", `could not atomically write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJson(path, name) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ReleaseManifestError("JsonInvalid", `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertRepoRelativePath(referencedPath, label) {
  const text = asNonEmptyString(referencedPath, label);
  if (isAbsolute(text) || text.split(/[\\/]+/).includes("..")) {
    throw new ReleaseManifestError("ReferencedPathInvalid", `${label} must be a repository-relative path without traversal`);
  }
  return text;
}

function resolveManifestPath(manifestPath, referencedPath) {
  const safePath = assertRepoRelativePath(referencedPath, "referenced path");
  const repoRoot = process.cwd();
  const manifestDir = dirname(resolve(manifestPath));
  const candidates = [resolve(repoRoot, safePath), resolve(manifestDir, safePath)];
  return candidates;
}

async function verifyReferencedHash(manifestPath, referencedPath, expectedSha256, label) {
  const candidates = resolveManifestPath(manifestPath, referencedPath);
  for (const candidate of candidates) {
    try {
      const actual = await sha256File(candidate);
      if (actual !== expectedSha256) {
        throw new ReleaseManifestError("ReferencedHashMismatch", `${label} ${referencedPath} expected ${expectedSha256} but found ${actual}`);
      }
      return candidate;
    } catch (error) {
      if (error instanceof ReleaseManifestError) throw error;
      if (error && error.code !== "ENOENT") throw error;
    }
  }
  throw new ReleaseManifestError("ReferencedFileMissing", `${label} file not found: ${referencedPath}`);
}

function decodeBase64Json(value, label) {
  try {
    return JSON.parse(Buffer.from(asNonEmptyString(value, label), "base64").toString("utf8"));
  } catch (error) {
    throw new ReleaseManifestError("AttestationBundleInvalid", `${label} is not base64 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function validateAttestationBundle(provenance, image, repository, commit, predicateType, label) {
  const bundleKey = predicateType === "spdx" ? "sbomBundle" : "bundle";
  const bundleShaKey = predicateType === "spdx" ? "sbomBundleSha256" : "bundleSha256";
  const bundleText = asNonEmptyString(provenance[bundleKey], `${label}.${bundleKey}`);
  const expectedHash = assertSha256(provenance[bundleShaKey], `${label}.${bundleShaKey}`);
  const actualHash = await sha256Bytes(Buffer.from(bundleText, "utf8"));
  if (actualHash !== expectedHash) throw new ReleaseManifestError("AttestationBundleHashMismatch", `${label} attestation bundle hash does not match manifest`);
  let parsedBundle;
  try { parsedBundle = JSON.parse(bundleText); } catch { throw new ReleaseManifestError("AttestationBundleInvalid", `${label} attestation bundle is not JSON`); }
  const bundle = asObject(parsedBundle, `${label} attestation bundle`);
  const envelope = asObject(bundle.dsseEnvelope ?? bundle.dsse_envelope, `${label} DSSE envelope`);
  const statement = asObject(decodeBase64Json(envelope.payload, `${label}.payload`), `${label} in-toto statement`);
  if (!String(statement.predicateType ?? "").toLowerCase().includes(predicateType)) {
    throw new ReleaseManifestError("AttestationPredicateMismatch", `${label} predicateType does not contain ${predicateType}`);
  }
  if (!Array.isArray(statement.subject)) throw new ReleaseManifestError("AttestationSubjectMissing", `${label} has no subjects`);
  const digestHex = image.digest.slice("sha256:".length);
  const matchingSubject = statement.subject.some((subject) => {
    const item = asObject(subject, `${label} subject`);
    const digest = asObject(item.digest, `${label} subject.digest`);
    return item.name === image.name || item.name === image.reference ? digest.sha256 === digestHex : false;
  });
  if (!matchingSubject) throw new ReleaseManifestError("AttestationSubjectMismatch", `${label} does not bind ${image.reference}`);
  const payloadText = JSON.stringify(statement);
  if (!payloadText.includes(repository)) throw new ReleaseManifestError("AttestationRepositoryMismatch", `${label} does not bind repository ${repository}`);
  if (!payloadText.includes(commit)) throw new ReleaseManifestError("AttestationCommitMismatch", `${label} does not bind commit ${commit}`);
}

function validateAttestationId(value, repository, label) {
  const text = asNonEmptyString(value, label);
  const expectedPrefix = `https://github.com/${repository}/attestations/`;
  if (!text.startsWith(expectedPrefix)) {
    throw new ReleaseManifestError("AttestationReferenceInvalid", `${label} must be a GitHub attestation URL under ${repository}`);
  }
  return text;
}

async function verifyGithubAttestationIfRequested(reference, repository, commit, bundleText, predicateType, label) {
  if (process.env.QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES === "true") return;
  if (process.env.QUALIGENCE_VERIFY_ATTESTATIONS !== "true") {
    throw new ReleaseManifestError("AttestationVerificationUnavailable", `${label} requires QUALIGENCE_VERIFY_ATTESTATIONS=true for release verification`);
  }
  const bundlePath = join(process.cwd(), `.tmp-release-attestation-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(bundlePath, bundleText, "utf8");
  try {
    await execFileAsync("gh", ["attestation", "verify", `oci://${reference}`, "--repo", repository, "--bundle", bundlePath, "--predicate-type", predicateType, "--source-digest", commit], { maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw new ReleaseManifestError("AttestationVerificationFailed", `${label} could not verify the exact attestation bundle: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(bundlePath, { force: true });
  }
}

async function validateImage(manifestPath, image, name, repository, commit) {
  const record = asObject(image, `images.${name}`);
  assertKeys(record, ["name", "digest", "reference", "provenance"], `images.${name}`);
  const imageName = asNonEmptyString(record.name, `images.${name}.name`);
  const digest = assertDigest(record.digest, `images.${name}.digest`);
  const reference = assertDigestReference(record.reference, `images.${name}.reference`);
  if (reference !== `${imageName}@${digest}`) {
    throw new ReleaseManifestError("ImageReferenceMismatch", `images.${name}.reference must equal name@digest`);
  }
  const provenance = asObject(record.provenance, `images.${name}.provenance`);
  assertKeys(provenance, ["attestationId", "bundle", "bundleSha256", "sbomAttestationId", "sbomBundle", "sbomBundleSha256"], `images.${name}.provenance`);
  validateAttestationId(provenance.attestationId, repository, `images.${name}.provenance.attestationId`);
  validateAttestationId(provenance.sbomAttestationId, repository, `images.${name}.provenance.sbomAttestationId`);
  await validateAttestationBundle(provenance, { name: imageName, digest, reference }, repository, commit, "slsa", `images.${name}.provenance`);
  await validateAttestationBundle(provenance, { name: imageName, digest, reference }, repository, commit, "spdx", `images.${name}.provenance.sbom`);
  await verifyGithubAttestationIfRequested(reference, repository, commit, provenance.bundle, "https://slsa.dev/provenance/v1", `images.${name}.provenance`);
  await verifyGithubAttestationIfRequested(reference, repository, commit, provenance.sbomBundle, "https://spdx.dev/Document", `images.${name}.provenance.sbom`);
  return record;
}

function validateSbomBinding(sbomJson, expected) {
  let binding;
  try {
    binding = JSON.parse(asNonEmptyString(sbomJson.documentComment, "SBOM.documentComment"));
  } catch (error) {
    throw new ReleaseManifestError("SbomBindingInvalid", `SBOM documentComment must contain JSON release binding: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = asObject(binding, "SBOM release binding");
  assertKeys(record, ["repository", "commit", "applicationReference", "consoleReference"], "SBOM release binding");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (record[key] !== expectedValue) {
      throw new ReleaseManifestError("SbomBindingMismatch", `SBOM ${key} does not bind manifest ${key}`);
    }
  }
}

async function sha256Bytes(bytes) {
  const hash = createHash("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

function sha256Text(text) {
  const hash = createHash("sha256");
  hash.update(text);
  return hash.digest("hex");
}

function assertZipArchive(bytes, label) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(bytes[2]) || ![0x04, 0x06, 0x08].includes(bytes[3])) {
    throw new ReleaseManifestError("GateArtifactArchiveInvalid", `${label} is not a ZIP archive`);
  }
}

async function readZipEntry(archivePath, entryPath, gateName) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", archivePath, entryPath], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    return Buffer.from(stdout);
  } catch (error) {
    throw new ReleaseManifestError("GateArtifactArchiveInvalid", `${gateName} artifact is missing ${entryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseHashManifest(bytes, gateName) {
  const hashes = new Map();
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const match = /^([a-f0-9]{64}) [ *](.+)$/iu.exec(line);
    if (match === null) throw new ReleaseManifestError("GateArtifactHashManifestInvalid", `${gateName} has malformed hash manifest line`);
    hashes.set(match[2], match[1].toLowerCase());
  }
  return hashes;
}

function assertManifestEntryHash(hashes, path, expected, gateName) {
  if (hashes.get(path) !== expected) throw new ReleaseManifestError("GateArtifactHashManifestInvalid", `${gateName} hash manifest does not bind ${path}`);
}

function resolveArchiveRelative(basePath, relativePath, label) {
  const child = assertRepoRelativePath(relativePath, label);
  const slash = basePath.lastIndexOf("/");
  return slash < 0 ? child : `${basePath.slice(0, slash + 1)}${child}`;
}

async function verifyGateArchiveContents(archivePath, gate, commit) {
  const receiptBytes = await readZipEntry(archivePath, "receipt.json", gate.name);
  const receiptSha256 = await sha256Bytes(receiptBytes);
  if (receiptSha256 !== gate.receiptSha256) throw new ReleaseManifestError("GateArtifactReceiptMismatch", `${gate.name} receipt hash does not match manifest`);
  let receipt;
  try { receipt = JSON.parse(receiptBytes.toString("utf8")); } catch { throw new ReleaseManifestError("GateArtifactReceiptInvalid", `${gate.name} receipt is not JSON`); }
  const receiptRecord = asObject(receipt, `${gate.name} receipt`);
  if (receiptRecord.schemaVersion !== "qualigence-gate-artifact-receipt/v1" || receiptRecord.gate !== gate.name || receiptRecord.commit !== commit) {
    throw new ReleaseManifestError("GateArtifactReceiptInvalid", `${gate.name} receipt does not bind gate and commit`);
  }
  if (receiptRecord.reportSha256 !== gate.reportSha256) {
    throw new ReleaseManifestError("GateArtifactReceiptInvalid", `${gate.name} receipt hashes do not match manifest`);
  }
  const reportPath = assertRepoRelativePath(receiptRecord.report, `${gate.name}.receipt.report`);
  const markerPath = assertRepoRelativePath(receiptRecord.marker, `${gate.name}.receipt.marker`);
  const hashManifestPath = assertRepoRelativePath(receiptRecord.hashManifest, `${gate.name}.receipt.hashManifest`);
  const [reportBytes, markerBytes, hashManifestBytes] = await Promise.all([
    readZipEntry(archivePath, reportPath, gate.name),
    readZipEntry(archivePath, markerPath, gate.name),
    readZipEntry(archivePath, hashManifestPath, gate.name),
  ]);
  const reportSha256 = await sha256Bytes(reportBytes);
  const markerSha256 = await sha256Bytes(markerBytes);
  const hashManifestSha256 = await sha256Bytes(hashManifestBytes);
  if (reportSha256 !== receiptRecord.reportSha256 || markerSha256 !== receiptRecord.markerSha256 || hashManifestSha256 !== receiptRecord.hashManifestSha256) {
    throw new ReleaseManifestError("GateArtifactReceiptInvalid", `${gate.name} receipt hash binding failed`);
  }
  const hashes = parseHashManifest(hashManifestBytes, gate.name);
  assertManifestEntryHash(hashes, reportPath, receiptRecord.reportSha256, gate.name);
  assertManifestEntryHash(hashes, markerPath, receiptRecord.markerSha256, gate.name);
  const report = asObject(JSON.parse(reportBytes.toString("utf8")), `${gate.name} report`);
  const marker = asObject(JSON.parse(markerBytes.toString("utf8")), `${gate.name} marker`);
  if (report.schemaVersion !== "qualigence-gate-report/v1" || report.gate !== gate.name || report.commit !== commit || report.status !== "passed") {
    throw new ReleaseManifestError("GateArtifactReportInvalid", `${gate.name} report is not an accepted same-commit Gate report`);
  }
  const counts = asObject(report.counts, `${gate.name} report.counts`);
  if (!(counts.passed > 0 && counts.failed === 0 && counts.skipped === 0 && counts.todo === 0)) {
    throw new ReleaseManifestError("GateArtifactReportInvalid", `${gate.name} report counts are not zero-skip passing counts`);
  }
  const markerReportPath = resolveArchiveRelative(markerPath, marker.report, `${gate.name}.marker.report`);
  if (marker.schemaVersion !== "qualigence-gate-accepted/v1" || marker.gate !== gate.name || marker.commit !== commit || marker.status !== "accepted" || markerReportPath !== reportPath || marker.reportSha256 !== reportSha256) {
    throw new ReleaseManifestError("GateArtifactMarkerInvalid", `${gate.name} marker does not bind the report`);
  }
  if (!Array.isArray(report.files) || report.files.length !== 1) throw new ReleaseManifestError("GateArtifactReportInvalid", `${gate.name} report must bind exactly one Vitest file`);
  const vitest = asObject(report.files[0], `${gate.name} report.files[0]`);
  const vitestPath = resolveArchiveRelative(reportPath, vitest.path, `${gate.name}.vitest.path`);
  const vitestSha256 = assertSha256(vitest.sha256, `${gate.name}.vitest.sha256`);
  if (gate.vitestSha256 !== vitestSha256) throw new ReleaseManifestError("GateArtifactVitestMismatch", `${gate.name} Vitest hash does not match manifest`);
  assertManifestEntryHash(hashes, vitestPath, vitestSha256, gate.name);
  const vitestBytes = await readZipEntry(archivePath, vitestPath, gate.name);
  const actualVitestSha256 = await sha256Bytes(vitestBytes);
  if (actualVitestSha256 !== vitestSha256) throw new ReleaseManifestError("GateArtifactVitestMismatch", `${gate.name} Vitest JSON hash does not match report`);
  if (Number.isSafeInteger(vitest.bytes) && vitest.bytes !== vitestBytes.byteLength) throw new ReleaseManifestError("GateArtifactVitestMismatch", `${gate.name} Vitest JSON byte count does not match report`);
}

async function verifyGateArtifactBytes(manifestPath, gate, commit) {
  if (gate.artifactPath !== undefined) {
    const artifactPath = resolveManifestPath(manifestPath, assertRepoRelativePath(gate.artifactPath, `${gate.name}.artifactPath`))[0];
    const bytes = await readFile(artifactPath);
    assertZipArchive(bytes, `${gate.name} artifact`);
    const actual = await sha256Bytes(bytes);
    if (actual !== gate.artifactSha256) throw new ReleaseManifestError("GateArtifactHashMismatch", `${gate.name} expected ${gate.artifactSha256} but found ${actual}`);
    await verifyGateArchiveContents(artifactPath, gate, commit);
    return;
  }
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (token === undefined || repository === undefined || gate.artifactId === undefined) {
    throw new ReleaseManifestError("GateArtifactBytesUnavailable", `${gate.name} requires artifactPath or GH_TOKEN/GITHUB_REPOSITORY/artifactId to recompute artifact hash`);
  }
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${gate.artifactId}/zip`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    redirect: "follow",
  });
  if (!response.ok) throw new ReleaseManifestError("GateArtifactDownloadFailed", `${gate.name} artifact ${gate.artifactId} returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assertZipArchive(bytes, `${gate.name} artifact`);
  const actual = await sha256Bytes(bytes);
  if (actual !== gate.artifactSha256) {
    throw new ReleaseManifestError("GateArtifactHashMismatch", `${gate.name} expected ${gate.artifactSha256} but found ${actual}`);
  }
  const archivePath = join(process.cwd(), `.tmp-release-gate-${gate.name}-${process.pid}.zip`);
  await writeFile(archivePath, bytes);
  try {
    await verifyGateArchiveContents(archivePath, gate, commit);
  } finally {
    await rm(archivePath, { force: true });
  }
}

async function validateGateEvidenceReport(manifestPath, gateEvidence, commit) {
  let report;
  const record = asObject(gateEvidence, "gateEvidence");
  if (record.path !== undefined) {
    assertKeys(record, ["path", "sha256"], "gateEvidence");
    const reportPath = await verifyReferencedHash(manifestPath, assertRepoRelativePath(record.path, "gateEvidence.path"), assertSha256(record.sha256, "gateEvidence.sha256"), "Gate evidence report");
    report = asObject(await readJson(reportPath, "Gate evidence report"), "Gate evidence report");
  } else {
    report = record;
  }
  if (report.schemaVersion !== "qualigence-release-gate-evidence/v1" || report.status !== "verified" || report.commit !== commit) {
    throw new ReleaseManifestError("GateEvidenceReportInvalid", "gateEvidence must be a verified same-commit Ticket 33 report");
  }
  if (!Array.isArray(report.deliveries)) throw new ReleaseManifestError("GateEvidenceReportInvalid", "gateEvidence.deliveries must be an array");
  return new Map(report.deliveries.map((delivery) => [asObject(delivery, "gate delivery").gate, delivery]));
}

async function validateRequiredGates(manifestPath, gates, commit, verifiedGateDeliveries) {
  if (!Array.isArray(gates)) throw new ReleaseManifestError("GateArtifactsInvalid", "gates must be an array");
  const seen = new Set();
  for (const gate of gates) {
    const record = asObject(gate, "gate");
    assertKeys(record, ["name", "artifactName", "artifactSha256", "artifactPath", "commit", "runId", "artifactId", "reportSha256", "vitestSha256", "receiptSha256"], "gate");
    const name = asNonEmptyString(record.name, "gate.name");
    if (!REQUIRED_GATES.includes(name)) throw new ReleaseManifestError("GateArtifactUnexpected", `unexpected gate ${name}`);
    if (seen.has(name)) throw new ReleaseManifestError("GateArtifactDuplicate", `duplicate gate ${name}`);
    seen.add(name);
    if (asNonEmptyString(record.commit, `${name}.commit`) !== commit) {
      throw new ReleaseManifestError("GateArtifactCommitMismatch", `${name} does not bind manifest commit`);
    }
    asNonEmptyString(record.artifactName, `${name}.artifactName`);
    assertSha256(record.artifactSha256, `${name}.artifactSha256`);
    if (record.artifactPath !== undefined) assertRepoRelativePath(record.artifactPath, `${name}.artifactPath`);
    assertSha256(record.reportSha256, `${name}.reportSha256`);
    assertSha256(record.vitestSha256, `${name}.vitestSha256`);
    assertSha256(record.receiptSha256, `${name}.receiptSha256`);
    const verified = asObject(verifiedGateDeliveries.get(name), `verified gate delivery ${name}`);
    if (String(verified.artifactId) !== String(record.artifactId)) throw new ReleaseManifestError("GateArtifactMismatch", `${name} artifactId does not match verified report`);
    if (String(verified.runId) !== String(record.runId)) throw new ReleaseManifestError("GateArtifactMismatch", `${name} runId does not match verified report`);
    if (verified.reportSha256 !== record.reportSha256) throw new ReleaseManifestError("GateArtifactMismatch", `${name} reportSha256 does not match verified report`);
    if (verified.vitestSha256 !== record.vitestSha256) throw new ReleaseManifestError("GateArtifactMismatch", `${name} vitestSha256 does not match verified report`);
    if (verified.receiptSha256 !== record.receiptSha256) throw new ReleaseManifestError("GateArtifactMismatch", `${name} receiptSha256 does not match verified report`);
    await verifyGateArtifactBytes(manifestPath, record, commit);
  }
  for (const required of REQUIRED_GATES) {
    if (!seen.has(required)) throw new ReleaseManifestError("GateArtifactMissing", `missing gate ${required}`);
  }
}

function validateWindowsEvidence(windowsEvidence, commit) {
  const record = asObject(windowsEvidence, "windowsEvidence");
  assertKeys(record, ["path", "sha256", "commit", "signatures"], "windowsEvidence");
  if (asNonEmptyString(record.commit, "windowsEvidence.commit") !== commit) {
    throw new ReleaseManifestError("WindowsEvidenceCommitMismatch", "Windows evidence must bind manifest commit");
  }
  assertRepoRelativePath(record.path, "windowsEvidence.path");
  assertSha256(record.sha256, "windowsEvidence.sha256");
  if (!Array.isArray(record.signatures) || record.signatures.length === 0) {
    throw new ReleaseManifestError("WindowsEvidenceUnsigned", "Windows evidence must include at least one signature");
  }
  for (const [index, signature] of record.signatures.entries()) {
    const item = asObject(signature, `windowsEvidence.signatures[${index}]`);
    assertKeys(item, ["signer", "signedAt", "signatureSha256"], `windowsEvidence.signatures[${index}]`);
    asNonEmptyString(item.signer, `windowsEvidence.signatures[${index}].signer`);
    asNonEmptyString(item.signedAt, `windowsEvidence.signatures[${index}].signedAt`);
    assertSha256(item.signatureSha256, `windowsEvidence.signatures[${index}].signatureSha256`);
  }
  return record;
}

function extractWindowsEvidencePayload(bytes) {
  const text = bytes.toString("utf8");
  const jsonCandidates = [];
  try {
    jsonCandidates.push(JSON.parse(text));
  } catch {
    // Signed evidence is commonly Markdown; parse fenced JSON blocks below.
  }
  for (const match of text.matchAll(/```(?:json|jsonc)?\s*([\s\S]*?)```/giu)) {
    try {
      jsonCandidates.push(JSON.parse(match[1]));
    } catch {
      // Ignore non-JSON fenced examples in the checklist body.
    }
  }
  for (const candidate of jsonCandidates) {
    const record = asObject(candidate, "Windows evidence candidate");
    const nested = record.WindowsChecklistEvidence ?? record.windowsChecklistEvidence;
    const evidence = nested === undefined ? record : nested;
    if (evidence && typeof evidence === "object" && evidence.checklistVersion !== undefined) {
      return { checklist: evidence, signatures: record.WindowsChecklistSignatures ?? record.windowsChecklistSignatures ?? evidence.signatures };
    }
  }
  throw new ReleaseManifestError("WindowsChecklistEvidenceUnavailable", "signed Windows evidence does not contain a machine-readable WindowsChecklistEvidence JSON record");
}

function validateEmbeddedWindowsSignatures(embeddedSignatures) {
  if (!Array.isArray(embeddedSignatures) || embeddedSignatures.length === 0) throw new ReleaseManifestError("WindowsEvidenceUnsigned", "signed Windows evidence must embed signature records");
  const bySigner = new Map();
  for (const [index, signature] of embeddedSignatures.entries()) {
    const record = asObject(signature, `WindowsChecklistSignatures[${index}]`);
    assertKeys(record, ["signer", "signedAt", "signature", "signatureSha256"], `WindowsChecklistSignatures[${index}]`);
    const signer = asNonEmptyString(record.signer, `WindowsChecklistSignatures[${index}].signer`).trim();
    asNonEmptyString(record.signedAt, `WindowsChecklistSignatures[${index}].signedAt`);
    const signatureText = asNonEmptyString(record.signature, `WindowsChecklistSignatures[${index}].signature`);
    const signatureSha256 = assertSha256(record.signatureSha256, `WindowsChecklistSignatures[${index}].signatureSha256`);
    if (sha256Text(signatureText) !== signatureSha256) throw new ReleaseManifestError("WindowsEvidenceSignatureMismatch", `${signer} signature hash does not match embedded signature material`);
    bySigner.set(signer, record);
  }
  return bySigner;
}

function validateSessionEvidence(evidence) {
  const sessionEvidence = asObject(evidence.sessionEvidence, "WindowsChecklistEvidence.sessionEvidence");
  const local = sessionEvidence.local;
  const rdp = sessionEvidence.rdp;
  if (!Array.isArray(local) || local.length === 0 || local.some((ref) => typeof ref !== "string" || ref.trim() === "")) {
    throw new ReleaseManifestError("WindowsEvidenceSessionMissing", "Windows checklist must include local-console session evidence");
  }
  if (!Array.isArray(rdp) || rdp.length === 0 || rdp.some((ref) => typeof ref !== "string" || ref.trim() === "")) {
    throw new ReleaseManifestError("WindowsEvidenceSessionMissing", "Windows checklist must include RDP session evidence");
  }
}

function validateWindowsChecklistEvidence(evidence, commit, manifestSignatures, embeddedSignatures) {
  const record = asObject(evidence, "WindowsChecklistEvidence");
  if (record.checklistVersion !== WINDOWS_M3_CHECKLIST_VERSION) throw new ReleaseManifestError("WindowsChecklistVersionInvalid", `expected ${WINDOWS_M3_CHECKLIST_VERSION}`);
  if (record.commit !== commit) throw new ReleaseManifestError("WindowsEvidenceCommitMismatch", "embedded Windows evidence commit does not bind manifest commit");
  const operatorName = asNonEmptyString(record.operatorName, "WindowsChecklistEvidence.operatorName").trim();
  const reviewerName = asNonEmptyString(record.reviewerName, "WindowsChecklistEvidence.reviewerName").trim();
  if (operatorName === reviewerName) throw new ReleaseManifestError("WindowsEvidenceSignerInvalid", "operator and reviewer must be distinct humans");
  if (!Number.isFinite(Date.parse(asNonEmptyString(record.executedAt, "WindowsChecklistEvidence.executedAt")))) throw new ReleaseManifestError("WindowsEvidenceTimestampInvalid", "executedAt must be ISO-8601 parseable");
  if (record.interactiveSessionType !== "local" && record.interactiveSessionType !== "rdp") throw new ReleaseManifestError("WindowsEvidenceSessionInvalid", "interactiveSessionType must be local or rdp");
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0 || record.evidenceRefs.some((ref) => typeof ref !== "string" || ref.trim() === "")) {
    throw new ReleaseManifestError("WindowsEvidenceRefsInvalid", "WindowsChecklistEvidence must include evidenceRefs");
  }
  validateSessionEvidence(record);
  if (!Array.isArray(record.securityVetoItemIds)) throw new ReleaseManifestError("WindowsEvidenceVetoInvalid", "securityVetoItemIds must be an array");
  if (!Array.isArray(record.items)) throw new ReleaseManifestError("WindowsEvidenceItemsInvalid", "items must be an array");
  const attested = new Set(record.securityVetoItemIds);
  const items = new Map(record.items.map((item) => [asObject(item, "WindowsChecklistEvidence item").id, item]));
  for (const id of REQUIRED_SECURITY_VETO_ITEM_IDS) {
    if (!attested.has(id)) throw new ReleaseManifestError("WindowsEvidenceVetoMissing", `security veto ${id} was not attested`);
    const item = asObject(items.get(id), `WindowsChecklistEvidence item ${id}`);
    if (item.result !== "pass") throw new ReleaseManifestError("WindowsEvidenceVetoFailed", `security veto ${id} did not pass`);
  }
  for (const item of record.items) {
    const entry = asObject(item, "WindowsChecklistEvidence item");
    if (entry.result === "fail") throw new ReleaseManifestError("WindowsEvidenceItemFailed", `checklist item ${entry.id} failed`);
  }
  const embeddedBySigner = validateEmbeddedWindowsSignatures(embeddedSignatures);
  const signers = new Set(manifestSignatures.map((signature) => String(signature.signer).trim()));
  if (!signers.has(operatorName) || !signers.has(reviewerName)) {
    throw new ReleaseManifestError("WindowsEvidenceSignatureMismatch", "manifest signatures must include the embedded operator and reviewer names");
  }
  for (const manifestSignature of manifestSignatures) {
    const signer = String(manifestSignature.signer).trim();
    const embedded = embeddedBySigner.get(signer);
    if (embedded === undefined || embedded.signedAt !== manifestSignature.signedAt || embedded.signatureSha256 !== manifestSignature.signatureSha256) {
      throw new ReleaseManifestError("WindowsEvidenceSignatureMismatch", `manifest signature for ${signer} does not match embedded signed evidence`);
    }
  }
}

async function verifyManifest({ manifestPath, expectedRepository, expectedCommit, renderCompose }) {
  const manifest = asObject(await readJson(manifestPath, "release manifest"), "manifest");
  assertKeys(manifest, ["schemaVersion", "version", "repository", "commit", "generatedAt", "images", "sbom", "gateEvidence", "gates", "windowsEvidence", "releaseCompose"], "manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ReleaseManifestError("ManifestSchemaVersionInvalid", `expected ${MANIFEST_SCHEMA_VERSION}`);
  }
  asNonEmptyString(manifest.version, "version");
  if (!Number.isFinite(Date.parse(asNonEmptyString(manifest.generatedAt, "generatedAt")))) throw new ReleaseManifestError("GeneratedAtInvalid", "generatedAt must be ISO-8601 parseable");
  const repository = asNonEmptyString(manifest.repository, "repository");
  const commit = asNonEmptyString(manifest.commit, "commit");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new ReleaseManifestError("CommitInvalid", "commit must be a full lowercase git SHA");
  if (expectedRepository !== undefined && repository !== expectedRepository) {
    throw new ReleaseManifestError("RepositoryMismatch", `expected ${expectedRepository} but found ${repository}`);
  }
  if (expectedCommit !== undefined && commit !== expectedCommit) {
    throw new ReleaseManifestError("CommitMismatch", `expected ${expectedCommit} but found ${commit}`);
  }

  const images = asObject(manifest.images, "images");
  assertKeys(images, ["application", "console"], "images");
  const applicationImage = await validateImage(manifestPath, images.application, "application", repository, commit);
  const consoleImage = await validateImage(manifestPath, images.console, "console", repository, commit);

  const sbom = asObject(manifest.sbom, "sbom");
  assertKeys(sbom, ["path", "sha256", "format"], "sbom");
  if (sbom.format !== "spdx-json") throw new ReleaseManifestError("SbomFormatInvalid", "sbom.format must be spdx-json");
  const sbomPath = assertRepoRelativePath(sbom.path, "sbom.path");
  const sbomSha256 = assertSha256(sbom.sha256, "sbom.sha256");
  const sbomFile = await verifyReferencedHash(manifestPath, sbomPath, sbomSha256, "SBOM");
  const sbomJson = asObject(await readJson(sbomFile, "SBOM"), "SBOM");
  if (sbomJson.spdxVersion !== SPDX_SCHEMA_VERSION) {
    throw new ReleaseManifestError("SbomSchemaInvalid", `SBOM must be ${SPDX_SCHEMA_VERSION}`);
  }
  validateSbomBinding(sbomJson, { repository, commit, applicationReference: applicationImage.reference, consoleReference: consoleImage.reference });

  const verifiedGateDeliveries = await validateGateEvidenceReport(manifestPath, manifest.gateEvidence, commit);
  await validateRequiredGates(manifestPath, manifest.gates, commit, verifiedGateDeliveries);
  const windowsEvidence = validateWindowsEvidence(manifest.windowsEvidence, commit);
  const windowsEvidencePath = await verifyReferencedHash(manifestPath, windowsEvidence.path, windowsEvidence.sha256, "Windows evidence");
  const windowsPayload = extractWindowsEvidencePayload(await readFile(windowsEvidencePath));
  validateWindowsChecklistEvidence(windowsPayload.checklist, commit, windowsEvidence.signatures, windowsPayload.signatures);

  if (manifest.releaseCompose !== undefined) {
    const releaseCompose = asObject(manifest.releaseCompose, "releaseCompose");
    assertKeys(releaseCompose, ["path", "sha256"], "releaseCompose");
    const composePath = assertRepoRelativePath(releaseCompose.path, "releaseCompose.path");
    const composeSha256 = assertSha256(releaseCompose.sha256, "releaseCompose.sha256");
    await verifyReferencedHash(manifestPath, composePath, composeSha256, "release Compose");
  }

  const renderedCompose = renderCompose ? await renderReleaseCompose(manifest, renderCompose) : undefined;
  return { status: "verified", repository, commit, gates: REQUIRED_GATES, renderedCompose };
}

async function renderReleaseCompose(manifest, outputPath) {
  const templatePath = resolve("deployments/self-hosted/compose/compose.release.yaml");
  let content = await readFile(templatePath, "utf8");
  const application = manifest.images.application.reference;
  const consoleImage = manifest.images.console.reference;
  content = content
    .replaceAll("${QUALIGENCE_RELEASE_APPLICATION_IMAGE:?set the digest-pinned application image}", application)
    .replaceAll("${QUALIGENCE_RELEASE_CONSOLE_IMAGE:?set the digest-pinned Console image}", consoleImage);
  assertComposeUsesDigestOnly(content);
  await writeFile(outputPath, content, "utf8");
  return outputPath;
}

function assertComposeUsesDigestOnly(content) {
  const imageLines = content.split(/\r?\n/).filter((line) => /^\s*image:\s*/.test(line));
  if (imageLines.length === 0) throw new ReleaseManifestError("ReleaseComposeInvalid", "release Compose contains no image references");
  for (const line of imageLines) {
    const value = line.replace(/^\s*image:\s*/, "").trim().replace(/^['\"]|['\"]$/g, "");
    assertDigestReference(value, "release Compose image");
  }
}

const FORBIDDEN_TEST_DIRECTORY_NAMES = new Set(["test", "tests", "__tests__", ".git", ".pnpm-store"]);
const FORBIDDEN_FILE_PATTERNS = [/\.ts$/u, /\.tsx$/u, /\.tsbuildinfo$/u, /\.map$/u];
const FORBIDDEN_DEV_PACKAGE_PATTERNS = [
  /(^|\/)node_modules\/(\.pnpm\/)?typescript(@|\/|$)/u,
  /(^|\/)node_modules\/(\.pnpm\/)?vitest(@|\/|$)/u,
  /(^|\/)node_modules\/(\.pnpm\/)?vite(@|\/|$)/u,
  /(^|\/)node_modules\/(\.pnpm\/)?jsdom(@|\/|$)/u,
  /(^|\/)node_modules\/(\.pnpm\/)?@vitejs\+/u,
  /(^|\/)node_modules\/(\.pnpm\/)?@testing-library\+/u,
];

async function listFiles(root) {
  const results = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const info = await stat(full);
        results.push({ path: full, bytes: info.size });
      }
    }
  }
  await walk(root);
  return results;
}

async function scanRuntimeRoot(root) {
  const rootPath = resolve(root);
  const violations = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(rootPath, full).split(sep).join("/");
      if (entry.isDirectory()) {
        const normalized = rel.split("/");
        const isRootSource = normalized.length === 1 && entry.name === "src";
        const isQualigenceSource = rel.includes("/node_modules/@qualigence/") && entry.name === "src";
        if (FORBIDDEN_TEST_DIRECTORY_NAMES.has(entry.name) || isRootSource || isQualigenceSource || FORBIDDEN_DEV_PACKAGE_PATTERNS.some((pattern) => pattern.test(rel))) {
          violations.push(rel);
          continue;
        }
        await walk(full);
      } else if (entry.isFile()) {
        if (FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) violations.push(rel);
        if (FORBIDDEN_DEV_PACKAGE_PATTERNS.some((pattern) => pattern.test(rel))) violations.push(rel);
      }
    }
  }
  await walk(rootPath);
  if (violations.length > 0) {
    throw new ReleaseManifestError("RuntimeImageForbiddenContent", `${root} contains forbidden production content: ${violations.slice(0, 20).join(", ")}`);
  }
  return { status: "clean", root };
}

async function writeSbom({ roots, consoleRoot, output, repository, commit, applicationReference, consoleReference }) {
  const rootEntries = roots.split(",").map((value) => value.trim()).filter(Boolean);
  if (rootEntries.length === 0) throw new ReleaseManifestError("SbomInputInvalid", "--roots must contain at least one deploy root");
  const packages = [];
  const files = [];
  for (const root of rootEntries) {
    const rootPath = resolve(root);
    const packagePath = join(rootPath, "package.json");
    const packageJson = asObject(await readJson(packagePath, `${root}/package.json`), `${root}/package.json`);
    packages.push({ SPDXID: `SPDXRef-Package-${String(packageJson.name).replace(/[^A-Za-z0-9.-]/g, "-")}`, name: packageJson.name, versionInfo: packageJson.version ?? "0.0.0", filesAnalyzed: true });
    for (const file of await listFiles(rootPath)) {
      const rel = relative(process.cwd(), file.path).split(sep).join("/");
      files.push({ fileName: rel, checksums: [{ algorithm: "SHA256", checksumValue: await sha256File(file.path) }], fileTypes: ["SOURCE"] });
    }
  }
  if (consoleRoot !== undefined) {
    const consolePath = resolve(consoleRoot);
    for (const file of await listFiles(consolePath)) {
      const rel = relative(process.cwd(), file.path).split(sep).join("/");
      files.push({ fileName: rel, checksums: [{ algorithm: "SHA256", checksumValue: await sha256File(file.path) }], fileTypes: ["BINARY"] });
    }
  }
  const binding = { repository, commit, applicationReference, consoleReference };
  const bindingHash = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
  const sbom = {
    spdxVersion: SPDX_SCHEMA_VERSION,
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `Qualigence release deploy roots ${commit ?? "unbound"}`,
    documentNamespace: `https://github.com/ljie-PI/Qualigence/spdx/${bindingHash}`,
    documentComment: JSON.stringify(binding),
    creationInfo: { created: new Date(0).toISOString(), creators: ["Tool: scripts/verify-release-manifest.mjs"] },
    packages,
    files,
  };
  await writeAtomicNew(output, `${JSON.stringify(sbom, null, 2)}\n`);
  return output;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    if (command === "verify") {
      const manifest = asNonEmptyString(args.manifest, "--manifest");
      const result = await verifyManifest({
        manifestPath: manifest,
        expectedRepository: typeof args.repository === "string" ? args.repository : process.env.EXPECTED_REPOSITORY,
        expectedCommit: typeof args.commit === "string" ? args.commit : process.env.EXPECTED_COMMIT,
        renderCompose: typeof args["render-compose"] === "string" ? args["render-compose"] : undefined,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (command === "write-sbom") {
      const output = asNonEmptyString(args.output, "--output");
      await writeSbom({
        roots: asNonEmptyString(args.roots, "--roots"),
        consoleRoot: typeof args.console === "string" ? args.console : undefined,
        output,
        repository: typeof args.repository === "string" ? args.repository : undefined,
        commit: typeof args.commit === "string" ? args.commit : undefined,
        applicationReference: typeof args["application-ref"] === "string" ? args["application-ref"] : undefined,
        consoleReference: typeof args["console-ref"] === "string" ? args["console-ref"] : undefined,
      });
      process.stdout.write(`${JSON.stringify({ status: "written", output, sha256: await sha256File(output) }, null, 2)}\n`);
      return;
    }
    if (command === "scan-root") {
      const roots = asNonEmptyString(args.roots, "--roots").split(",").map((value) => value.trim()).filter(Boolean);
      const results = [];
      for (const root of roots) results.push(await scanRuntimeRoot(root));
      process.stdout.write(`${JSON.stringify({ status: "clean", roots: results }, null, 2)}\n`);
      return;
    }
    throw new ReleaseManifestError("Usage", "expected verify --manifest <path>, write-sbom --roots <csv> --output <path>, or scan-root --roots <csv>");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

export { REQUIRED_GATES, ReleaseManifestError, assertComposeUsesDigestOnly, scanRuntimeRoot, verifyManifest, writeSbom };
