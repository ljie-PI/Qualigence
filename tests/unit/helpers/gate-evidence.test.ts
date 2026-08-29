import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  countsFromVitestJson,
  extractGateArtifactArchive,
  isGateReportAcceptable,
  selectGateDeliveries,
  verifyGateDeliveries,
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
});
