import {
  CertificateRunnerIdentity,
  GrpcRunnerProtocolServer,
} from "@qualigence/grpc-runner-protocol";
import { loadCoreDaemonConfig, type CoreDaemonConfig } from "./config.js";

export interface StartedCoreDaemon {
  readonly port: number;
  readonly server: GrpcRunnerProtocolServer;
  shutdown(): Promise<void>;
}

/**
 * Start the Core Daemon: bind the mutual-TLS {@link GrpcRunnerProtocolServer} so
 * Runners can connect and be issued single-owner Leases and rotating resume
 * credentials. The authoritative session/ownership state machine lives in the
 * exported services (`RunnerSessionService`, `RunOwnershipService`, …); request
 * intake (the LS-06 Launcher) is intentionally out of scope for this binary.
 */
export async function startCoreDaemon(config: CoreDaemonConfig): Promise<StartedCoreDaemon> {
  const server = new GrpcRunnerProtocolServer({
    tls: { ca: config.tls.ca, cert: config.tls.cert, key: config.tls.key },
    identity: new CertificateRunnerIdentity(),
    host: config.host,
    port: config.port,
    welcome: {
      serverVersion: "0.1.0",
      heartbeatIntervalMs: 5_000,
      leaseDurationMs: config.leaseDurationMs,
      traceBatchMaximumEvents: 128,
      traceBatchMaximumBytes: 262_144,
      maximumInFlightBatches: 2,
      maximumPendingWriteBytes: 1_048_576,
    },
  });

  const port = await server.listen();

  return {
    port,
    server,
    shutdown: async (): Promise<void> => {
      await server.shutdown();
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
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ event: "core-daemon.fatal", error: String(error) })}\n`);
    process.exit(1);
  });
}
