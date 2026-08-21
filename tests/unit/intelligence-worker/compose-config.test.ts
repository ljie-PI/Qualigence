import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const composeDir = join(process.cwd(), "deployments", "self-hosted", "compose");

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string> }
  >;
}

describe("Intelligence Worker Compose configuration", () => {
  it("uses the configured Server PostgreSQL role for migration, Server, and Worker guards", async () => {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "compose",
        "--profile",
        "setup",
        "--env-file",
        ".env.example",
        "-f",
        "compose.yaml",
        "config",
        "--format",
        "json",
      ],
      { cwd: composeDir },
    );
    const config = JSON.parse(stdout) as ComposeConfig;
    const migrationRole = config.services.migrate?.environment?.ADMIN_SERVER_PG_USER;

    expect(migrationRole).toBe("qualigence_server");
    expect(config.services.server?.environment?.SERVER_PG_USER).toBe(migrationRole);
    expect(config.services.worker?.environment?.WORKER_PG_SERVER_ROLE).toBe(migrationRole);
  });
});
