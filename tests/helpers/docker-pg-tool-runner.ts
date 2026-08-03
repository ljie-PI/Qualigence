import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import type {
  PgConnectionInfo,
  PgDumpOptions,
  PgRestoreOptions,
  PgToolRunner,
} from "@qualigence/admin-cli";

/**
 * A {@link PgToolRunner} that execs the real `pg_dump` / `pg_restore` binaries
 * *inside* the running PostgreSQL container. The sandbox host has no PostgreSQL
 * client binaries, but the container image ships them — and the deployment's
 * Node image installs `postgresql-client` exactly so the admin CLI can shell out
 * to them. Running the tools in-container connecting to `127.0.0.1:5432` targets
 * the same server the backup's exported snapshot lives on, so
 * `pg_dump --snapshot=<id>` sees a consistent point-in-time view.
 *
 * The custom-format dump is streamed over the exec stdout to the host `outFile`
 * (and back over stdin for restore); no `docker cp` round-trip is needed.
 */
export function dockerExecPgToolRunner(containerId: string): PgToolRunner {
  return {
    async dump(conn: PgConnectionInfo, options: PgDumpOptions): Promise<void> {
      const args = [
        "exec",
        "-e",
        `PGPASSWORD=${conn.password}`,
        containerId,
        "pg_dump",
        "-h",
        "127.0.0.1",
        "-p",
        "5432",
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
      await runToFile("docker", args, options.outFile);
    },

    async restore(conn: PgConnectionInfo, options: PgRestoreOptions): Promise<void> {
      const args = [
        "exec",
        "-i",
        "-e",
        `PGPASSWORD=${conn.password}`,
        containerId,
        "pg_restore",
        "-h",
        "127.0.0.1",
        "-p",
        "5432",
        "-U",
        conn.user,
        "-d",
        conn.database,
        "--no-owner",
        "--no-privileges",
        "--no-password",
        "--exit-on-error",
      ];
      await runFromFile("docker", args, options.inFile);
    },
  };
}

async function runToFile(bin: string, args: readonly string[], outFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, [...args]);
    const out = createWriteStream(outFile);
    let stderr = "";
    child.stdout.pipe(out);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    out.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${bin} ${args[3] ?? ""} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function runFromFile(bin: string, args: readonly string[], inFile: string): Promise<void> {
  const handle = await open(inFile, "r");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, [...args]);
      const input = createReadStream("", { fd: handle.fd, autoClose: false });
      let stderr = "";
      input.pipe(child.stdin);
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      input.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${bin} pg_restore exited with code ${code}: ${stderr.slice(-2000)}`));
      });
    });
  } finally {
    await handle.close();
  }
}
