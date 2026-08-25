import {
  ClaimMapper,
  OidcAuthenticator,
  RbacAuthorizer,
  StaticJwksResolver,
  signingKeyFromPem,
  type OidcAlgorithm,
  type OidcSigningKey,
} from "@qualigence/oidc";
import { pathToFileURL } from "node:url";
import { ServerIntelligenceResultConsumer } from "@qualigence/core-application";
import {
  acquirePostgresOperationLock,
  assertPostgresSchemaCurrent,
  createPostgresRuntime,
  PostgresIntelligenceResultWakeupStore,
  PostgresReviewTaskRepository,
} from "@qualigence/postgres-runtime";
import { LocalSkillSigner } from "@qualigence/kms-local";
import { PemCaRunnerCertificateIssuer } from "@qualigence/runner-mtls";
import type { Clock } from "@qualigence/shared-kernel";
import { loadServerConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { buildServer } from "./server.js";
import { IntelligenceResultConsumerLoop } from "./intelligence-result-consumer-loop.js";
import {
  PostgresRunnerEnrollmentStore,
  PostgresRunnerPrincipalStore,
} from "./runner-stores.js";
import type { ServerDeps, TenantStores } from "./server-context.js";

interface JwksEntry {
  readonly kid: string;
  readonly alg: OidcAlgorithm;
  readonly publicKeyPem: string;
}

const systemClock: Clock = { now: () => new Date().toISOString() };

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

  const deps: ServerDeps = {
    provider,
    oidc,
    rbac: new RbacAuthorizer(),
    issuer,
    caCertificatePem: config.runnerCa.certificatePem,
    clock: systemClock,
    skillSigner: LocalSkillSigner.open(config.skillSigningDataDir ?? ".qualigence-server/skill-signing"),
    enrollmentStore: (stores: TenantStores) => new PostgresRunnerEnrollmentStore(stores.aux),
    principalStore: (stores: TenantStores) => new PostgresRunnerPrincipalStore(stores.aux),
    reviewRepository: (stores: TenantStores) => new PostgresReviewTaskRepository(stores.db),
    readiness: () => readinessReport(config.intelligenceResultConsumer.enabled, resultConsumerLoop.readiness()),
  };

  const app = buildServer(deps);

  const shutdownServer = async (): Promise<void> => {
    shutdown.abort();
    await resultConsumerLoop.stop();
    await resultWakeups.close();
    await app.close();
    await provider.close();
  };
  process.once("SIGINT", () => void shutdownServer());
  process.once("SIGTERM", () => void shutdownServer());

  await app.listen({ host: config.host, port: config.port });
  if (config.intelligenceResultConsumer.enabled) {
    resultConsumerLoop.start();
  }
  console.error(`[server] listening on ${config.host}:${config.port}`);
}

function readinessReport(
  enabled: boolean,
  loop: ReturnType<IntelligenceResultConsumerLoop["readiness"]>,
): { readonly status: "ready" | "not-ready"; readonly checks: readonly [{ readonly name: "intelligence_result_consumer"; readonly status: "pass" | "fail"; readonly code?: string; readonly safeMessage: string; readonly details: Readonly<Record<string, unknown>> }] } {
  const pass = enabled && loop.status === "ready";
  return {
    status: pass ? "ready" : "not-ready",
    checks: [{
      name: "intelligence_result_consumer",
      status: pass ? "pass" : "fail",
      ...(enabled ? {} : { code: "Disabled" }),
      safeMessage: pass
        ? "intelligence result consumer loop is running"
        : "intelligence result consumer loop cannot make progress",
      details: { ...loop },
    }],
  };
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error("[server] fatal", error);
    process.exitCode = 1;
  });
}
