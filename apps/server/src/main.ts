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
import {
  assertPostgresSchemaCurrent,
  createPostgresRuntime,
  PostgresReviewTaskRepository,
} from "@qualigence/postgres-runtime";
import { PemCaRunnerCertificateIssuer } from "@qualigence/runner-mtls";
import type { Clock } from "@qualigence/shared-kernel";
import { loadServerConfig } from "./config.js";
import type { ServerConfig } from "./config.js";
import { buildServer } from "./server.js";
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
    enrollmentStore: (stores: TenantStores) => new PostgresRunnerEnrollmentStore(stores.aux),
    principalStore: (stores: TenantStores) => new PostgresRunnerPrincipalStore(stores.aux),
    reviewRepository: (stores: TenantStores) => new PostgresReviewTaskRepository(stores.db),
  };

  const app = buildServer(deps);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await provider.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await app.listen({ host: config.host, port: config.port });
  console.error(`[server] listening on ${config.host}:${config.port}`);
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error("[server] fatal", error);
    process.exitCode = 1;
  });
}
