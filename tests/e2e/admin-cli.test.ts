import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli-process.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const adminCliEntry = join(repoRoot, "apps", "admin-cli", "dist", "main.js");

beforeAll(() => {
  expect(existsSync(adminCliEntry)).toBe(true);
});

describe("admin CLI end-to-end", () => {
  it("renders help and rejects an unknown command as a real binary", async () => {
    const help = await runCli([adminCliEntry, "--help"], process.env, 20_000);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("migrate");
    expect(help.stdout).toContain("doctor");
    expect(help.stdout).toContain("backup");
    expect(help.stdout).toContain("restore");

    const unknown = await runCli([adminCliEntry, "definitely-unknown"], process.env, 20_000);
    expect(unknown.exitCode).not.toBe(0);
  });
});
