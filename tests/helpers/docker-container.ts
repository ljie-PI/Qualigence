import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Minimal Docker-backed container harness for the storage provider contract
 * tests. It shells out to the local `docker` CLI (the repo already relies on
 * external CLIs such as `openssl` for the mTLS PKI tests) to run a real
 * PostgreSQL or MinIO instance, so the RLS and S3 contracts are exercised
 * against genuine servers rather than hand-rolled fakes.
 *
 * When Docker is unavailable the suites that depend on it skip cleanly via
 * {@link dockerAvailable} instead of failing, keeping the gate green on hosts
 * without a Docker daemon while still providing real coverage where it exists.
 */

let dockerAvailableCache: boolean | undefined;

export function dockerAvailable(): boolean {
  if (dockerAvailableCache !== undefined) {
    return dockerAvailableCache;
  }
  try {
    execFileSync("docker", ["info"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
    });
    dockerAvailableCache = true;
  } catch {
    dockerAvailableCache = false;
  }
  return dockerAvailableCache;
}

export interface StartedContainer {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", [...args], {
    timeout: 120_000,
  });
  return stdout.trim();
}

async function mappedPort(id: string, containerPort: number): Promise<number> {
  const output = await docker(["port", id, `${containerPort}/tcp`]);
  const firstLine = output.split("\n")[0] ?? "";
  const match = firstLine.match(/:(\d+)\s*$/);
  if (match === null) {
    throw new Error(`Unable to resolve mapped port from: ${output}`);
  }
  return Number.parseInt(match[1] as string, 10);
}

async function stopContainer(id: string): Promise<void> {
  try {
    await docker(["rm", "-f", id]);
  } catch {
    // Best effort — the container may already be gone.
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  { attempts, delayMs }: { attempts: number; delayMs: number },
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `Container readiness check timed out after ${attempts} attempts: ${String(lastError)}`,
  );
}

export interface StartedPostgres extends StartedContainer {
  readonly superuser: string;
  readonly password: string;
  readonly database: string;
}

export async function startPostgres(): Promise<StartedPostgres> {
  const superuser = "postgres";
  const password = "postgres";
  const database = "qualigence_test";
  const id = await docker([
    "run",
    "-d",
    "--rm",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    `POSTGRES_USER=${superuser}`,
    "-e",
    `POSTGRES_DB=${database}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine",
    "-c",
    "fsync=off",
    "-c",
    "full_page_writes=off",
  ]);
  try {
    const port = await mappedPort(id, 5432);
    const host = "127.0.0.1";
    // Readiness: the postgres image restarts once during first-time init, so we
    // probe with a real login connection rather than trusting `pg_isready`.
    const { Client } = await import("pg");
    await waitFor(
      async () => {
        const client = new Client({
          host,
          port,
          user: superuser,
          password,
          database,
          connectionTimeoutMillis: 2_000,
        });
        try {
          await client.connect();
          await client.query("select 1");
          return true;
        } finally {
          await client.end().catch(() => undefined);
        }
      },
      { attempts: 40, delayMs: 500 },
    );
    return {
      id,
      host,
      port,
      superuser,
      password,
      database,
      stop: () => stopContainer(id),
    };
  } catch (error) {
    await stopContainer(id);
    throw error;
  }
}

export interface StartedMinio extends StartedContainer {
  readonly accessKey: string;
  readonly secretKey: string;
  readonly endpoint: string;
}

export async function startMinio(): Promise<StartedMinio> {
  const accessKey = "minioadmin";
  const secretKey = "minioadmin";
  const id = await docker([
    "run",
    "-d",
    "--rm",
    "-e",
    `MINIO_ROOT_USER=${accessKey}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${secretKey}`,
    "-p",
    "127.0.0.1::9000",
    "minio/minio:latest",
    "server",
    "/data",
  ]);
  try {
    const port = await mappedPort(id, 9000);
    const host = "127.0.0.1";
    const endpoint = `http://${host}:${port}`;
    await waitFor(
      async () => {
        const response = await fetch(`${endpoint}/minio/health/ready`);
        return response.ok;
      },
      { attempts: 40, delayMs: 500 },
    );
    return {
      id,
      host,
      port,
      accessKey,
      secretKey,
      endpoint,
      stop: () => stopContainer(id),
    };
  } catch (error) {
    await stopContainer(id);
    throw error;
  }
}
