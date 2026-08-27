import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const WPF_PROJECT = join(process.cwd(), "tests", "fixtures", "windows-reference-wpf", "WindowsReferenceWpf.csproj");
const WINUI_PROJECT = join(process.cwd(), "tests", "fixtures", "windows-reference-winui", "WindowsReferenceWinUi.csproj");

const REQUIRED_TOP_LEVEL_CHECK_IDS = [
  "ipc.malformed-bounded",
  "companion.probe",
  "policy.production-forbidden-denied",
  "emergency-stop.denies-new-actions",
  "emergency-stop.in-flight",
  "approval.denied",
  "approval.timeout",
  "ipc.inflight-malformed-fail-closed",
  "ticket31-handoff",
];

const REQUIRED_APP_CHECK_IDS = [
  "app.launch-contained",
  "app.launch-job-order",
  "app.partial-launch-cleanup",
  "uia.capture",
  "action.value-verified",
  "password.masked",
  "action.selection-verified",
  "action.invoke-verified",
  "action.evidence-refs",
  "action.unsupported-pattern",
  "permit.missing-denied",
  "permit.replay-denied",
  "permit.mismatch-denied",
  "permit.expiry-denied",
  "uia.worker-forced-exit",
  "uia.worker-restart",
  "uia.worker-timeout",
  "action.no-auto-replay",
  "app.reset",
  "app.reset-state-verified",
  "app.shutdown-unrelated-survives",
  "app.identity-mismatch-denied",
];

describe("Windows Companion daemon native UIA E2E", () => {
  it("requires real Windows 11 WPF/WinUI prerequisites instead of reporting synthetic success", () => {
    if (process.platform !== "win32") {
      throw new Error("Windows11Unavailable: Companion daemon native UIA E2E requires Windows 11");
    }
    if (process.env.QUALIGENCE_WINDOWS_UIA_TEST !== "true") {
      throw new Error("Windows11Unavailable: set QUALIGENCE_WINDOWS_UIA_TEST=true on a local interactive Windows 11 console to run native daemon UIA E2E");
    }
    if (!existsSync(WPF_PROJECT) || !existsSync(WINUI_PROJECT)) {
      throw new Error("WindowsUiaPrerequisiteUnavailable: WPF/WinUI reference fixture projects are missing");
    }

    const harness = process.env.QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS;
    if (harness === undefined || harness.length === 0 || !existsSync(harness)) {
      throw new Error("WindowsUiaPrerequisiteUnavailable: set QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS to the native daemon WPF/WinUI driver harness");
    }

    const result = spawnSync(harness, [WPF_PROJECT, WINUI_PROJECT], {
      cwd: process.cwd(),
      env: { ...process.env, CI: "true" },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const evidenceLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS_EVIDENCE="));
    expect(evidenceLine, `harness did not emit machine-readable evidence path\n${result.stdout}`).toBeDefined();
    const evidencePath = evidenceLine!.slice("QUALIGENCE_WINDOWS_UIA_DAEMON_HARNESS_EVIDENCE=".length);
    expect(existsSync(evidencePath), `harness evidence file is missing: ${evidencePath}`).toBe(true);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      schemaVersion?: string;
      status?: string;
      uiAccess?: boolean;
      checks?: Array<{ id?: string; status?: string; evidenceRefs?: string[] }>;
      apps?: Array<{ technology?: string; checks?: Array<{ id?: string; status?: string; evidenceRefs?: string[] }> }>;
    };
    expect(evidence.schemaVersion).toBe("qualigence-windows-uia-daemon-harness/v1");
    expect(evidence.status).toBe("passed");
    expect(evidence.uiAccess).toBe(false);
    expect(evidence.apps).toHaveLength(2);
    const topLevelIds = new Set(evidence.checks?.filter((check) => check.status === "pass").map((check) => check.id));
    for (const id of REQUIRED_TOP_LEVEL_CHECK_IDS) {
      expect(topLevelIds.has(id), `missing top-level harness evidence check ${id}`).toBe(true);
    }
    for (const app of evidence.apps ?? []) {
      const passedChecks = app.checks?.filter((check) => check.status === "pass") ?? [];
      const appIds = new Set(passedChecks.map((check) => check.id));
      for (const id of REQUIRED_APP_CHECK_IDS) {
        expect(appIds.has(id), `missing ${app.technology ?? "app"} harness evidence check ${id}`).toBe(true);
      }
      const actionRefs = passedChecks.filter((check) => check.id === "action.evidence-refs").flatMap((check) => check.evidenceRefs ?? []);
      expect(actionRefs.length, `${app.technology ?? "app"} did not publish action evidence refs`).toBeGreaterThan(0);
      for (const ref of actionRefs) {
        const [filePart, hashPart] = ref.split("#sha256:");
        expect(filePart !== undefined && filePart.startsWith("file:"), `invalid action evidence ref ${ref}`).toBe(true);
        expect(hashPart?.length, `invalid action evidence hash ${ref}`).toBe(64);
        const artifactPath = filePart?.slice("file:".length) ?? "";
        expect(existsSync(artifactPath), `missing action evidence artifact ${ref}`).toBe(true);
      }
    }
  }, 20 * 60_000);
});
