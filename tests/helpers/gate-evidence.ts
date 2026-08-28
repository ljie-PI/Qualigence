import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

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
    if (report.commit !== expectedCommit || report.gate !== delivery.gate || report.status !== "passed" || report.counts.failed !== 0 || report.counts.skipped !== 0) {
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
  readonly archive_download_url: string;
  readonly workflow_run?: { readonly id: number; readonly head_sha: string };
}

async function githubJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GateArtifactInventoryFailed: ${response.status}`);
  return response.json();
}

async function extractGateArtifact(artifact: GithubArtifact, token: string): Promise<Pick<GateDelivery, "report" | "reportSha256" | "marker">> {
  const response = await fetch(artifact.archive_download_url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GateArtifactDownloadFailed: ${artifact.name}/${artifact.id}`);
  const directory = await mkdtemp(join(tmpdir(), "qualigence-gate-artifact-"));
  const archive = join(directory, "artifact.zip");
  try {
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const { stdout } = await promisify(execFile)("unzip", ["-Z1", archive], { maxBuffer: 1_048_576 });
    const paths = stdout.split(/\r?\n/).filter(Boolean);
    const reportPath = await matchingGateFile(directory, paths, artifact.name, "report.json");
    const markerPath = await matchingGateFile(directory, paths, artifact.name, "accepted.json");
    if (reportPath === undefined || markerPath === undefined) return { report: undefined, reportSha256: undefined, marker: undefined };
    const [reportText, markerText, reportSha256] = await Promise.all([readFile(reportPath, "utf8"), readFile(markerPath, "utf8"), sha256File(reportPath)]);
    return { report: JSON.parse(reportText) as GateReport, reportSha256, marker: JSON.parse(markerText) as AcceptedGateMarker };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function matchingGateFile(directory: string, paths: readonly string[], gate: string, name: string): Promise<string | undefined> {
  for (const entry of paths) {
    if (!entry.endsWith(`/${name}`) && entry !== name) continue;
    const path = join(directory, entry);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { readonly gate?: unknown };
      if (parsed.gate === gate) return path;
    } catch {
      // Ignore unrelated diagnostic JSON; only a parsed matching Gate file is evidence.
    }
  }
  return undefined;
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
    status: counts.failed === 0 && counts.skipped === 0 ? "passed" : "failed",
    environment: environment(),
    files: await hashesFor(dirname(reportPath), reportPath),
  };
  await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}

async function acceptGate(reportPath: string, markerPath: string): Promise<void> {
  const report = JSON.parse(await readFile(reportPath, "utf8")) as GateReport;
  if (report.schemaVersion !== "qualigence-gate-report/v1" || report.status !== "passed" || report.counts.failed !== 0 || report.counts.skipped !== 0) {
    throw new Error("GateReportNotAcceptable");
  }
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
    // pnpm is a Windows .cmd shim; use the shell only on Windows so the same
    // fixed Gate command is executable on local and hosted runners.
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
