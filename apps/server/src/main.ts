import {
  ClaimMapper,
  OidcAuthenticator,
  RbacAuthorizer,
  StaticJwksResolver,
  signingKeyFromPem,
  type OidcAlgorithm,
  type OidcSigningKey,
} from "@qualigence/oidc";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalArtifactStore } from "@qualigence/artifact-fs";
import { createS3ArtifactClient, S3ArtifactStore } from "@qualigence/artifact-s3";
import { SelfHostedKms } from "@qualigence/kms-self-hosted";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { ServerIntelligenceResultConsumer } from "@qualigence/core-application";
import { GrpcRunnerProtocolServer } from "@qualigence/grpc-runner-protocol";
import {
  acquirePostgresOperationLock,
  assertPostgresSchemaCurrent,
  createPostgresRuntime,
  OperationScopedPostgresRunnerControlStore,
  PostgresEvidenceLifecycleStore,
  PostgresIntelligenceResultWakeupStore,
  PostgresSelfHostedKmsKeyStore,
  PostgresReviewTaskRepository,
} from "@qualigence/postgres-runtime";
import { LocalSkillSigner } from "@qualigence/kms-local";
import { PemCaRunnerCertificateIssuer } from "@qualigence/runner-mtls";
import type { Clock } from "@qualigence/shared-kernel";
import { loadServerConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { buildServer } from "./server.js";
import { IntelligenceResultConsumerLoop } from "./intelligence-result-consumer-loop.js";
import { MissionDispatchLoop } from "./mission-dispatch-loop.js";
import { OperationScopedMissionDispatchRepository } from "./operation-scoped-mission-dispatch-repository.js";
import {
  PostgresRunnerEnrollmentStore,
  PostgresRunnerPrincipalStore,
} from "./runner-stores.js";
import {
  selfHostedRunnerApplicationResolver,
  selfHostedRunnerPeerAuthenticator,
} from "./self-hosted-runner-protocol.js";
import type { ServerDeps, ServerReadinessCheck, ServerReadinessReport, TenantStores } from "./server-context.js";

interface JwksEntry {
  readonly kid: string;
  readonly alg: OidcAlgorithm;
  readonly publicKeyPem: string;
}

const systemClock: Clock = { now: () => new Date().toISOString() };

type ArtifactStoreFactory = (scope: {
  readonly tenantId: string;
  readonly projectId?: string;
}) => LocalArtifactStore | S3ArtifactStore;

function artifactStoreFactory(config: ServerConfig, clock: Clock): ArtifactStoreFactory {
  if (config.artifactS3 !== undefined) {
    const client = createS3ArtifactClient(config.artifactS3);
    return ({ tenantId, projectId }) => new S3ArtifactStore({
      client,
      bucket: config.artifactS3!.bucket,
      tenantId,
      projectId: projectId ?? "unscoped",
      clock,
    });
  }
  return ({ tenantId, projectId }) => new LocalArtifactStore(
    projectId === undefined
      ? join(config.artifactDataDir, tenantId)
      : join(config.artifactDataDir, tenantId, projectId),
    clock,
  );
}

/** Boot the Public API Server: wire OIDC/RBAC, PostgreSQL runtime, and the Runner CA. */
export async function main(
  env: NodeJS.ProcessEnv = process.env,
  assertSchema = assertPostgresSchemaCurrent,
  loadConfig: (env: NodeJS.ProcessEnv) => ServerConfig = loadServerConfig,
): Promise<void> {
  const config = loadConfig(env);
  await assertSchema(config.postgres, config.postgres.user);

  const jwksEntries = JSON.parse(config.oidc.jwksJson) as readonly JwksEntry[];
  const keys: OidcSigningKey[] = jwksEntries.map((entry) =>
    signingKeyFromPem(entry.kid, entry.alg, entry.publicKeyPem),
  );

  const oidc = new OidcAuthenticator({
    issuer: config.oidc.issuer,
    audience: config.oidc.audience,
    allowedAlgorithms: config.oidc.allowedAlgorithms,
    jwks: new StaticJwksResolver(keys),
    clock: systemClock,
    claimMapper: new ClaimMapper(config.oidc.claimMapper),
  });

  const provider = createPostgresRuntime(config.postgres);
  const resultWakeups = new PostgresIntelligenceResultWakeupStore(
    config.postgres,
    acquirePostgresOperationLock,
  );
  const artifactStore = artifactStoreFactory(config, systemClock);
  const evidenceKms = config.evidenceKms === undefined
    ? undefined
    : new SelfHostedKms({
        rootKey: config.evidenceKms.rootKey,
        keyStore: new PostgresSelfHostedKmsKeyStore(provider),
        now: systemClock.now,
      });
  const shutdown = new AbortController();
  const resultConsumer = new ServerIntelligenceResultConsumer(provider);
  const resultConsumerLoop = new IntelligenceResultConsumerLoop({
    consumerId: config.intelligenceResultConsumer.consumerId,
    wakeups: resultWakeups,
    consumer: resultConsumer,
    tenantBatchSize: config.intelligenceResultConsumer.tenantBatchSize,
    resultBatchSize: config.intelligenceResultConsumer.resultBatchSize,
    leaseDurationMs: config.intelligenceResultConsumer.leaseDurationMs,
    idleBackoffMs: config.intelligenceResultConsumer.idleBackoffMs,
    errorBackoffMs: config.intelligenceResultConsumer.errorBackoffMs,
    maximumBackoffMs: config.intelligenceResultConsumer.maximumBackoffMs,
    signal: shutdown.signal,
    onError: (error) => {
      console.error("[server] intelligence result consumer failed", error);
    },
  });
  const issuer = new PemCaRunnerCertificateIssuer({
    caCertificatePem: config.runnerCa.certificatePem,
    caPrivateKeyPem: config.runnerCa.privateKeyPem,
  });

  let runnerGrpcReady = false;
  const runnerServer = config.runnerGrpc?.enabled === true
    ? new GrpcRunnerProtocolServer({
        tls: {
          ca: Buffer.from(config.runnerCa.certificatePem),
          cert: config.runnerGrpc.tlsCertificatePem,
          key: config.runnerGrpc.tlsPrivateKeyPem,
        },
        authenticator: selfHostedRunnerPeerAuthenticator({
          provider,
          caCertificatePem: config.runnerCa.certificatePem,
          clock: systemClock,
          principalStore: (stores: TenantStores) => new PostgresRunnerPrincipalStore(stores.aux),
        }),
        applicationResolver: selfHostedRunnerApplicationResolver({
          provider,
          artifactDataDir: config.artifactDataDir,
          artifactStore: (scope) => artifactStore(scope),
          clock: systemClock,
          leaseDurationMs: 30_000,
          welcome: {
            serverVersion: "0.1.0",
            heartbeatIntervalMs: 5_000,
            leaseDurationMs: 30_000,
            traceBatchMaximumEvents: 128,
            traceBatchMaximumBytes: 262_144,
            maximumInFlightBatches: 2,
            maximumPendingWriteBytes: 1_048_576,
          },
          integrityEvents: {
            emit: (event) => console.error("[server] runner-control integrity", event),
          },
        }),
        host: config.runnerGrpc.host,
        port: config.runnerGrpc.port,
      })
    : undefined;

  const dispatchConfig = config.missionDispatch;
  const missionDispatchLoops = dispatchConfig?.enabled === true && runnerServer !== undefined
    ? dispatchConfig.tenantIds.map((tenantId) => new MissionDispatchLoop({
        tenantId,
        repository: new OperationScopedMissionDispatchRepository(provider, tenantId),
        runners: { connectionFor: (input) => runnerServer.connectionFor(input) },
        leases: new OperationScopedPostgresRunnerControlStore(provider, tenantId, { projectSelfHostedCompletion: true }),
        clock: systemClock,
        signal: shutdown.signal,
        batchSize: dispatchConfig.batchSize,
        intervalMs: dispatchConfig.intervalMs,
        initialBackoffMs: dispatchConfig.initialBackoffMs,
        maximumBackoffMs: dispatchConfig.maximumBackoffMs,
        onError: (error) => console.error("[server] mission dispatch loop failed", error),
      }))
    : [];

  const deps: ServerDeps = {
    provider,
    oidc,
    rbac: new RbacAuthorizer(),
    issuer,
    caCertificatePem: config.runnerCa.certificatePem,
    clock: systemClock,
    skillSigner: LocalSkillSigner.open(config.skillSigningDataDir ?? ".qualigence-server/skill-signing"),
    artifactStore: (scope) => artifactStore(scope),
    evidenceLifecycleStore: (stores, tenantId) => new PostgresEvidenceLifecycleStore(stores.db, tenantId),
    ...(evidenceKms === undefined ? {} : { evidenceKeyPolicy: evidenceKms }),
    enrollmentStore: (stores: TenantStores) => new PostgresRunnerEnrollmentStore(stores.aux),
    principalStore: (stores: TenantStores) => new PostgresRunnerPrincipalStore(stores.aux),
    reviewRepository: (stores: TenantStores) => new PostgresReviewTaskRepository(stores.db),
    readiness: () => readinessReport({
      config,
      provider,
      runnerGrpcReady,
      missionDispatchLoops,
      resultConsumerLoop,
    }),
  };

  const app = buildServer(deps);

  let shutdownStarted = false;
  const shutdownServer = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shutdown.abort();
    const cleanup = async (operation: Promise<unknown> | undefined): Promise<void> => {
      try {
        await operation;
      } catch (error) {
        console.error("[server] shutdown cleanup failed", error);
      }
    };
    for (const loop of missionDispatchLoops) {
      await cleanup(loop.stop());
    }
    await cleanup(resultConsumerLoop.stop());
    await cleanup(resultWakeups.close());
    await cleanup(app.close());
    await cleanup(runnerServer?.shutdown());
    await cleanup(provider.close());
    process.removeListener("SIGINT", shutdownOnSignal);
    process.removeListener("SIGTERM", shutdownOnSignal);
  };
  const shutdownOnSignal = (): void => {
    void shutdownServer().catch((error) => console.error("[server] shutdown failed", error));
  };
  process.once("SIGINT", shutdownOnSignal);
  process.once("SIGTERM", shutdownOnSignal);

  try {
    await app.listen({ host: config.host, port: config.port });
    if (runnerServer !== undefined) {
      await runnerServer.listen();
      runnerGrpcReady = true;
    }
    if (config.intelligenceResultConsumer.enabled) {
      resultConsumerLoop.start();
    }
    for (const loop of missionDispatchLoops) {
      loop.start();
    }
    console.error(`[server] listening on ${config.host}:${config.port}`);
    if (runnerServer !== undefined) {
      console.error(`[server] runner gRPC listening on ${config.runnerGrpc?.host}:${config.runnerGrpc?.port}`);
    }
  } catch (error) {
    await shutdownServer();
    throw error;
  }
}

interface ReadinessInput {
  readonly config: ServerConfig;
  readonly provider: ReturnType<typeof createPostgresRuntime>;
  readonly runnerGrpcReady: boolean;
  readonly missionDispatchLoops: readonly MissionDispatchLoop[];
  readonly resultConsumerLoop: IntelligenceResultConsumerLoop;
}

async function readinessReport(input: ReadinessInput): Promise<ServerReadinessReport> {
  const checks: ServerReadinessCheck[] = [];
  checks.push(await postgresCheck(input));
  checks.push(await objectStorageCheck(input.config.objectStorageReadinessUrl));
  checks.push(await artifactDataPlaneCheck(input.config.artifactDataDir));
  checks.push(kmsCheck(input.config));
  checks.push({
    name: "oidc_jwks",
    status: "pass",
    safeMessage: "OIDC issuer, audience and JWKS were loaded at startup",
  });
  checks.push(runnerGrpcCheck(input.config.runnerGrpc?.enabled === true, input.runnerGrpcReady));
  checks.push(missionDispatchCheck(input.config.missionDispatch?.enabled === true, input.missionDispatchLoops));
  checks.push(intelligenceResultConsumerCheck(input.config.intelligenceResultConsumer.enabled, input.resultConsumerLoop.readiness()));
  return {
    status: checks.every((check) => check.status === "pass") ? "ready" : "not-ready",
    checks,
  };
}

async function postgresCheck(input: ReadinessInput): Promise<ServerReadinessCheck> {
  const tenantId = input.config.missionDispatch?.tenantIds[0] ?? input.config.oidc.claimMapper.allowedTenants[0];
  if (tenantId === undefined) {
    return fail("postgres", "NotConfigured", "no tenant is configured for tenant-scoped PostgreSQL readiness");
  }
  try {
    await input.provider.withTenant(tenantId, async ({ db }) => {
      await sql`select 1`.execute(db);
    });
    return { name: "postgres", status: "pass", safeMessage: "tenant-scoped PostgreSQL transaction is operational" };
  } catch (error) {
    return fail("postgres", "Unavailable", "tenant-scoped PostgreSQL transaction failed", { error: errorMessage(error) });
  }
}

async function objectStorageCheck(readinessUrl: string | undefined): Promise<ServerReadinessCheck> {
  if (readinessUrl === undefined) {
    return fail("object_storage", "NotConfigured", "object storage readiness URL is not configured");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(readinessUrl, { signal: controller.signal });
    if (!response.ok) {
      return fail("object_storage", "Unavailable", "object storage readiness endpoint is not healthy", { status: response.status });
    }
    return { name: "object_storage", status: "pass", safeMessage: "object storage readiness endpoint is healthy" };
  } catch (error) {
    return fail("object_storage", "Unavailable", "object storage readiness endpoint failed", { error: errorMessage(error) });
  } finally {
    clearTimeout(timeout);
  }
}

async function artifactDataPlaneCheck(artifactDataDir: string): Promise<ServerReadinessCheck> {
  const probeDir = join(artifactDataDir, ".readiness");
  const probePath = join(probeDir, `probe-${process.pid}.txt`);
  const expected = "qualigence-artifact-data-plane-readiness";
  try {
    await mkdir(probeDir, { recursive: true });
    await writeFile(probePath, expected, "utf8");
    const actual = await readFile(probePath, "utf8");
    await rm(probePath, { force: true });
    if (actual !== expected) {
      return fail("artifact_data_plane", "IntegrityMismatch", "artifact data-plane readiness probe read different bytes");
    }
    return { name: "artifact_data_plane", status: "pass", safeMessage: "artifact data-plane storage is writable and readable" };
  } catch (error) {
    return fail("artifact_data_plane", "Unavailable", "artifact data-plane storage probe failed", { error: errorMessage(error) });
  }
}

function kmsCheck(config: ServerConfig): ServerReadinessCheck {
  return config.evidenceKms === undefined
    ? fail("kms", "NotConfigured", "Evidence KMS root key is not configured; plaintext Evidence access is disabled")
    : { name: "kms", status: "pass", safeMessage: "Evidence KMS configuration was loaded at startup" };
}

function runnerGrpcCheck(enabled: boolean, ready: boolean): ServerReadinessCheck {
  const pass = enabled && ready;
  return {
    name: "runner_grpc",
    status: pass ? "pass" : "fail",
    ...(enabled ? {} : { code: "Disabled" }),
    safeMessage: pass
      ? "authenticated Runner gRPC listener is bound"
      : "authenticated Runner gRPC listener is not ready",
  };
}

function missionDispatchCheck(enabled: boolean, loops: readonly MissionDispatchLoop[]): ServerReadinessCheck {
  const readiness = loops.map((loop) => loop.readiness());
  const pass = enabled && readiness.length > 0 && readiness.every((loop) => loop.status === "ready");
  return {
    name: "mission_dispatch",
    status: pass ? "pass" : "fail",
    ...(enabled ? {} : { code: "Disabled" }),
    safeMessage: pass
      ? "mission dispatch loops are running for configured tenants"
      : "mission dispatch loops cannot make progress for every configured tenant",
    details: { loops: readiness },
  };
}

function intelligenceResultConsumerCheck(
  enabled: boolean,
  loop: ReturnType<IntelligenceResultConsumerLoop["readiness"]>,
): ServerReadinessCheck {
  const pass = enabled && loop.status === "ready";
  return {
    name: "intelligence_result_consumer",
    status: pass ? "pass" : "fail",
    ...(enabled ? {} : { code: "Disabled" }),
    safeMessage: pass
      ? "intelligence result consumer loop is running"
      : "intelligence result consumer loop cannot make progress",
    details: { ...loop },
  };
}

function fail(
  name: ServerReadinessCheck["name"],
  code: string,
  safeMessage: string,
  details?: Readonly<Record<string, unknown>>,
): ServerReadinessCheck {
  return {
    name,
    status: "fail",
    code,
    safeMessage,
    ...(details === undefined ? {} : { details }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error("[server] fatal", error);
    process.exitCode = 1;
  });
}
