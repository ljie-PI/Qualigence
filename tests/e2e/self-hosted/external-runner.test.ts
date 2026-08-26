import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runRepositoryExternalRunnerHarness } from "./external-runner-harness.js";

const execFileAsync = promisify(execFile);

const composeFile = "deployments/self-hosted/compose/compose.yaml";
const composeEnv = {
  ...process.env,
  QUALIGENCE_OIDC_ISSUER: "https://issuer.example.com",
  QUALIGENCE_OIDC_AUDIENCE: "qualigence-self-hosted",
  QUALIGENCE_MODEL_BASE_URL: "https://models.example.com/v1",
  QUALIGENCE_MODEL_NAME: "qualigence-analyst",
  QUALIGENCE_SERVER_PG_ROLE: "qualigence_server",
} as NodeJS.ProcessEnv;

interface ComposeService {
  command?: unknown;
  ports?: unknown[];
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
}

describe("Self-hosted external Runner acceptance guard", () => {
  it("fails as DockerUnavailable when Docker is absent", async () => {
    await expect(requireDocker()).resolves.toBeUndefined();
  });

  it("keeps Runner out of the Compose process graph and exposes only the dedicated Server gRPC ingress", async () => {
    await requireDocker();
    const config = await loadComposeConfig();
    expect(config.services.runner).toBeUndefined();
    expect(config.services["external-runner"]).toBeUndefined();
    const serverPorts = (config.services.server?.ports ?? []) as Array<{ target: number }>;
    expect(serverPorts).toHaveLength(1);
    expect(serverPorts[0]?.target).toBe(50555);
    for (const [serviceName, service] of Object.entries(config.services)) {
      const command = Array.isArray(service.command) ? service.command.join(" ") : String(service.command ?? "");
      expect(command, `${serviceName} must not run an in-compose Runner command`).not.toMatch(/(^|\s)runner(\s|$)/i);
    }
  });

  it("runs a repository-owned external Runner harness before claiming full-loop acceptance evidence", async () => {
    await requireDocker();
    const command = process.env.QUALIGENCE_EXTERNAL_RUNNER_COMMAND;
    const stdout = command === undefined || command.trim().length === 0
      ? await runRepositoryExternalRunnerHarness()
      : (await execFileAsync(command, splitArgs(process.env.QUALIGENCE_EXTERNAL_RUNNER_ARGS ?? ""), {
          env: process.env,
          timeout: 900_000,
          maxBuffer: 4_194_304,
        })).stdout;
    expect(stdout).toContain("qualigence-external-runner-acceptance:pass");
  }, 1_200_000);
});

async function loadComposeConfig(): Promise<ComposeConfig> {
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", "--env-file", "deployments/self-hosted/compose/.env.example", "-f", composeFile, "config", "--format", "json"],
    { env: composeEnv, timeout: 60_000, maxBuffer: 1_048_576 },
  );
  return JSON.parse(stdout) as ComposeConfig;
}

async function requireDocker(): Promise<void> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 15_000 });
  } catch (cause) {
    throw Object.assign(new Error("DockerUnavailable: docker info failed"), {
      code: "DockerUnavailable",
      cause,
    });
  }
}

function splitArgs(raw: string): string[] {
  return raw.split(/\s+/).map((value) => value.trim()).filter((value) => value.length > 0);
}
