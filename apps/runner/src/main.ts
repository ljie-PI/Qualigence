import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ExecutionJobOffer } from "@qualigence/runner-protocol";
import {
  GrpcRunnerProtocolClient,
  type RunnerSession,
} from "@qualigence/grpc-runner-protocol";
import {
  AesGcmSpoolCrypto,
  loadOrCreateSpoolKey,
  SqliteRunnerSpool,
  type RunnerSpool,
} from "@qualigence/runner-spool";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import { openActionValueProvider, type ActionValueProvider } from "./action-value-provider.js";
import { RunnerOfferRuntime, runnerCapabilities } from "./offer-runtime.js";

async function openSpool(config: RunnerConfig): Promise<SqliteRunnerSpool> {
  await mkdir(config.dataDir, { recursive: true });
  const key = await loadOrCreateSpoolKey(join(config.dataDir, "spool.key"));
  return SqliteRunnerSpool.open({
    databaseFile: join(config.dataDir, "runner-spool.db"),
    crypto: new AesGcmSpoolCrypto(key),
  });
}

/**
 * Execute one offered Job: build a Playwright web target and model-backed
 * Decision/Verifier chain bound to the Job's origin, run the leased pipeline
 * spooling Trace, drain the Spool to Core and report completion.
 */
async function runOffer(
  config: RunnerConfig,
  session: RunnerSession,
  offer: ExecutionJobOffer,
  spool: RunnerSpool,
  valueProvider?: ActionValueProvider,
): Promise<void> {
  await new RunnerOfferRuntime({
    config,
    session,
    spool,
    ...(valueProvider === undefined ? {} : { valueProvider }),
  }).run(offer);
}

async function main(): Promise<void> {
  const config = loadRunnerConfig();
  const valueProvider = await openActionValueProvider();
  const advertisedCapabilities = runnerCapabilities(valueProvider);
  const spool = await openSpool(config);
  const clientPort = new GrpcRunnerProtocolClient({
    address: config.coreAddress,
    tls: { ca: config.tls.ca, key: config.tls.key, cert: config.tls.cert },
    authority: config.authority,
  });

  const makeHello = (resumeToken?: string): Parameters<GrpcRunnerProtocolClient["connect"]>[0] => {
    const base = {
      runnerId: config.runnerId,
      runnerVersion: "0.1.0",
      supportedProtocolMajors: [1],
      capabilities: advertisedCapabilities,
    };
    return resumeToken === undefined ? base : { ...base, resumeToken };
  };

  const abort = new AbortController();
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    process.stdout.write(`${JSON.stringify({ event: "runner.stopping", signal })}\n`);
    abort.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let resumeToken: string | undefined;
  let session = await clientPort.connect(makeHello());
  resumeToken = session.welcome.resumeToken;
  process.stdout.write(
    `${JSON.stringify({ event: "runner.ready", runnerId: config.runnerId, sessionId: session.welcome.sessionId })}\n`,
  );

  while (!stopping) {
    try {
      const offer = await session.nextOffer(abort.signal);
      await runOffer(config, session, offer, spool, valueProvider);
    } catch (error) {
      if (stopping) {
        break;
      }
      // A transport failure loses no spooled Trace: reconnect with the rotating
      // resume token and continue; the Spool replays on the next drain.
      process.stderr.write(
        `${JSON.stringify({ event: "runner.reconnecting", error: String(error) })}\n`,
      );
      session = await clientPort.connect(makeHello(resumeToken));
      resumeToken = session.welcome.resumeToken;
    }
  }

  await session.close();
  await clientPort.close();
  await spool.close();
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ event: "runner.fatal", error: String(error) })}\n`);
    process.exit(1);
  });
}
