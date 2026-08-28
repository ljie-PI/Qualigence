import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli-process.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
// This is a hang guard, not a startup-performance assertion. A cold Windows
// worktree can spend several seconds loading the larger binary dependency
// graphs while the focused Gate runs its other files in parallel.
const DEADLINE_MS = 30_000;
// Vitest must outlive runCli's deadline so the child is terminated and awaited
// before Vitest aborts the test.
const ENTRYPOINT_SUITE_TIMEOUT_MS = DEADLINE_MS + 5_000;

function entrypoint(path: string): string {
  return join(repoRoot, path);
}

function without(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const name of names) {
    delete childEnv[name];
  }
  return childEnv;
}

describe("Node binary entrypoints", { timeout: ENTRYPOINT_SUITE_TIMEOUT_MS }, () => {
  it.each([
    { file: "apps/admin-cli/dist/main.js", args: ["--help"], expected: /migrate/ },
    { file: "apps/local-launcher/dist/main.js", args: ["--help"], expected: /init|start/ },
  ])("runs $file directly", async ({ file, args, expected }) => {
    const result = await runCli([entrypoint(file), ...args], process.env, DEADLINE_MS);

    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(expected);
  });

  it.each([
    {
      file: "apps/core-daemon/dist/main.js",
      absent: ["CORE_TLS_CA", "CORE_TLS_CERT", "CORE_TLS_KEY"],
      expected: /CORE_DEPLOYMENT_MODE must be exactly local or self_hosted\./,
    },
    {
      file: "apps/runner/dist/main.js",
      absent: [
        "RUNNER_ID",
        "RUNNER_TLS_CA",
        "RUNNER_TLS_CERT",
        "RUNNER_TLS_KEY",
        "RUNNER_MODEL_BASE_URL",
        "RUNNER_MODEL_API_KEY",
        "RUNNER_MODEL_NAME",
      ],
      expected: /"code":"UnexpectedRunnerError"/,
    },
    {
      file: "apps/server/dist/main.js",
      absent: [
        "SERVER_PG_HOST",
        "SERVER_PG_DATABASE",
        "SERVER_PG_USER",
        "SERVER_PG_PASSWORD",
        "SERVER_PG_PASSWORD_FILE",
        "SERVER_OIDC_ISSUER",
        "SERVER_OIDC_AUDIENCE",
        "SERVER_OIDC_JWKS_FILE",
        "SERVER_OIDC_CLAIM_MAP_FILE",
        "SERVER_RUNNER_CA_CERT_FILE",
        "SERVER_RUNNER_CA_KEY_FILE",
      ],
      expected: /Missing required environment variable SERVER_OIDC_CLAIM_MAP_FILE/,
    },
    {
      file: "apps/intelligence-worker/dist/main.js",
      absent: [
        "WORKER_PG_HOST",
        "WORKER_PG_DATABASE",
        "WORKER_PG_USER",
        "WORKER_PG_PASSWORD",
        "WORKER_PG_PASSWORD_FILE",
        "WORKER_S3_BUCKET",
        "WORKER_S3_ACCESS_KEY_ID",
        "WORKER_S3_ACCESS_KEY_ID_FILE",
        "WORKER_S3_SECRET_ACCESS_KEY",
        "WORKER_S3_SECRET_ACCESS_KEY_FILE",
        "WORKER_MODEL_BASE_URL",
        "WORKER_MODEL_API_KEY",
        "WORKER_MODEL_API_KEY_FILE",
        "WORKER_MODEL_NAME",
      ],
      expected: /Missing required environment variable WORKER_PG_HOST/,
    },
  ])("runs $file directly and rejects missing configuration", async ({ file, absent, expected }) => {
    const result = await runCli([entrypoint(file)], without(process.env, absent), DEADLINE_MS);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(expected);
  });

  it("runs benchmark runner directly and reports invalid usage", async () => {
    const result = await runCli(
      [entrypoint("apps/benchmark-runner/dist/main.js"), "invalid-profile"],
      process.env,
      DEADLINE_MS,
    );

    expect(result.exitCode).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/Usage: qualigence-benchmark/);
  });
});
