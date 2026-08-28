import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1_024;
const MAX_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;

export interface GateCounts {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly todo: number;
}

export interface GateReport {
  readonly schemaVersion: "qualigence-gate-report/v1";
  readonly gate: string;
  readonly commit: string;
  readonly command: readonly string[];
  readonly selection: readonly string[];
  readonly counts: GateCounts;
  readonly status: "passed" | "failed";
  readonly environment: Readonly<Record<string, string>>;
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
}

export interface AcceptedGateMarker {
  readonly schemaVersion: "qualigence-gate-accepted/v1";
  readonly gate: string;
  readonly commit: string;
  readonly report: string;
  readonly reportSha256: string;
  readonly status: "accepted";
}

interface GateArtifactReceipt {
  readonly schemaVersion: "qualigence-gate-artifact-receipt/v1";
  readonly gate: string;
  readonly commit: string;
  readonly report: string;
  readonly reportSha256: string;
  readonly marker: string;
  readonly markerSha256: string;
  readonly hashManifest: string;
  readonly hashManifestSha256: string;
}

export interface GateDelivery {
  readonly gate: string;
  readonly artifactId: string | number;
  readonly runId: string | number;
  readonly commit: string;
  readonly runStatus: string;
  readonly runConclusion: string | null;
  readonly cancelled: boolean;
  readonly report: GateReport | undefined;
  readonly reportSha256: string | undefined;
  readonly marker: AcceptedGateMarker | undefined;
}

export interface VerifiedGateDelivery {
  readonly gate: string;
  readonly artifactId: string | number;
  readonly runId: string | number;
  readonly commit: string;
  readonly reportSha256: string;
}

export function countsFromVitestJson(value: unknown): GateCounts {
  const root = asRecord(value, "Vitest JSON report");
  const testResults = Array.isArray(root.testResults) ? root.testResults : [];
  let passed = numberValue(root.numPassedTests);
  let failed = numberValue(root.numFailedTests);
  let skipped = numberValue(root.numPendingTests);
  let todo = numberValue(root.numTodoTests);
  if (testResults.length > 0 && passed + failed + skipped + todo === 0) {
    for (const result of testResults) {
      const assertions = asRecord(result, "Vitest test result").assertionResults;
      if (!Array.isArray(assertions)) continue;
      for (const assertion of assertions) {
        switch (asRecord(assertion, "Vitest assertion").status) {
          case "passed": passed += 1; break;
          case "failed": failed += 1; break;
          case "pending": case "skipped": skipped += 1; break;
          case "todo": todo += 1; break;
          default: break;
        }
      }
    }
  }
  return { passed, failed, skipped, todo };
}

export function isGateReportAcceptable(report: GateReport): boolean {
  return report.schemaVersion === "qualigence-gate-report/v1"
    && report.status === "passed"
    && report.counts.failed === 0
    && report.counts.skipped === 0
    && report.counts.todo === 0;
}

/** Verify only the reports selected by a declared Gate; unrelated repository tests are never inspected. */
export function verifyGateDeliveries(expectedCommit: string, requiredGates: readonly string[], deliveries: readonly GateDelivery[]): readonly VerifiedGateDelivery[] {
  const verified: VerifiedGateDelivery[] = [];
  const seenArtifactIds = new Set<string>();
  for (const delivery of deliveries) {
    const artifactIdentity = `${delivery.gate}:${String(delivery.artifactId)}`;
    if (seenArtifactIds.has(artifactIdentity)) throw new Error(`GateArtifactAmbiguous: duplicate artifact record ${artifactIdentity}`);
    seenArtifactIds.add(artifactIdentity);
    if (!requiredGates.includes(delivery.gate)) continue;
    if (delivery.cancelled || delivery.runStatus !== "completed" || delivery.runConclusion !== "success") {
      throw new Error(`GateArtifactTerminalStateInvalid: ${delivery.gate}/${delivery.artifactId}`);
    }
    if (delivery.commit !== expectedCommit) throw new Error(`GateArtifactCommitMismatch: ${delivery.gate}/${delivery.artifactId}`);
    const report = delivery.report;
    const marker = delivery.marker;
    if (report === undefined || marker === undefined || delivery.reportSha256 === undefined) {
      throw new Error(`GateArtifactAcceptanceMissing: ${delivery.gate}/${delivery.artifactId}`);
    }
    if (report.commit !== expectedCommit || report.gate !== delivery.gate || !isGateReportAcceptable(report)) {
      throw new Error(`GateArtifactReportInvalid: ${delivery.gate}/${delivery.artifactId}`);
    }
    if (marker.schemaVersion !== "qualigence-gate-accepted/v1" || marker.status !== "accepted" || marker.gate !== delivery.gate || marker.commit !== expectedCommit || marker.reportSha256 !== delivery.reportSha256) {
      throw new Error(`GateArtifactMarkerInvalid: ${delivery.gate}/${delivery.artifactId}`);
    }
    verified.push({ gate: delivery.gate, artifactId: delivery.artifactId, runId: delivery.runId, commit: expectedCommit, reportSha256: delivery.reportSha256 });
  }
  for (const gate of requiredGates) {
    if (!verified.some((delivery) => delivery.gate === gate)) throw new Error(`GateArtifactUnavailable: ${gate}`);
  }
  return verified;
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Downloads each immutable GitHub delivery separately and verifies the Gate's
 * own report/accepted marker. Same-SHA reruns remain distinct records; no
 * artifact inventory entry is treated as success without its terminal run.
 */
export async function verifyGithubGateArtifacts(input: {
  readonly repository: string;
  readonly token: string;
  readonly commit: string;
  readonly requiredGates: readonly string[];
}): Promise<readonly VerifiedGateDelivery[]> {
  const artifacts = await githubJson(`https://api.github.com/repos/${input.repository}/actions/artifacts?per_page=100`, input.token) as { readonly artifacts?: readonly GithubArtifact[] };
  const deliveries: GateDelivery[] = [];
  for (const artifact of artifacts.artifacts ?? []) {
    const workflowRun = artifact.workflow_run;
    if (!input.requiredGates.includes(artifact.name) || artifact.expired === true || workflowRun === undefined || workflowRun.head_sha !== input.commit) continue;
    const run = await githubJson(`https://api.github.com/repos/${input.repository}/actions/runs/${workflowRun.id}`, input.token) as { readonly status?: string; readonly conclusion?: string | null };
    const extracted = await extractGateArtifact(artifact, input.token);
    deliveries.push({
      gate: artifact.name,
      artifactId: artifact.id,
      runId: workflowRun.id,
      commit: workflowRun.head_sha,
      runStatus: run.status ?? "unknown",
      runConclusion: run.conclusion ?? null,
      cancelled: run.conclusion === "cancelled",
      ...extracted,
    });
  }
  return verifyGateDeliveries(input.commit, input.requiredGates, deliveries);
}

interface GithubArtifact {
  readonly id: number;
  readonly name: string;
  readonly expired?: boolean;
  readonly size_in_bytes?: number;
  readonly digest?: string;
  readonly archive_download_url: string;
  readonly workflow_run?: { readonly id: number; readonly head_sha: string };
}

interface ArchiveEntry {
  readonly path: string;
  readonly compressedBytes: number;
  readonly bytes: number;
}

async function githubJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GateArtifactInventoryFailed: ${response.status}`);
  return response.json();
}

async function extractGateArtifact(artifact: GithubArtifact, token: string): Promise<Pick<GateDelivery, "report" | "reportSha256" | "marker">> {
  if (artifact.size_in_bytes !== undefined && (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 0 || artifact.size_in_bytes > MAX_ARCHIVE_BYTES)) {
    throw new Error(`GateArtifactArchiveSizeInvalid: ${artifact.name}/${artifact.id}`);
  }
  const response = await fetch(artifact.archive_download_url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GateArtifactDownloadFailed: ${artifact.name}/${artifact.id}`);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ARCHIVE_BYTES)) {
    throw new Error(`GateArtifactArchiveSizeInvalid: ${artifact.name}/${artifact.id}`);
  }
  const archive = await readBoundedArchive(response, `${artifact.name}/${artifact.id}`);
  return extractGateArtifactArchive({ gate: artifact.name, artifactId: artifact.id, archive, artifactDigest: artifact.digest });
}

async function readBoundedArchive(response: Response, identity: string): Promise<Uint8Array> {
  if (response.body === null) throw new Error(`GateArtifactArchiveInvalid: ${identity}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_ARCHIVE_BYTES) throw new Error(`GateArtifactArchiveSizeInvalid: ${identity}`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const archive = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

/** Reads a real ZIP delivery only after validating the immutable GitHub digest and archive inventory. */
export async function extractGateArtifactArchive(input: {
  readonly gate: string;
  readonly artifactId: string | number;
  readonly archive: Uint8Array;
  readonly artifactDigest: string | undefined;
}): Promise<Pick<GateDelivery, "report" | "reportSha256" | "marker">> {
  const identity = `${input.gate}/${input.artifactId}`;
  if (input.archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error(`GateArtifactArchiveSizeInvalid: ${identity}`);
  if (input.artifactDigest === undefined || !/^sha256:[a-f0-9]{64}$/i.test(input.artifactDigest)) throw new Error(`GateArtifactDigestMissing: ${identity}`);
  const archiveHash = sha256(input.archive);
  if (archiveHash !== input.artifactDigest.slice("sha256:".length).toLowerCase()) throw new Error(`GateArtifactDigestMismatch: ${identity}`);

  const entries = zipEntries(input.archive, identity);
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const directory = await mkdtemp(join(tmpdir(), "qualigence-gate-artifact-"));
  const archive = join(directory, "artifact.zip");
  try {
    await writeFile(archive, input.archive);
    await assertUnzipAvailable(identity);
    const receiptBytes = await readArchiveEntry(archive, entryByPath, "receipt.json", identity);
    const receipt = parseReceipt(receiptBytes, input.gate, identity);
    const reportPath = receipt.report;
    const markerPath = receipt.marker;
    const manifestPath = receipt.hashManifest;
    const [reportBytes, markerBytes, manifestBytes] = await Promise.all([
      readArchiveEntry(archive, entryByPath, reportPath, identity),
      readArchiveEntry(archive, entryByPath, markerPath, identity),
      readArchiveEntry(archive, entryByPath, manifestPath, identity),
    ]);
    if (sha256(reportBytes) !== receipt.reportSha256 || sha256(markerBytes) !== receipt.markerSha256 || sha256(manifestBytes) !== receipt.hashManifestSha256) {
      throw new Error(`GateArtifactReceiptInvalid: ${identity}`);
    }
    const manifest = parseHashManifest(manifestBytes, identity);
    assertManifestHash(manifest, reportPath, receipt.reportSha256, identity);
    assertManifestHash(manifest, markerPath, receipt.markerSha256, identity);
    const report = JSON.parse(Buffer.from(reportBytes).toString("utf8")) as GateReport;
    const marker = JSON.parse(Buffer.from(markerBytes).toString("utf8")) as AcceptedGateMarker;
    const declaredReportPath = resolveArchivePath(markerPath, marker.report, identity);
    if (receipt.commit !== report.commit || receipt.commit !== marker.commit || declaredReportPath !== reportPath || marker.reportSha256 !== receipt.reportSha256) throw new Error(`GateArtifactMarkerInvalid: ${identity}`);
    await verifyReportInputs(archive, entryByPath, reportPath, report, manifest, identity);
    return { report, reportSha256: receipt.reportSha256, marker };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GateArtifact")) throw error;
    throw new Error(`GateArtifactArchiveInvalid: ${identity}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function zipEntries(archive: Uint8Array, identity: string): readonly ArchiveEntry[] {
  const end = findEndOfCentralDirectory(archive);
  if (end < 0 || end + 22 > archive.byteLength) throw new Error(`GateArtifactArchiveInvalid: ${identity}`);
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const entryCount = view.getUint16(end + 10, true);
  const centralDirectoryBytes = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (entryCount === 0xffff || centralDirectoryBytes === 0xffffffff || offset === 0xffffffff || entryCount > MAX_ARCHIVE_ENTRIES || offset + centralDirectoryBytes > archive.byteLength) {
    throw new Error(`GateArtifactArchiveSizeInvalid: ${identity}`);
  }
  const paths = new Set<string>();
  const entries: ArchiveEntry[] = [];
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error(`GateArtifactArchiveInvalid: ${identity}`);
    const flags = view.getUint16(offset + 8, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const bytes = view.getUint32(offset + 24, true);
    const nameBytes = view.getUint16(offset + 28, true);
    const extraBytes = view.getUint16(offset + 30, true);
    const commentBytes = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const pathEnd = offset + 46 + nameBytes;
    const next = pathEnd + extraBytes + commentBytes;
    if (next > archive.byteLength || compressedBytes === 0xffffffff || bytes === 0xffffffff) throw new Error(`GateArtifactArchiveInvalid: ${identity}`);
    const path = Buffer.from(archive.subarray(offset + 46, pathEnd)).toString((flags & 0x0800) !== 0 ? "utf8" : "binary");
    assertArchivePath(path, identity);
    if ((flags & 0x0001) !== 0 || (externalAttributes >>> 16 & 0xf000) === 0xa000) throw new Error(`GateArtifactArchiveInvalid: ${identity}`);
    if (paths.has(path)) throw new Error(`GateArtifactArchiveAmbiguous: ${identity}`);
    if (bytes > MAX_ARCHIVE_ENTRY_BYTES || totalBytes + bytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error(`GateArtifactArchiveSizeInvalid: ${identity}`);
    paths.add(path);
    entries.push({ path, compressedBytes, bytes });
    totalBytes += bytes;
    offset = next;
  }
  if (offset !== view.getUint32(end + 16, true) + centralDirectoryBytes) throw new Error(`GateArtifactArchiveInvalid: ${identity}`);
  return entries;
}

function findEndOfCentralDirectory(archive: Uint8Array): number {
  for (let offset = archive.byteLength - 22; offset >= Math.max(0, archive.byteLength - 65_557); offset -= 1) {
    if (archive[offset] === 0x50 && archive[offset + 1] === 0x4b && archive[offset + 2] === 0x05 && archive[offset + 3] === 0x06) return offset;
  }
  return -1;
}

function assertArchivePath(path: string, identity: string): void {
  if (path.length === 0 || path.length > 512 || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[a-z]:/i.test(path)) {
    throw new Error(`GateArtifactArchivePathInvalid: ${identity}`);
  }
  const directory = path.endsWith("/");
  const segments = (directory ? path.slice(0, -1) : path).split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new Error(`GateArtifactArchivePathInvalid: ${identity}`);
}

async function assertUnzipAvailable(identity: string): Promise<void> {
  try {
    await promisify(execFile)("unzip", ["-v"], { maxBuffer: 16 * 1024 });
  } catch {
    throw new Error(`GateArtifactExtractionUnavailable: ${identity}`);
  }
}

async function readArchiveEntry(archive: string, entries: ReadonlyMap<string, ArchiveEntry>, path: string, identity: string): Promise<Uint8Array> {
  assertArchivePath(path, identity);
  const entry = entries.get(path);
  if (entry === undefined || path.endsWith("/")) throw new Error(`GateArtifactAcceptanceMissing: ${identity}`);
  try {
    const { stdout } = await promisify(execFile)("unzip", ["-p", archive, path], { encoding: "buffer", maxBuffer: MAX_ARCHIVE_ENTRY_BYTES + 1 });
    const bytes = new Uint8Array(stdout);
    if (bytes.byteLength !== entry.bytes || bytes.byteLength > MAX_ARCHIVE_ENTRY_BYTES) throw new Error(`GateArtifactArchiveSizeInvalid: ${identity}`);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GateArtifact")) throw error;
    throw new Error(`GateArtifactArchiveInvalid: ${identity}`);
  }
}

function parseReceipt(bytes: Uint8Array, gate: string, identity: string): GateArtifactReceipt {
  let receipt: GateArtifactReceipt;
  try { receipt = JSON.parse(Buffer.from(bytes).toString("utf8")) as GateArtifactReceipt; } catch { throw new Error(`GateArtifactReceiptInvalid: ${identity}`); }
  if (receipt.schemaVersion !== "qualigence-gate-artifact-receipt/v1" || receipt.gate !== gate || !isCommit(receipt.commit)
    || !safeRelativePath(receipt.report) || !safeRelativePath(receipt.marker) || !safeRelativePath(receipt.hashManifest)
    || !SHA256.test(receipt.reportSha256) || !SHA256.test(receipt.markerSha256) || !SHA256.test(receipt.hashManifestSha256)) {
    throw new Error(`GateArtifactReceiptInvalid: ${identity}`);
  }
  return receipt;
}

function parseHashManifest(bytes: Uint8Array, identity: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of Buffer.from(bytes).toString("utf8").split(/\r?\n/)) {
    if (line.length === 0) continue;
    const match = /^([a-f0-9]{64}) [ *](.+)$/i.exec(line);
    if (match === null || !safeRelativePath(match[2]!)) throw new Error(`GateArtifactHashManifestInvalid: ${identity}`);
    if (entries.has(match[2]!)) throw new Error(`GateArtifactHashManifestInvalid: ${identity}`);
    entries.set(match[2]!, match[1]!.toLowerCase());
  }
  return entries;
}

function assertManifestHash(manifest: ReadonlyMap<string, string>, path: string, hash: string, identity: string): void {
  if (manifest.get(path) !== hash.toLowerCase()) throw new Error(`GateArtifactHashManifestInvalid: ${identity}`);
}

async function verifyReportInputs(archive: string, entries: ReadonlyMap<string, ArchiveEntry>, reportPath: string, report: GateReport, manifest: ReadonlyMap<string, string>, identity: string): Promise<void> {
  if (!Array.isArray(report.files)) throw new Error(`GateArtifactReportInvalid: ${identity}`);
  const filePaths = new Set<string>();
  for (const file of report.files) {
    if (!safeRelativePath(file.path) || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error(`GateArtifactReportInvalid: ${identity}`);
    }
    const path = resolveArchivePath(reportPath, file.path, identity);
    if (filePaths.has(path)) throw new Error(`GateArtifactReportInvalid: ${identity}`);
    filePaths.add(path);
    assertManifestHash(manifest, path, file.sha256, identity);
    const bytes = await readArchiveEntry(archive, entries, path, identity);
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256.toLowerCase()) throw new Error(`GateArtifactReportInvalid: ${identity}`);
  }
}

function resolveArchivePath(fromPath: string, child: string, identity: string): string {
  if (!safeRelativePath(child)) throw new Error(`GateArtifactArchivePathInvalid: ${identity}`);
  const parent = fromPath.split("/").slice(0, -1);
  const path = [...parent, ...child.split("/")].join("/");
  if (!safeRelativePath(path)) throw new Error(`GateArtifactArchivePathInvalid: ${identity}`);
  return path;
}

function safeRelativePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 512 && !path.includes("\\") && !path.includes("\0")
    && !path.startsWith("/") && !/^[a-z]:/i.test(path) && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runGate(gate: string, reportPath: string, selection: readonly string[], command: readonly string[]): Promise<void> {
  if (selection.length === 0 || command.length === 0) throw new Error("GateEvidenceArgumentsInvalid");
  await mkdir(dirname(reportPath), { recursive: true });
  const vitestPath = join(dirname(reportPath), "vitest.json");
  await rm(vitestPath, { force: true });
  const exitCode = await runCommand(command[0]!, [...command.slice(1), "--reporter=json", `--outputFile=${vitestPath}`]);
  let counts: GateCounts = { passed: 0, failed: 1, skipped: 0, todo: 0 };
  if (await exists(vitestPath)) {
    counts = countsFromVitestJson(JSON.parse(await readFile(vitestPath, "utf8")));
  }
  if (exitCode !== 0 && counts.failed === 0) counts = { ...counts, failed: 1 };
  const report: GateReport = {
    schemaVersion: "qualigence-gate-report/v1",
    gate,
    commit: await currentCommit(),
    command,
    selection,
    counts,
    status: counts.failed === 0 && counts.skipped === 0 && counts.todo === 0 ? "passed" : "failed",
    environment: environment(),
    files: await hashesFor(dirname(reportPath), reportPath),
  };
  await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!isGateReportAcceptable(report)) process.exitCode = 1;
}

async function acceptGate(reportPath: string, markerPath: string): Promise<void> {
  const report = JSON.parse(await readFile(reportPath, "utf8")) as GateReport;
  if (!isGateReportAcceptable(report)) throw new Error("GateReportNotAcceptable");
  const marker: AcceptedGateMarker = {
    schemaVersion: "qualigence-gate-accepted/v1",
    gate: report.gate,
    commit: report.commit,
    report: relative(dirname(markerPath), reportPath).replaceAll("\\", "/"),
    reportSha256: await sha256File(reportPath),
    status: "accepted",
  };
  await writeAtomic(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

async function writeReceipt(gate: string, reportPath: string, markerPath: string, hashManifestPath: string, receiptPath: string): Promise<void> {
  const [reportSha256, markerSha256, hashManifestSha256, report, marker] = await Promise.all([
    sha256File(reportPath), sha256File(markerPath), sha256File(hashManifestPath), readFile(reportPath, "utf8"), readFile(markerPath, "utf8"),
  ]);
  const parsedReport = JSON.parse(report) as GateReport;
  const parsedMarker = JSON.parse(marker) as AcceptedGateMarker;
  if (!isGateReportAcceptable(parsedReport) || parsedMarker.reportSha256 !== reportSha256 || parsedMarker.report !== relative(dirname(markerPath), reportPath).replaceAll("\\", "/")) {
    throw new Error("GateReceiptNotAcceptable");
  }
  const receipt: GateArtifactReceipt = {
    schemaVersion: "qualigence-gate-artifact-receipt/v1",
    gate,
    commit: parsedReport.commit,
    report: relative(dirname(receiptPath), reportPath).replaceAll("\\", "/"),
    reportSha256,
    marker: relative(dirname(receiptPath), markerPath).replaceAll("\\", "/"),
    markerSha256,
    hashManifest: relative(dirname(receiptPath), hashManifestPath).replaceAll("\\", "/"),
    hashManifestSha256,
  };
  if (parsedReport.gate !== gate || parsedMarker.gate !== gate || parsedMarker.commit !== receipt.commit || !safeRelativePath(receipt.report) || !safeRelativePath(receipt.marker) || !safeRelativePath(receipt.hashManifest)) {
    throw new Error("GateReceiptNotAcceptable");
  }
  const manifest = parseHashManifest(await readFile(hashManifestPath), `local/${gate}`);
  assertManifestHash(manifest, receipt.report, receipt.reportSha256, `local/${gate}`);
  assertManifestHash(manifest, receipt.marker, receipt.markerSha256, `local/${gate}`);
  await writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

async function hashesFor(directory: string, reportPath: string): Promise<GateReport["files"]> {
  const entries = await (async (): Promise<string[]> => {
    const output: string[] = [];
    async function visit(path: string): Promise<void> {
      const children = await (await import("node:fs/promises")).readdir(path, { withFileTypes: true });
      for (const child of children) {
        const childPath = join(path, child.name);
        if (child.isDirectory()) await visit(childPath);
        else if (childPath !== reportPath) output.push(childPath);
      }
    }
    await visit(directory);
    return output.sort();
  })();
  return Promise.all(entries.map(async (path) => ({ path: relative(directory, path).replaceAll("\\", "/"), sha256: await sha256File(path), bytes: (await stat(path)).size })));
}

async function currentCommit(): Promise<string> {
  if (process.env.GITHUB_SHA !== undefined && /^[0-9a-f]{40}$/i.test(process.env.GITHUB_SHA)) return process.env.GITHUB_SHA;
  let output = "";
  const status = await runCommand("git", ["rev-parse", "HEAD"], (chunk) => { output += chunk; });
  if (status !== 0) throw new Error("GateCommitUnavailable");
  return output.trim();
}

function environment(): Record<string, string> {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ci: process.env.CI ?? "",
    pnpm: process.env.npm_config_user_agent?.match(/pnpm\/([^\s]+)/)?.[1] ?? "",
  };
}

function runCommand(command: string, args: readonly string[], onOutput?: (chunk: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: onOutput === undefined ? "inherit" : ["ignore", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
    if (onOutput !== undefined) child.stdout?.on("data", (chunk: Buffer) => onOutput(chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object") throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "run") {
    const separator = args.indexOf("--");
    const gate = argument(args, "--gate");
    const report = argument(args, "--report");
    const selection = values(args.slice(0, separator < 0 ? args.length : separator), "--selection");
    if (separator < 0 || gate === undefined || report === undefined) throw new Error("GateEvidenceArgumentsInvalid");
    await runGate(gate, report, selection, args.slice(separator + 1));
    return;
  }
  if (mode === "accept") {
    const report = argument(args, "--report");
    const marker = argument(args, "--marker");
    if (report === undefined || marker === undefined) throw new Error("GateEvidenceArgumentsInvalid");
    await acceptGate(report, marker);
    return;
  }
  if (mode === "receipt") {
    const gate = argument(args, "--gate");
    const report = argument(args, "--report");
    const marker = argument(args, "--marker");
    const hashes = argument(args, "--hashes");
    const receipt = argument(args, "--receipt");
    if (gate === undefined || report === undefined || marker === undefined || hashes === undefined || receipt === undefined) throw new Error("GateEvidenceArgumentsInvalid");
    await writeReceipt(gate, report, marker, hashes, receipt);
    return;
  }
  if (mode === "verify-github") {
    const report = argument(args, "--report");
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_TOKEN;
    const commit = process.env.EXPECTED_COMMIT;
    if (report === undefined || repository === undefined || token === undefined || commit === undefined) throw new Error("GateEvidenceEnvironmentInvalid");
    try {
      const deliveries = await verifyGithubGateArtifacts({ repository, token, commit, requiredGates: ["gate-linux", "browser-e2e", "gate-windows-rust", "gate-self-hosted"] });
      await writeAtomic(report, `${JSON.stringify({ schemaVersion: "qualigence-release-gate-evidence/v1", commit, status: "verified", deliveries }, null, 2)}\n`);
    } catch (error) {
      await writeAtomic(report, `${JSON.stringify({ schemaVersion: "qualigence-release-gate-evidence/v1", commit, status: "gate-blocked", reason: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
      throw error;
    }
    return;
  }
  throw new Error("GateEvidenceModeInvalid");
}

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function values(args: readonly string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) result.push(args[index + 1]!);
  }
  return result;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
