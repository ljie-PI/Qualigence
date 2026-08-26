import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Windows native Named Pipe authority", () => {
  it("runs the Rust native identity, ACL, replay, and framing suite on Windows 11", () => {
    if (process.platform !== "win32") {
      throw new Error("Windows11Unavailable: native Named Pipe authority E2E requires Windows 11");
    }

    const result = spawnSync("cargo", ["test", "--workspace", "--test", "companion_windows_named_pipe"], {
      cwd: process.cwd(),
      env: { ...process.env, CI: "true" },
      encoding: "utf8",
      windowsHide: true,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("companion_windows_named_pipe");
  });
});
