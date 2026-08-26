import { existsSync } from "node:fs";
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

    const dotnet = spawnSync("dotnet", ["--info"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    expect(dotnet.status, `WindowsUiaPrerequisiteUnavailable: dotnet --info failed\n${dotnet.stdout}\n${dotnet.stderr}`).toBe(0);

    const wpf = spawnSync("dotnet", ["build", WPF_PROJECT, "-c", "Release"], {
      cwd: process.cwd(),
      env: { ...process.env, CI: "true" },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(wpf.status, `WindowsUiaPrerequisiteUnavailable: WPF reference build failed\n${wpf.stdout}\n${wpf.stderr}`).toBe(0);

    const winui = spawnSync("dotnet", ["build", WINUI_PROJECT, "-c", "Release"], {
      cwd: process.cwd(),
      env: { ...process.env, CI: "true" },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(winui.status, `WindowsUiaPrerequisiteUnavailable: WinUI reference build failed\n${winui.stdout}\n${winui.stderr}`).toBe(0);

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
  });
});
