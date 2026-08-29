import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Hosted Windows/Rust first execution compiles `companion_windows_named_pipe`
// before any assertion. 15 minutes covers a cold cargo compile plus the native
// suite without skipping, weakening assertions, or leaving the bound unbounded.
const NAMED_PIPE_CARGO_TIMEOUT_MS = 900_000;

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
      timeout: NAMED_PIPE_CARGO_TIMEOUT_MS,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("companion_windows_named_pipe");
  }, NAMED_PIPE_CARGO_TIMEOUT_MS + 30_000);
});
