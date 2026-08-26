import { createPrivateKey, constants as cryptoConstants, sign as cryptoSign } from "node:crypto";
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
  type SpoolResumeTokenRecord,
} from "@qualigence/runner-spool";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import { openActionValueProvider, type ActionValueProvider } from "./action-value-provider.js";
import { NamedPipeCompanionClient, type CompanionProofSignature, type RunnerCertificateProofSigner } from "@qualigence/desktop-windows-uia";
import { RunnerOfferRuntime, runnerCapabilities } from "./offer-runtime.js";
import { replayPendingRuns } from "./replay-recovery.js";
import { safeRunnerLogLine } from "./safe-runner-log.js";

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
  signal?: AbortSignal,
  companion?: NamedPipeCompanionClient,
): Promise<void> {
  await new RunnerOfferRuntime({
    config,
    session,
    spool,
    ...(config.tenantId === undefined ? {} : { tenantId: config.tenantId }),
    ...(valueProvider === undefined ? {} : { valueProvider }),
    ...(companion === undefined ? {} : { companion, desktopReady: true }),
  }).run(offer, signal);
}

async function loadResumeToken(spool: RunnerSpool): Promise<SpoolResumeTokenRecord | undefined> {
  return spool.loadResumeToken?.();
}

async function saveResumeToken(spool: RunnerSpool, session: RunnerSession): Promise<void> {
  await spool.saveResumeToken?.({
    sessionId: session.welcome.sessionId,
    resumeToken: session.welcome.resumeToken,
  });
}

function createCompanionProofSigner(config: RunnerConfig): RunnerCertificateProofSigner {
  const key = createPrivateKey(config.tls.key);
  const signatureAlgorithm = key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "rsa-pss"
    ? "rsa-pss-sha256"
    : "ecdsa-p256-sha256";
  return {
    runnerId: config.runnerId,
    certificatePem: config.tls.cert.toString("utf8"),
    async signCompanionProof(bytes: Uint8Array): Promise<CompanionProofSignature> {
      const signature = signatureAlgorithm === "rsa-pss-sha256"
        ? cryptoSign("sha256", bytes, {
            key,
            padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
            saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
          })
        : cryptoSign("sha256", bytes, key);
      return { signatureBase64: signature.toString("base64"), signatureAlgorithm };
    },
  };
}

async function openDesktopCompanion(config: RunnerConfig): Promise<NamedPipeCompanionClient | undefined> {
  if (config.desktopCompanion === undefined || process.platform !== "win32") return undefined;
  const client = new NamedPipeCompanionClient({
    pipePath: config.desktopCompanion.pipePath,
    signer: createCompanionProofSigner(config),
    ...(config.desktopCompanion.expectedCompanionInstanceId === undefined
      ? {}
      : { expectedCompanionInstanceId: config.desktopCompanion.expectedCompanionInstanceId }),
  });
  await client.authenticate();
  await client.probe();
  return client;
}

async function main(): Promise<void> {
  const config = loadRunnerConfig();
  const valueProvider = await openActionValueProvider();
  const companion = await openDesktopCompanion(config);
  const advertisedCapabilities = runnerCapabilities(valueProvider, { desktopReady: companion !== undefined });
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

  let resumeToken: string | undefined = (await loadResumeToken(spool))?.resumeToken;
  let session = await clientPort.connect(makeHello(resumeToken));
  resumeToken = session.welcome.resumeToken;
  await saveResumeToken(spool, session);
  const recoveredRuns = await replayPendingRuns(session, spool, abort.signal);
  process.stdout.write(
    `${JSON.stringify({ event: "runner.ready", runnerId: config.runnerId, sessionId: session.welcome.sessionId, recoveredRuns: recoveredRuns.length })}\n`,
  );

  while (!stopping) {
    try {
      const offer = await session.nextOffer(abort.signal);
      await runOffer(config, session, offer, spool, valueProvider, abort.signal, companion);
    } catch (error) {
      if (stopping) {
        break;
      }
      // A transport failure loses no spooled uploads: reconnect with the
      // rotating resume token, then replay already-spooled Artifacts before
      // Trace without re-executing actions or inferring completion. Keep the
      // operational log closed over allowlisted stable codes only.
      process.stderr.write(safeRunnerLogLine("runner.reconnecting", error));
      session = await clientPort.connect(makeHello(resumeToken));
      resumeToken = session.welcome.resumeToken;
      await saveResumeToken(spool, session);
      const recoveredRuns = await replayPendingRuns(session, spool, abort.signal);
      process.stdout.write(
        `${JSON.stringify({ event: "runner.recovered", recoveredRuns: recoveredRuns.length })}\n`,
      );
    }
  }

  await session.close();
  companion?.close();
  await clientPort.close();
  await spool.close();
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(safeRunnerLogLine("runner.fatal", error));
    process.exit(1);
  });
}
