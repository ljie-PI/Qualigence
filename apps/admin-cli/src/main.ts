#!/usr/bin/env node
import { Command } from "commander";
import { StructuredLogger } from "@qualigence/observability";
import { loadAdminConfig } from "./config.js";
import { AdminCliError } from "./errors.js";
import { SpawnPgToolRunner } from "./pg-tools.js";
import { runMigrate } from "./commands/migrate.js";
import { runDoctor } from "./commands/doctor.js";
import { runBackup } from "./commands/backup.js";
import { runRestore } from "./commands/restore.js";

const VERSION = "0.1.0";

/** Injectable IO so the command layer stays testable and side-effect explicit. */
export interface AdminIo {
  out(line: string): void;
  err(line: string): void;
  exit(code: number): void;
}

const defaultIo: AdminIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  exit: (code) => {
    process.exitCode = code;
  },
};

function describeError(error: unknown): string {
  if (error instanceof AdminCliError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function run(
  argv: readonly string[],
  io: AdminIo = defaultIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const program = new Command();
  program
    .name("qualigence-admin")
    .description("Self-hosted operator CLI: migrate, doctor, backup and restore")
    .version(VERSION)
    .exitOverride();

  const logger = new StructuredLogger({ service: "admin-cli" });

  const guard = (handler: () => Promise<void>): (() => Promise<void>) => {
    return async () => {
      try {
        await handler();
      } catch (error) {
        io.err(describeError(error));
        io.exit(1);
      }
    };
  };

  program
    .command("migrate")
    .description("provision or verify the PostgreSQL schema, roles and RLS")
    .action(
      guard(async () => {
        const config = loadAdminConfig(env);
        const result = await runMigrate(config);
        io.out(`migrate: ${result.action} (schema version ${result.schemaVersion})`);
      }),
    );

  program
    .command("doctor")
    .description("comprehensive health check of DB/RLS, S3, KMS, Server and Worker")
    .option("--json", "emit the report as JSON")
    .action((options: { json?: boolean }) =>
      guard(async () => {
        const config = loadAdminConfig(env);
        const report = await runDoctor(config);
        if (options.json === true) {
          io.out(JSON.stringify(report, null, 2));
        } else {
          for (const check of report.checks) {
            io.out(`[${check.status}] ${check.name}: ${check.safeMessage}`);
          }
          io.out(`overall: ${report.status}`);
        }
        if (report.status === "unhealthy") {
          io.exit(2);
        }
      })(),
    );

  program
    .command("backup")
    .description("create a consistent, byte-complete point-in-time backup")
    .action(
      guard(async () => {
        const config = loadAdminConfig(env);
        const result = await runBackup(config, { pgTool: new SpawnPgToolRunner(), logger });
        io.out(`backup: ${result.directory}`);
        io.out(`  objects: ${result.index.objectCount}`);
        io.out(`  bytes:   ${result.index.totalObjectBytes}`);
        io.out(`  schema:  ${result.index.database.schemaVersion}`);
      }),
    );

  program
    .command("restore")
    .description("restore a backup into a clean environment, verified byte-for-byte")
    .action(
      guard(async () => {
        const config = loadAdminConfig(env);
        const result = await runRestore(config, { pgTool: new SpawnPgToolRunner(), logger });
        io.out(`restore: ${result.restoredObjects} objects, schema ${result.schemaVersion}`);
      }),
    );

  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    const code = (error as { exitCode?: number }).exitCode ?? 1;
    if (code !== 0) {
      io.exit(code);
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  void run(process.argv.slice(2));
}
