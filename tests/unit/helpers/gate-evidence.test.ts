import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countsFromVitestJson,
  extractGateArtifactArchive,
  isGateReportAcceptable,
  PHASE1_RELEASE_METADATA_COMMAND,
  RELEASE_VERIFIER_UNAVAILABLE,
  selectGateDeliveries,
  verifyGateDeliveries,
  writePhase1ReleaseBlockedMetadata,
  writePhase1ReleaseMetadataReceipt,
  type GateDelivery,
  type GateReport,
} from "../../helpers/gate-evidence.js";

const COMMIT = "a".repeat(40);
const REQUIRED = ["gate-linux", "browser-e2e", "gate-windows-rust", "gate-self-hosted"] as const;

function report(gate: string): GateReport {
  const declaration: Record<string, { command: string[]; selection: string[] }> = {
    "gate-linux": { command: ["pnpm", "vitest", "run", "--no-file-parallelism", "--maxWorkers=1", "tests/e2e/web-console", "tests/e2e/web-execution"], selection: ["tests/e2e/web-console", "tests/e2e/web-execution"] },
    "browser-e2e": { command: ["pnpm", "vitest", "run", "tests/e2e/web-console/browser-workflow.test.ts"], selection: ["tests/e2e/web-console/browser-workflow.test.ts"] },
    "gate-windows-rust": { command: ["pnpm", "vitest", "run", "tests/e2e/windows/companion-client.test.ts", "tests/e2e/windows/desktop-runner.test.ts", "tests/e2e/windows/named-pipe-authority.test.ts", "tests/contract/desktop", "tests/component/windows-uia", "tests/replay/windows-uia", "tests/conformance/observation/windows-uia.test.ts"], selection: ["tests/e2e/windows/companion-client.test.ts", "tests/e2e/windows/desktop-runner.test.ts", "tests/e2e/windows/named-pipe-authority.test.ts", "tests/contract/desktop", "tests/component/windows-uia", "tests/replay/windows-uia", "tests/conformance/observation/windows-uia.test.ts"] },
    "gate-self-hosted": { command: ["pnpm", "vitest", "run", "tests/e2e/self-hosted"], selection: ["tests/e2e/self-hosted"] },
  };
  const expected = declaration[gate]!;
  return {
    schemaVersion: "qualigence-gate-report/v1",
    gate,
    commit: COMMIT,
    command: expected.command,
    selection: expected.selection,
    counts: { passed: 3, failed: 0, skipped: 0, todo: 0 },
    status: "passed",
    environment: { node: "v24.0.0" },
    files: [{ path: "vitest.json", sha256: "b".repeat(64), bytes: 12 }],
  };
}

function delivery(gate: string, suffix: string, overrides: Partial<GateDelivery> = {}): GateDelivery {
  const gateReport = report(gate);
  const hash = `${suffix}`.padEnd(64, "0");
  return {
    gate,
    artifactId: `${gate}-${suffix}`,
    runId: `run-${suffix}`,
    commit: COMMIT,
    runStatus: "completed",
    runConclusion: "success",
    cancelled: false,
    report: gateReport,
    reportSha256: hash,
    marker: {
      schemaVersion: "qualigence-gate-accepted/v1",
      gate,
      commit: COMMIT,
      report: "report.json",
      reportSha256: hash,
      status: "accepted",
    },
    vitest: { path: "vitest.json", sha256: "c".repeat(64), counts: { passed: 3, failed: 0, skipped: 0, todo: 0 } },
    receiptSha256: "d".repeat(64),
    ...overrides,
  };
}

interface ZipEntry {
  readonly path: string;
  readonly content: Uint8Array;
  readonly declaredBytes?: number;
}

function zip(entries: readonly ZipEntry[]): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const content = Buffer.from(entry.content);
    const bytes = entry.declaredBytes ?? content.byteLength;
    const crc = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(content.byteLength, 18);
    header.writeUInt32LE(bytes, 22);
    header.writeUInt16LE(name.byteLength, 26);
    local.push(header, name, content);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(content.byteLength, 20);
    record.writeUInt32LE(bytes, 24);
    record.writeUInt16LE(name.byteLength, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.byteLength + name.byteLength + content.byteLength;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function archiveFixture(options: { readonly extraEntries?: readonly ZipEntry[]; readonly reportContent?: Uint8Array; readonly receiptReportHash?: string; readonly vitestContent?: Uint8Array; readonly omitVitest?: boolean } = {}): Uint8Array {
  const vitest = options.vitestContent ?? Buffer.from(JSON.stringify({
    numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: [
      { name: "/work/tests/e2e/web-console/workflow.test.ts", assertionResults: [{ status: "passed" }] },
      { name: "/work/tests/e2e/web-execution/value-ref.test.ts", assertionResults: [{ status: "passed" }] },
    ],
  }));
  const expectedReport = Buffer.from(JSON.stringify({
    ...report("gate-linux"),
    counts: { passed: 2, failed: 0, skipped: 0, todo: 0 },
    files: [{ path: "vitest.json", sha256: hash(vitest), bytes: vitest.byteLength }],
  }));
  const actualReport = options.reportContent ?? expectedReport;
  const marker = Buffer.from(JSON.stringify({
    schemaVersion: "qualigence-gate-accepted/v1",
    gate: "gate-linux",
    commit: COMMIT,
    report: "report.json",
    reportSha256: hash(expectedReport),
    status: "accepted",
  }));
  const manifest = Buffer.from([
    `${hash(expectedReport)}  gate-evidence/report.json`,
    `${hash(marker)}  gate-evidence/accepted.json`,
    `${hash(vitest)}  gate-evidence/vitest.json`,
    "",
  ].join("\n"));
  const receipt = Buffer.from(JSON.stringify({
    schemaVersion: "qualigence-gate-artifact-receipt/v1",
    gate: "gate-linux",
    commit: COMMIT,
    report: "gate-evidence/report.json",
    reportSha256: options.receiptReportHash ?? hash(expectedReport),
    marker: "gate-evidence/accepted.json",
    markerSha256: hash(marker),
    hashManifest: "sha256.txt",
    hashManifestSha256: hash(manifest),
  }));
  return zip([
    { path: "receipt.json", content: receipt },
    { path: "sha256.txt", content: manifest },
    { path: "gate-evidence/report.json", content: actualReport },
    { path: "gate-evidence/accepted.json", content: marker },
    ...(options.omitVitest ? [] : [{ path: "gate-evidence/vitest.json", content: vitest }]),
    ...(options.extraEntries ?? []),
  ]);
}

function extractionInput(archive: Uint8Array) {
  return { gate: "gate-linux", artifactId: 17, archive, artifactDigest: `sha256:${hash(archive)}` };
}

function workflowJob(source: string, name: string): string {
  const header = `\n  ${name}:\n`;
  const start = source.indexOf(header);
  expect(start, `missing workflow job ${name}`).toBeGreaterThan(-1);
  const from = start + 1;
  const rest = source.slice(from + `  ${name}:\n`.length);
  const next = rest.search(/\n  [A-Za-z0-9_-]+:\n/);
  return next === -1 ? source.slice(from) : source.slice(from, from + `  ${name}:\n`.length + next);
}

describe("Gate evidence verifier", () => {
  it("counts only Vitest's selected JSON results", () => {
    expect(countsFromVitestJson({ numPassedTests: 7, numFailedTests: 0, numPendingTests: 1, numTodoTests: 2 })).toEqual({
      passed: 7,
      failed: 0,
      skipped: 1,
      todo: 2,
    });
    expect(countsFromVitestJson({ testResults: [{ assertionResults: [{ status: "passed" }, { status: "skipped" }, { status: "todo" }, { status: "failed" }] }] })).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
      todo: 1,
    });
  });

  it("keeps separately immutable successful deliveries for the same commit", () => {
    const first = REQUIRED.map((gate, index) => delivery(gate, String(index + 1)));
    const secondLinux = delivery("gate-linux", "second-linux");
    const verified = verifyGateDeliveries(COMMIT, REQUIRED, [...first, secondLinux]);

    expect(verified.filter((item) => item.gate === "gate-linux")).toHaveLength(2);
    expect(new Set(verified.map((item) => item.artifactId)).size).toBe(5);
  });

  it("rejects cancellation before dispatch because it has no accepted artifact", () => {
    const deliveries = REQUIRED.filter((gate) => gate !== "browser-e2e").map((gate, index) => delivery(gate, String(index)));
    expect(() => verifyGateDeliveries(COMMIT, REQUIRED, deliveries)).toThrow("GateArtifactUnavailable: browser-e2e");
  });

  it("rejects arbitrary selection/command, zero-work, wrong-SHA, skipped, and todo-only delivery reports at every acceptance boundary", () => {
    const valid = REQUIRED.map((gate, index) => delivery(gate, String(index)));
    expect(() => verifyGateDeliveries(COMMIT, REQUIRED, [...valid.filter((item) => item.gate !== "gate-linux"), delivery("gate-linux", "wrong-sha", { commit: "b".repeat(40) })])).toThrow("GateArtifactCommitMismatch");
    const arbitraryReport = { ...report("gate-linux"), command: ["pnpm", "vitest", "run", "tests/unit"] };
    expect(() => verifyGateDeliveries(COMMIT, REQUIRED, [...valid.filter((item) => item.gate !== "gate-linux"), delivery("gate-linux", "arbitrary", { report: arbitraryReport })])).toThrow("GateArtifactReportInvalid");
    const zeroReport = { ...report("gate-linux"), counts: { passed: 0, failed: 0, skipped: 0, todo: 0 } };
    expect(() => verifyGateDeliveries(COMMIT, REQUIRED, [...valid.filter((item) => item.gate !== "gate-linux"), delivery("gate-linux", "zero", { report: zeroReport, vitest: { path: "vitest.json", sha256: "c".repeat(64), counts: zeroReport.counts } })])).toThrow("GateArtifactReportInvalid");
    const skippedReport = { ...report("gate-linux"), counts: { passed: 2, failed: 0, skipped: 1, todo: 0 }, status: "failed" as const };
    expect(() => verifyGateDeliveries(COMMIT, REQUIRED, [...valid.filter((item) => item.gate !== "gate-linux"), delivery("gate-linux", "skipped", { report: skippedReport })])).toThrow("GateArtifactReportInvalid");
    const todoReport = { ...report("gate-linux"), counts: { passed: 2, failed: 0, skipped: 0, todo: 1 } };
    expect(isGateReportAcceptable(todoReport)).toBe(false);
    expect(() => verifyGateDeliveries(COMMIT, REQUIRED, [...valid.filter((item) => item.gate !== "gate-linux"), delivery("gate-linux", "todo", { report: todoReport })])).toThrow("GateArtifactReportInvalid");
  });

  it("preserves failed/cancelled delivery history while accepting a later separate receipt-valid same-SHA delivery", () => {
    const valid = REQUIRED.map((gate, index) => delivery(gate, String(index)));
    const failed = delivery("gate-linux", "failed", { runConclusion: "failure", invalidReason: "GateArtifactTerminalStateInvalid: gate-linux/failed" });
    const cancelled = delivery("gate-linux", "cancelled", { cancelled: true, runConclusion: "cancelled" });
    const selection = selectGateDeliveries(COMMIT, REQUIRED, [...valid.filter((item) => item.gate !== "gate-linux"), failed, cancelled, delivery("gate-linux", "later-good")]);

    expect(selection.deliveries.filter((item) => item.gate === "gate-linux")).toHaveLength(1);
    expect(selection.deliveries.find((item) => item.gate === "gate-linux")?.artifactId).toBe("gate-linux-later-good");
    expect(selection.rejectedDeliveries.map((item) => item.artifactId)).toEqual(["gate-linux-failed", "gate-linux-cancelled"]);
  });

  it("rejects cancellation after dispatch and upload, report-hash, malformed Vitest, or terminal-marker failures", async () => {
    const valid = REQUIRED.map((gate, index) => delivery(gate, String(index)));
    const cases: Array<[string, GateDelivery]> = [
      ["post-dispatch cancellation", delivery("gate-linux", "cancelled", { cancelled: true, runConclusion: "cancelled" })],
      ["failed upload", delivery("gate-linux", "upload", { report: undefined, marker: undefined, reportSha256: undefined })],
      ["hash mismatch", delivery("gate-linux", "mismatch", { marker: { ...delivery("gate-linux", "mismatch").marker!, reportSha256: "f".repeat(64) } })],
      ["missing terminal marker", delivery("gate-linux", "marker", { marker: undefined })],
    ];
    for (const [name, invalid] of cases) {
      expect(() => verifyGateDeliveries(COMMIT, REQUIRED, [...valid.filter((item) => item.gate !== "gate-linux"), invalid]), name).toThrow();
    }
    await expect(extractGateArtifactArchive(extractionInput(archiveFixture({ omitVitest: true })))).rejects.toThrow("GateArtifactAcceptanceMissing");
    await expect(extractGateArtifactArchive(extractionInput(archiveFixture({ vitestContent: Buffer.from("not json") })))).rejects.toThrow("GateArtifactVitestInvalid");
    const mismatched = Buffer.from(JSON.stringify({ numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [{ name: "/work/tests/e2e/web-console/workflow.test.ts", assertionResults: [{ status: "passed" }] }] }));
    await expect(extractGateArtifactArchive(extractionInput(archiveFixture({ vitestContent: mismatched })))).rejects.toThrow("GateArtifactVitestInvalid");
  });

  it("extracts and verifies fresh real ZIP receipts independently on sequential successful deliveries", async () => {
    const first = archiveFixture();
    const second = archiveFixture();
    const firstExtracted = await extractGateArtifactArchive(extractionInput(first));
    const secondExtracted = await extractGateArtifactArchive({ ...extractionInput(second), artifactId: 18 });
    expect(firstExtracted.report?.gate).toBe("gate-linux");
    expect(firstExtracted.reportSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(firstExtracted.marker?.status).toBe("accepted");
    expect(secondExtracted.vitest?.counts.passed).toBe(2);
    expect(secondExtracted.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects tampered, absent, ambiguous, traversal, and oversized ZIP entries", async () => {
    const tampered = archiveFixture({ reportContent: Buffer.from("tampered") });
    await expect(extractGateArtifactArchive(extractionInput(tampered))).rejects.toThrow("GateArtifactReceiptInvalid");

    const absentReceipt = Buffer.from(JSON.stringify({
      schemaVersion: "qualigence-gate-artifact-receipt/v1", gate: "gate-linux", commit: COMMIT,
      report: "gate-evidence/report.json", reportSha256: "a".repeat(64),
      marker: "gate-evidence/accepted.json", markerSha256: "b".repeat(64),
      hashManifest: "sha256.txt", hashManifestSha256: "c".repeat(64),
    }));
    const absent = zip([{ path: "receipt.json", content: absentReceipt }]);
    await expect(extractGateArtifactArchive(extractionInput(absent))).rejects.toThrow("GateArtifactAcceptanceMissing");

    const ambiguous = archiveFixture({ extraEntries: [{ path: "gate-evidence/report.json", content: Buffer.from("duplicate") }] });
    await expect(extractGateArtifactArchive(extractionInput(ambiguous))).rejects.toThrow("GateArtifactArchiveAmbiguous");

    const traversal = archiveFixture({ extraEntries: [{ path: "../receipt.json", content: Buffer.from("bad") }] });
    await expect(extractGateArtifactArchive(extractionInput(traversal))).rejects.toThrow("GateArtifactArchivePathInvalid");

    const digestMismatch = archiveFixture();
    await expect(extractGateArtifactArchive({ ...extractionInput(digestMismatch), artifactDigest: `sha256:${"0".repeat(64)}` })).rejects.toThrow("GateArtifactDigestMismatch");

    const oversized = archiveFixture({ extraEntries: [{ path: "large.bin", content: Buffer.from("x"), declaredBytes: 33 * 1024 * 1024 }] });
    await expect(extractGateArtifactArchive(extractionInput(oversized))).rejects.toThrow("GateArtifactArchiveSizeInvalid");
  });

  it("binds phase-1 release-block metadata to verified delivery counts and a hash manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qualigence-release-metadata-"));
    try {
      const paths = {
        command: join(directory, "command.txt"),
        commit: join(directory, "commit.txt"),
        environment: join(directory, "environment.txt"),
        gateArtifacts: join(directory, "gate-artifacts.json"),
        releaseBlocked: join(directory, "release-blocked.json"),
        manifest: join(directory, "sha256.txt"),
        receipt: join(directory, "receipt.json"),
      };
      await writeFile(paths.command, `${PHASE1_RELEASE_METADATA_COMMAND}\n`);
      await writeFile(paths.commit, `${COMMIT}\n`);
      await writeFile(paths.environment, "node=v24.13.0\npnpm=11.7.0\ngit=git version 2.52.0\nrunner_os=Linux\nrunner_arch=X64\n");
      await writeFile(paths.gateArtifacts, JSON.stringify({
        schemaVersion: "qualigence-release-gate-evidence/v1", commit: COMMIT, status: "verified", deliveries: [{ gate: "gate-linux" }, { gate: "browser-e2e" }], rejectedDeliveries: [{ gate: "gate-linux" }],
      }));
      await writePhase1ReleaseBlockedMetadata({ commit: COMMIT, gateArtifactsPath: paths.gateArtifacts, outputPath: paths.releaseBlocked });
      const blocked = JSON.parse(await readFile(paths.releaseBlocked, "utf8"));
      expect(blocked).toMatchObject({ status: "release-blocked", commit: COMMIT, verifier: { verifiedDeliveryCount: 2, rejectedDeliveryCount: 1 }, missingEvidence: ["WindowsChecklistEvidenceUnavailable", "RealProviderEvidenceUnavailable"] });
      const manifestFiles: readonly (readonly [string, string])[] = [
        ["command.txt", paths.command], ["commit.txt", paths.commit], ["environment.txt", paths.environment], ["gate-artifacts.json", paths.gateArtifacts], ["release-blocked.json", paths.releaseBlocked],
      ];
      const manifestEntries = await Promise.all(manifestFiles.map(async ([name, path]) => `${hash(await readFile(path))}  ${name}`));
      await writeFile(paths.manifest, `${manifestEntries.join("\n")}\n`);
      await writePhase1ReleaseMetadataReceipt({ directory, receiptPath: paths.receipt });
      expect(JSON.parse(await readFile(paths.receipt, "utf8"))).toMatchObject({ status: "release-blocked", commit: COMMIT, verifiedDeliveryCount: 2, rejectedDeliveryCount: 1, command: "command.txt", hashManifest: "sha256.txt" });
      await writeFile(paths.environment, "node=v24\n");
      await expect(writePhase1ReleaseMetadataReceipt({ directory, receiptPath: paths.receipt })).rejects.toThrow("ReleaseMetadataNotAcceptable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits the explicit phase-1 verifier block instead of a generic script failure", () => {
    const command = spawnSync(process.execPath, ["--experimental-strip-types", "tests/helpers/gate-evidence.ts", "release-unavailable"], { cwd: process.cwd(), encoding: "utf8" });
    expect(command.status).toBe(1);
    expect(`${command.stdout}${command.stderr}`).toContain(RELEASE_VERIFIER_UNAVAILABLE);
    expect(`${command.stdout}${command.stderr}`).not.toContain("Missing script");
  });

  it("pins the release receipt toolchain and classifies Rust provisioning failure before the Windows Gate", async () => {
    const [ci, windows] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/windows-companion.yml", "utf8"),
    ]);
    const setupNode = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
    const releaseJob = ci.slice(ci.indexOf("  release-metadata:"));
    const setupNodeIndex = releaseJob.indexOf(setupNode);
    const corepackIndex = releaseJob.indexOf("corepack enable");
    const nodeCheckIndex = releaseJob.indexOf("node --version | grep -Eq '^v24\\.'");
    const pnpmCheckIndex = releaseJob.indexOf('test "$(corepack pnpm --version)" = 11.7.0');
    const helperIndex = releaseJob.lastIndexOf("node --experimental-strip-types tests/helpers/gate-evidence.ts verify-github");
    expect(releaseJob).toContain("node-version: 24");
    expect(setupNodeIndex).toBeGreaterThan(-1);
    expect(corepackIndex).toBeGreaterThan(setupNodeIndex);
    expect(nodeCheckIndex).toBeGreaterThan(corepackIndex);
    expect(pnpmCheckIndex).toBeGreaterThan(nodeCheckIndex);
    expect(helperIndex).toBeGreaterThan(pnpmCheckIndex);

    const rustupLookup = windows.indexOf("$rustup = Get-Command rustup -ErrorAction SilentlyContinue");
    const missingRustup = windows.indexOf("if ($null -eq $rustup) { Exit-CargoUnavailable }");
    const install = windows.indexOf("& $rustup.Path toolchain install 1.96.1 --profile minimal --component rustfmt *> gate-windows-rust/rustup.txt");
    const caughtInstallFailure = windows.indexOf("} catch {\n            $rustupExit = 1");
    const classifiedInstallFailure = windows.indexOf("if ($rustupExit -ne 0) { Exit-CargoUnavailable }");
    const hostedPreflight = windows.indexOf("tests/helpers/infrastructure-preflight.ts windows cargo rustfmt openssl");
    const hostedRun = windows.indexOf("tests/helpers/gate-evidence.ts run --gate gate-windows-rust");
    const companion = windows.indexOf("corepack pnpm gate:companion");
    expect(windows).toContain("[Console]::Error.WriteLine('CargoUnavailable')");
    expect(rustupLookup).toBeGreaterThan(-1);
    expect(missingRustup).toBeGreaterThan(rustupLookup);
    expect(install).toBeGreaterThan(missingRustup);
    expect(caughtInstallFailure).toBeGreaterThan(install);
    expect(classifiedInstallFailure).toBeGreaterThan(caughtInstallFailure);
    expect(hostedPreflight).toBeGreaterThan(classifiedInstallFailure);
    expect(hostedRun).toBeGreaterThan(hostedPreflight);
    expect(companion).toBeGreaterThan(hostedRun);
    expect(windows).not.toContain("corepack pnpm gate:windows");
  });

  it("asserts Node 24 with a single-backslash pattern in every required Gate job", async () => {
    const [ci, selfHosted, windows] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/self-hosted.yml", "utf8"),
      readFile(".github/workflows/windows-companion.yml", "utf8"),
    ]);
    const linuxAssertion = "node --version | grep -Eq '^v24\\.'";
    const linuxDoubleBackslash = "node --version | grep -Eq '^v24\\\\.'";
    const windowsAssertion = "(node --version) -notmatch '^v24\\.'";
    const linuxJobs: ReadonlyArray<readonly [string, string]> = [
      ["gate-linux", workflowJob(ci, "gate-linux")],
      ["browser-e2e", workflowJob(ci, "browser-e2e")],
      ["release-metadata", workflowJob(ci, "release-metadata")],
      ["gate-self-hosted", workflowJob(selfHosted, "gate-self-hosted")],
    ];
    for (const [name, job] of linuxJobs) {
      expect(job, name).toContain(linuxAssertion);
      expect(job, name).not.toContain(linuxDoubleBackslash);
    }
    const windowsJob = workflowJob(windows, "gate-windows-rust");
    expect(windowsJob).toContain(windowsAssertion);
    expect(windowsJob).not.toContain(linuxDoubleBackslash);
    expect(ci).not.toContain(linuxDoubleBackslash);
    expect(selfHosted).not.toContain(linuxDoubleBackslash);
    expect(/^v24\./.test("v24.13.0")).toBe(true);
    expect(/^v24\\./.test("v24.13.0")).toBe(false);
  });

  it("keeps local Windows 11 preflight while hosted Windows/Rust maps only non-Windows hosts", async () => {
    const [windows, packageJson, preflight, helper] = await Promise.all([
      readFile(".github/workflows/windows-companion.yml", "utf8"),
      readFile("package.json", "utf8"),
      readFile("tests/helpers/infrastructure-preflight.ts", "utf8"),
      readFile("tests/helpers/gate-evidence.ts", "utf8"),
    ]);
    const hostedJob = workflowJob(windows, "gate-windows-rust");
    expect(packageJson).toContain("infrastructure-preflight.ts windows11 chromium cargo rustfmt openssl");
    expect(hostedJob).toContain("infrastructure-preflight.ts windows cargo rustfmt openssl");
    expect(hostedJob).toContain("infrastructure-preflight.ts chromium");
    expect(hostedJob).not.toContain("infrastructure-preflight.ts windows11");
    expect(hostedJob).toContain("tests/e2e/windows/companion-client.test.ts");
    expect(hostedJob).toContain("tests/e2e/windows/desktop-runner.test.ts");
    expect(hostedJob).toContain("tests/e2e/windows/named-pipe-authority.test.ts");
    expect(hostedJob).toContain("tests/contract/desktop");
    expect(hostedJob).toContain("tests/component/windows-uia");
    expect(hostedJob).toContain("tests/replay/windows-uia");
    expect(hostedJob).toContain("tests/conformance/observation/windows-uia.test.ts");
    expect(hostedJob).toContain("corepack pnpm gate:companion");
    expect(hostedJob).not.toMatch(/continue-on-error:\s*true/);
    expect(hostedJob).not.toMatch(/\bskip\b/i);
    expect(preflight).toContain('case "windows":');
    expect(preflight).toContain('return process.platform === "win32" ? undefined : "Windows11Unavailable"');
    expect(preflight).toContain('case "windows11":');
    expect(helper).toContain('"--reporter=dot"');
    expect(helper).toContain('"--reporter=json"');
    expect(helper).toContain("`--outputFile.json=${vitestPath}`");
    expect(helper).toContain("writeGateStatus(\"run\", report)");
    expect(helper).toContain("writeGateStatus(\"accept\", report)");
    expect(helper).toContain("GateEvidence ${phase} gate=${report.gate} status=${report.status} commit=${report.commit} passed=${report.counts.passed} failed=${report.counts.failed} skipped=${report.counts.skipped} todo=${report.counts.todo}");
  });

  it("copies Gate evidence into diagnostic artifacts on failure without writing an accepted marker", async () => {
    const [ci, selfHosted, windows] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/self-hosted.yml", "utf8"),
      readFile(".github/workflows/windows-companion.yml", "utf8"),
    ]);
    const jobs: ReadonlyArray<readonly [string, string, string, string]> = [
      ["gate-linux", workflowJob(ci, "gate-linux"), ".gate-evidence/gate-linux", "gate-linux/gate-linux"],
      ["browser-e2e", workflowJob(ci, "browser-e2e"), ".gate-evidence/browser-e2e", "browser-e2e/gate-evidence"],
      ["gate-self-hosted", workflowJob(selfHosted, "gate-self-hosted"), ".gate-evidence/gate-self-hosted", "gate-self-hosted/gate-evidence"],
      ["gate-windows-rust", workflowJob(windows, "gate-windows-rust"), ".gate-evidence/gate-windows-rust", "gate-windows-rust/gate-evidence"],
    ];
    for (const [name, job, source, destination] of jobs) {
      expect(job, name).toContain("name: Preserve Gate diagnostics");
      expect(job, name).toMatch(/Preserve Gate diagnostics[\s\S]*if: always\(\)/);
      expect(job, name).toContain(source);
      expect(job, name).toContain(destination);
      expect(job, name).toContain("if-no-files-found: error");
      const preserveStart = job.indexOf("name: Preserve Gate diagnostics");
      const uploadStart = job.lastIndexOf("uses: actions/upload-artifact@");
      expect(preserveStart, name).toBeGreaterThan(-1);
      expect(uploadStart, name).toBeGreaterThan(preserveStart);
      const preserve = job.slice(preserveStart, uploadStart);
      expect(preserve, name).not.toContain("gate-evidence.ts accept");
      expect(preserve, name).not.toContain("accepted.json");
      expect(preserve, name).not.toContain("receipt.json");
    }
  });

  it("pins every third-party workflow action to a reviewed 40-character SHA", async () => {
    const files = [".github/workflows/ci.yml", ".github/workflows/self-hosted.yml", ".github/workflows/windows-companion.yml"];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const uses = [...source.matchAll(/^\s+- uses: ([^\s]+)$/gm)].map((match) => match[1]!);
      expect(uses.length, file).toBeGreaterThan(0);
      for (const action of uses) {
        expect(action, `${file} ${action}`).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/);
        expect(action, `${file} ${action}`).not.toMatch(/@v\d/);
      }
      expect(source, file).toMatch(/# v\d+\.\d+\.\d+, reviewed immutable action commit\./);
    }
  });
});
