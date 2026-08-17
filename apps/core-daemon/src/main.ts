import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CertificateRunnerIdentity,
  GrpcRunnerProtocolServer,
} from "@qualigence/grpc-runner-protocol";
import {
  CoreRunnerProtocolApplication,
  ExecutionJobService,
  RunnerResumeTokenService,
  RunnerSessionService,
  RunOwnershipService,
} from "@qualigence/core-application";
import { TraceIngestor } from "@qualigence/evidence";
import { SqliteRunStore, SqliteRuntime, SqliteTraceStore } from "@qualigence/sqlite-runtime";
import { loadCoreDaemonConfig, type CoreDaemonConfig } from "./config.js";

export interface StartedCoreDaemon {
  readonly port: number;
  readonly server: GrpcRunnerProtocolServer;
  readonly application: CoreRunnerProtocolApplication;
  readonly traceStore: SqliteTraceStore;
  shutdown(): Promise<void>;
}

/**
 * Start the Core Daemon: open SQLite, compose the authoritative protocol
 * application, then bind the mutual-TLS gRPC server. Readiness is emitted only
 * after both succeed. Request intake remains out of scope for this binary.
 */
export async function startCoreDaemon(config: CoreDaemonConfig): Promise<StartedCoreDaemon> {
  await mkdir(config.dataDir, { recursive: true });
  const runtime = await SqliteRuntime.open({
    filename: join(config.dataDir, "qualigence.db"),
    busyTimeoutMs: 5_000,
  });
  const traceStore = new SqliteTraceStore(runtime);
  const runStore = new SqliteRunStore(runtime);
  const ownership = new RunOwnershipService({ leaseDurationMs: config.leaseDurationMs });
  const jobs = new ExecutionJobService(ownership, { leaseDurationMs: config.leaseDurationMs });
  const sessions = new RunnerSessionService({
    welcome: {
      serverVersion: "0.1.0",
      heartbeatIntervalMs: 5_000,
      leaseDurationMs: config.leaseDurationMs,
      traceBatchMaximumEvents: 128,
      traceBatchMaximumBytes: 262_144,
      maximumInFlightBatches: 2,
      maximumPendingWriteBytes: 1_048_576,
    },
    resumeTokens: new RunnerResumeTokenService(),
    traceIngestor: new TraceIngestor(traceStore),
    ownership,
  });
  const application = new CoreRunnerProtocolApplication({
    sessions,
    jobs,
    ownership,
    recordRun: async (job) => {
      if ((await runStore.get(job.runId)) !== undefined) return;
      await runStore.create({
        runId: job.runId,
        jobId: job.jobId,
        targetKind: job.target.kind,
        objective: job.objective,
        status: "running",
        nextSequenceNumber: 1,
        createdAt: new Date().toISOString(),
      });
    },
  });
  const server = new GrpcRunnerProtocolServer({
    tls: { ca: config.tls.ca, cert: config.tls.cert, key: config.tls.key },
    authenticator: new CertificateRunnerIdentity(),
    application,
    host: config.host,
    port: config.port,
  });

  let port: number;
  try {
    port = await server.listen();
  } catch (error) {
    await runtime.close();
    throw error;
  }

  return {
    port,
    server,
    application,
    traceStore,
    shutdown: async (): Promise<void> => {
      await server.shutdown();
      await runtime.close();
    },
  };
}

async function main(): Promise<void> {
  const config = loadCoreDaemonConfig();
  const daemon = await startCoreDaemon(config);
  process.stdout.write(
    `${JSON.stringify({ event: "core-daemon.ready", port: daemon.port, host: config.host })}\n`,
  );

  let shuttingDown = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write(`${JSON.stringify({ event: "core-daemon.stopping", signal })}\n`);
    daemon
      .shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(`${JSON.stringify({ event: "core-daemon.shutdown_error", error: String(error) })}\n`);
        process.exit(1);
      });
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ event: "core-daemon.fatal", error: String(error) })}\n`);
    process.exit(1);
  });
}
