import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { AdminCliError } from "./errors.js";

/** A PostgreSQL connection the tools operate against. */
export interface PgConnectionInfo {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

export interface PgDumpOptions {
  /** Exported snapshot id to pin the dump to a consistent point in time. */
  readonly snapshotId?: string;
  /** Absolute path the custom-format dump is written to. */
  readonly outFile: string;
}

export interface PgRestoreOptions {
  /** Absolute path of the custom-format dump to restore. */
  readonly inFile: string;
}

/**
 * The seam over the real `pg_dump` / `pg_restore` binaries. Production wires the
 * {@link SpawnPgToolRunner} which invokes the binaries shipped in the image; a
 * test can inject an equivalent runner (e.g. one that execs the binaries inside
 * a container) so the backup/restore path always drives genuine PostgreSQL
 * tooling rather than a hand-rolled dump format.
 */
export interface PgToolRunner {
  dump(conn: PgConnectionInfo, options: PgDumpOptions): Promise<void>;
  restore(conn: PgConnectionInfo, options: PgRestoreOptions): Promise<void>;
}

async function runToStdout(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  outFile: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, [...args], { env });
    const out = createWriteStream(outFile);
    let stderr = "";
    child.stdout.pipe(out);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new AdminCliError("PgToolFailed", `${bin} exited with code ${code}`, {
          details: { stderr: stderr.slice(-2000) },
        }),
      );
    });
  });
}

async function runFromStdin(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  inFile: string,
): Promise<void> {
  const handle = await open(inFile, "r");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, [...args], { env });
      const input = handle.createReadStream();
      let stderr = "";
      input.pipe(child.stdin);
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new AdminCliError("PgToolFailed", `${bin} exited with code ${code}`, {
            details: { stderr: stderr.slice(-2000) },
          }),
        );
      });
    });
  } finally {
    await handle.close();
  }
}

/**
 * The default runner: spawns the `pg_dump` / `pg_restore` binaries from `PATH`
 * (installed in the deployment image) and streams the custom-format dump to/from
 * a file. The password is passed via `PGPASSWORD` in the child environment only,
 * never on the command line.
 */
export class SpawnPgToolRunner implements PgToolRunner {
  constructor(
    private readonly binDir = "",
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  private bin(name: string): string {
    return this.binDir.length > 0 ? `${this.binDir}/${name}` : name;
  }

  private env(conn: PgConnectionInfo): NodeJS.ProcessEnv {
    return { ...this.baseEnv, PGPASSWORD: conn.password };
  }

  async dump(conn: PgConnectionInfo, options: PgDumpOptions): Promise<void> {
    const args = [
      "-h",
      conn.host,
      "-p",
      String(conn.port),
      "-U",
      conn.user,
      "-d",
      conn.database,
      "--format=custom",
      "--no-password",
    ];
    if (options.snapshotId !== undefined) {
      args.push(`--snapshot=${options.snapshotId}`);
    }
    await runToStdout(this.bin("pg_dump"), args, this.env(conn), options.outFile);
  }

  async restore(conn: PgConnectionInfo, options: PgRestoreOptions): Promise<void> {
    const args = [
      "-h",
      conn.host,
      "-p",
      String(conn.port),
      "-U",
      conn.user,
      "-d",
      conn.database,
      "--no-owner",
      "--no-privileges",
      "--no-password",
      "--exit-on-error",
    ];
    await runFromStdin(this.bin("pg_restore"), args, this.env(conn), options.inFile);
  }
}
