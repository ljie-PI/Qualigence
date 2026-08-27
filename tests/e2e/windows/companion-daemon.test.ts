import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const WPF_PROJECT = join(process.cwd(), "tests", "fixtures", "windows-reference-wpf", "WindowsReferenceWpf.csproj");
const WINUI_PROJECT = join(process.cwd(), "tests", "fixtures", "windows-reference-winui", "WindowsReferenceWinUi.csproj");

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
      apps?: unknown[];
    };
    expect(evidence.schemaVersion).toBe("qualigence-windows-uia-daemon-harness/v1");
    expect(evidence.status).toBe("passed");
    expect(evidence.uiAccess).toBe(false);
    expect(evidence.apps).toHaveLength(2);
  });
});
