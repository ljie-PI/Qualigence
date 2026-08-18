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
import { StructuredLogger } from "@qualigence/observability";
import { canonicalPayloadHash, parseExecutionJob, parseExecutionPolicySnapshot } from "@qualigence/runner-protocol";
import type { AcceptedExecutionJob, ExecutionPolicySnapshot } from "@qualigence/runner-protocol";
import { SqliteRunStore, SqliteRuntime, SqliteTraceStore, SqliteRunnerControlStore } from "@qualigence/sqlite-runtime";
import { loadCoreDaemonConfig, type CoreDaemonConfig } from "./config.js";

export interface StartedCoreDaemon {
  readonly port: number;
  readonly server: GrpcRunnerProtocolServer;
  readonly application: CoreRunnerProtocolApplication;
  readonly traceStore: SqliteTraceStore;
  shutdown(): Promise<void>;
}

interface LegacyRecoveryRecord {
  readonly jobId: string;
  readonly runId: string;
  readonly canonicalJobSha256: string;
  readonly policy: ExecutionPolicySnapshot;
}

interface VerifiedLegacyRecoveryRecord {
  readonly jobId: string;
  readonly runId: string;
  readonly originalJson: string;
  readonly recoveredJob: AcceptedExecutionJob;
}

/**
 * Start the Core Daemon: open SQLite, compose the authoritative protocol
 * application, then bind the mutual-TLS gRPC server. Readiness is emitted only
 * after both succeed. Request intake remains out of scope for this binary.
 */
export async function startCoreDaemon(config: CoreDaemonConfig): Promise<StartedCoreDaemon> {
  const recovery = config.legacyM1LocalRecoveryCandidate === undefined
    ? undefined
    : validateLegacyRecoveryCandidate(config.legacyM1LocalRecoveryCandidate, config);
  await mkdir(config.dataDir, { recursive: true });
  const runtime = await SqliteRuntime.open({
    filename: join(config.dataDir, "qualigence.db"),
    busyTimeoutMs: 5_000,
  });
  const traceStore = new SqliteTraceStore(runtime);
  const runStore = new SqliteRunStore(runtime);
  let controlStore: SqliteRunnerControlStore;
  try {
    const rawControlStore = new SqliteRunnerControlStore(runtime);
    if (recovery !== undefined) await applyVerifiedLegacyRecovery(runtime, rawControlStore, recovery);
    controlStore = rawControlStore;
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const logger = new StructuredLogger({ service: "core-daemon" });
  const ownership = new RunOwnershipService({
    store: controlStore,
    leaseDurationMs: config.leaseDurationMs,
    integrityEvents: {
      emit: (event) => logger.warn("runner-control.integrity", { ...event }),
    },
  });
  const jobs = new ExecutionJobService(ownership, {
    store: controlStore,
    leaseDurationMs: config.leaseDurationMs,
  });
  const sessions = new RunnerSessionService({
    store: controlStore,
    welcome: {
      serverVersion: "0.1.0",
      heartbeatIntervalMs: 5_000,
      leaseDurationMs: config.leaseDurationMs,
      traceBatchMaximumEvents: 128,
      traceBatchMaximumBytes: 262_144,
      maximumInFlightBatches: 2,
      maximumPendingWriteBytes: 1_048_576,
    },
    resumeTokens: new RunnerResumeTokenService({ store: controlStore }),
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

function validateLegacyRecoveryCandidate(
  candidate: unknown,
  config: Pick<CoreDaemonConfig, "deploymentMode" | "host">,
): readonly LegacyRecoveryRecord[] {
  if (config.deploymentMode !== "local") throw new Error("Legacy recovery requires Local deployment mode.");
  if (config.host !== "127.0.0.1" && config.host !== "::1") throw new Error("Legacy recovery requires exact loopback host.");
  if (typeof candidate !== "object" || candidate === null) throw new Error("Legacy recovery manifest is malformed.");
  const manifest = candidate as { readonly format?: unknown; readonly records?: unknown };
  if (manifest.format !== "legacy-m1-local-recovery/v1" || !Array.isArray(manifest.records) || manifest.records.length === 0) {
    throw new Error("Legacy recovery manifest format is invalid.");
  }
  const identities = new Set<string>();
  return manifest.records.map((record) => validateLegacyRecoveryRecord(record, identities));
}

async function applyVerifiedLegacyRecovery(
  runtime: SqliteRuntime,
  store: SqliteRunnerControlStore,
  records: readonly LegacyRecoveryRecord[],
): Promise<void> {
  const verified: VerifiedLegacyRecoveryRecord[] = [];
  for (const record of records) {
    const raw = await store.rawRecoveryJobJson(record.runId);
    if (raw === undefined) throw new Error("Legacy recovery lease row is missing.");
    const persisted = parseLegacyRecoveryJson(raw);
    const historical = parseHistoricalProjectlessJob(persisted, record.policy);
    if (historical.jobId !== record.jobId || historical.runId !== record.runId || canonicalPayloadHash(persisted) !== record.canonicalJobSha256) {
      throw new Error("Legacy recovery lease row does not match the manifest.");
    }
    if (new URL(historical.targetUrl).origin !== record.policy.allowedOrigins[0]) {
      throw new Error("Legacy recovery target origin does not match the manifest policy.");
    }
    let recoveredJob: AcceptedExecutionJob;
    try {
      recoveredJob = parseExecutionJob({ ...historical.raw, policy: historical.policy, projectId: "local" });
    } catch {
      throw new Error("Legacy recovery lease row does not match the manifest.");
    }
    verified.push({ jobId: record.jobId, runId: record.runId, originalJson: raw, recoveredJob });
  }
  await runtime.db.transaction().execute(async (db) => {
    for (const record of verified) {
      const result = await db
        .updateTable("execution_leases")
        .set({ job_json: JSON.stringify(record.recoveredJob) })
        .where("run_id", "=", record.runId)
        .where("job_id", "=", record.jobId)
        .where("job_json", "=", record.originalJson)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) throw new Error("Legacy recovery lease row changed before migration.");
    }
  });
}

function validateLegacyRecoveryRecord(value: unknown, identities: Set<string>): LegacyRecoveryRecord {
  const record = recordValue(value, "Legacy recovery record is malformed.") as Partial<LegacyRecoveryRecord>;
  if (typeof record.jobId !== "string" || typeof record.runId !== "string" || typeof record.canonicalJobSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.canonicalJobSha256) || record.policy === undefined) {
    throw new Error("Legacy recovery record identity is malformed.");
  }
  let policy: ExecutionPolicySnapshot;
  try {
    policy = parseExecutionPolicySnapshot(record.policy);
  } catch {
    throw new Error("Legacy recovery policy is not constrained.");
  }
  if (policy.policyId !== "legacy-m1-local" || policy.environment !== "isolated_test" || policy.allowedActionKinds.length !== 1 || policy.allowedActionKinds[0] !== "click" || policy.maximumRisk !== "Normal" || policy.explorationAllowed || policy.allowedOrigins.length !== 1) {
    throw new Error("Legacy recovery policy is not constrained.");
  }
  const origin = new URL(policy.allowedOrigins[0]!);
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== policy.allowedOrigins[0]) throw new Error("Legacy recovery origin is invalid.");
  const identity = `${record.jobId}:${record.runId}:${record.canonicalJobSha256}`;
  if (identities.has(identity)) throw new Error("Legacy recovery record is duplicated.");
  identities.add(identity);
  return { jobId: record.jobId, runId: record.runId, canonicalJobSha256: record.canonicalJobSha256, policy };
}

function parseLegacyRecoveryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Legacy recovery lease row does not match the manifest.");
  }
}

function parseHistoricalProjectlessJob(
  value: unknown,
  manifestPolicy: ExecutionPolicySnapshot,
): { readonly raw: Readonly<Record<string, unknown>>; readonly jobId: string; readonly runId: string; readonly targetUrl: string; readonly policy: unknown } {
  const raw = recordValue(value, "Legacy recovery lease row does not match the manifest.");
  if (raw.projectId !== undefined) throw new Error("Legacy recovery lease row does not match the manifest.");
  const target = recordValue(raw.target, "Legacy recovery lease row does not match the manifest.");
  if (target.kind !== "web") throw new Error("Legacy recovery lease row does not match the manifest.");
  const policy = raw.policy === undefined ? manifestPolicy : raw.policy;
  if (raw.policy !== undefined && canonicalPayloadHash(raw.policy) !== canonicalPayloadHash(manifestPolicy)) throw new Error("Legacy recovery lease row does not match the manifest.");
  return {
    raw,
    jobId: nonEmptyString(raw.jobId),
    runId: nonEmptyString(raw.runId),
    targetUrl: nonEmptyString(target.url),
    policy,
  };
}

function recordValue(value: unknown, message: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Readonly<Record<string, unknown>>;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Legacy recovery lease row does not match the manifest.");
  return value;
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
