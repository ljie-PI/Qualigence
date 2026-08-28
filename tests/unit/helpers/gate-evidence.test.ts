import { describe, expect, it } from "vitest";
import {
  countsFromVitestJson,
  verifyGateDeliveries,
  type GateDelivery,
  type GateReport,
} from "../../helpers/gate-evidence.js";

const COMMIT = "a".repeat(40);
const REQUIRED = ["gate-linux", "browser-e2e", "gate-windows-rust", "gate-self-hosted"] as const;

function report(gate: string): GateReport {
  return {
    schemaVersion: "qualigence-gate-report/v1",
    gate,
    commit: COMMIT,
    command: ["pnpm", "vitest", "run"],
    selection: [`tests/${gate}`],
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
    ...overrides,
  };
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

  it("rejects wrong-SHA and non-zero-skip delivery reports", () => {
    const valid = REQUIRED.map((gate, index) => delivery(gate, String(index)));
    expect(() => verifyGateDeliveries(COMMIT, REQUIRED, [...valid.filter((item) => item.gate !== "gate-linux"), delivery("gate-linux", "wrong-sha", { commit: "b".repeat(40) })])).toThrow("GateArtifactCommitMismatch");
    const skippedReport = { ...report("gate-linux"), counts: { passed: 2, failed: 0, skipped: 1, todo: 0 }, status: "failed" as const };
    expect(() => verifyGateDeliveries(COMMIT, REQUIRED, [...valid.filter((item) => item.gate !== "gate-linux"), delivery("gate-linux", "skipped", { report: skippedReport })])).toThrow("GateArtifactReportInvalid");
  });

  it("rejects cancellation after dispatch and upload, report-hash, or terminal-marker failures", () => {
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
  });
});
