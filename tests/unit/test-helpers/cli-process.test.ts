import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../helpers/cli-process.js";
import { withTempDataDir, type TempDataDir } from "../../helpers/temp-data-dir.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const exitFixture = join(fixturesDir, "exit.mjs");
const hangFixture = join(fixturesDir, "hang.mjs");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runCli", () => {
  it("captures the exact exit code and stdout of a child process", async () => {
    const result = await runCli([exitFixture, "7", "hello"], {}, 5_000);
    expect(result).toMatchObject({ exitCode: 7 });
    expect(result.stdout).toContain("hello");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects with CliProcessTimedOut and kills the process tree past the deadline", async () => {
    const started = Date.now();
    const rejection = runCli([hangFixture], {}, 250);
    await expect(rejection).rejects.toMatchObject({ code: "CliProcessTimedOut" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("leaves no child process alive after a timeout", async () => {
    let capturedPids: readonly number[] = [];
    try {
      await runCli([hangFixture], {}, 250, {
        onStdout: (chunk) => {
          const match = /started (\d+) (\d+)/.exec(chunk);
          if (match) {
            capturedPids = [Number(match[1]), Number(match[2])];
          }
        },
      });
    } catch {
      // expected timeout
    }
    // Give the OS a moment to reap the killed group without a fixed sleep race.
    await vi.waitFor(() => {
      expect(capturedPids.length).toBe(2);
      for (const pid of capturedPids) {
        expect(isAlive(pid)).toBe(false);
      }
    });
  });
});

describe("withTempDataDir", () => {
  const dirs: TempDataDir[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir && existsSync(dir.path)) {
        await rm(dir.path, { recursive: true, force: true });
      }
    }
  });

  it("creates an isolated directory and removes it on cleanup", async () => {
    const temp = await withTempDataDir("unit cleanup");
    dirs.push(temp);
    expect(existsSync(temp.path)).toBe(true);
    await temp.cleanup();
    expect(existsSync(temp.path)).toBe(false);
  });

  it("preserves the directory for diagnostics when marked", async () => {
    const temp = await withTempDataDir("unit preserve");
    dirs.push(temp);
    temp.preserve();
    await temp.cleanup();
    expect(existsSync(temp.path)).toBe(true);
  });
});
