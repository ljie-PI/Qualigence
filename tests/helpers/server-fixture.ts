import type { FastifyInstance } from "fastify";
import { ClaimMapper, OidcAuthenticator, RbacAuthorizer, StaticJwksResolver } from "@qualigence/oidc";
import {
  createPostgresRuntime,
  PostgresReviewTaskRepository,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { PemCaRunnerCertificateIssuer } from "@qualigence/runner-mtls";
import type { Clock } from "@qualigence/shared-kernel";
import {
  bootstrapServerDatabase,
  buildServer,
  PostgresRunnerEnrollmentStore,
  PostgresRunnerPrincipalStore,
  type ServerDeps,
  type TenantStores,
} from "@qualigence/server";
import { startPostgres, type StartedPostgres } from "./docker-container.js";
import { createTestJwtIssuer, standardClaims, type TestJwtIssuer } from "./oidc-jwt.js";
import { createRunnerCa, type PemPair } from "./runner-identity-pki.js";

const SERVER_ROLE = "qualigence_server";
const SERVER_PASSWORD = "server_pw";
const WORKER_ROLE = "qualigence_worker";
const WORKER_PASSWORD = "worker_pw";

const ISSUER = "https://oidc.example.test/";
const AUDIENCE = "qualigence-self-hosted";
const TENANT_CLAIM = "https://qualigence.example/tenant";
const ROLES_CLAIM = "https://qualigence.example/roles";

export interface ServerFixture {
  readonly app: FastifyInstance;
  readonly baseUrl: string;
  readonly jwt: TestJwtIssuer;
  readonly ca: PemPair;
  readonly provider: TenantTransactionProvider;
  readonly container: StartedPostgres;
  /** Mint a valid access token for a tenant with the given roles. */
  token(tenantId: string, roles: readonly string[], overrides?: Record<string, unknown>): string;
  stop(): Promise<void>;
}

const fixedClock: Clock = { now: () => new Date().toISOString() };

/**
 * Start a real Postgres container, provision the full Server schema (frozen +
 * aux), build the real Fastify server with an in-process OIDC issuer + Runner
 * CA, and listen on an ephemeral local port.
 */
export async function setupServerFixture(): Promise<ServerFixture> {
  const container = await startPostgres();
  const adminConfig = {
    host: container.host,
    port: container.port,
    database: container.database,
    user: container.superuser,
    password: container.password,
  };

  await bootstrapServerDatabase({
    admin: adminConfig,
    roles: {
      server: { name: SERVER_ROLE, password: SERVER_PASSWORD },
      worker: { name: WORKER_ROLE, password: WORKER_PASSWORD },
    },
  });

  const provider = createPostgresRuntime({
    ...adminConfig,
    user: SERVER_ROLE,
    password: SERVER_PASSWORD,
  });

  const jwt = createTestJwtIssuer("RS256");
  const oidc = new OidcAuthenticator({
    issuer: ISSUER,
    audience: AUDIENCE,
    allowedAlgorithms: ["RS256"],
    jwks: new StaticJwksResolver([jwt.signingKey]),
    clock: fixedClock,
    claimMapper: new ClaimMapper({
      tenantClaim: TENANT_CLAIM,
      rolesClaim: ROLES_CLAIM,
      allowedTenants: ["tenant-a", "tenant-b"],
      roleMap: {
        "qa-admin": "admin",
        "qa-tester": "tester",
        "qa-reviewer": "reviewer",
        "qa-viewer": "viewer",
      },
    }),
  });

  const ca = createRunnerCa();
  const issuer = new PemCaRunnerCertificateIssuer({
    caCertificatePem: ca.certPem,
    caPrivateKeyPem: ca.keyPem,
  });

  const deps: ServerDeps = {
    provider,
    oidc,
    rbac: new RbacAuthorizer(),
    issuer,
    caCertificatePem: ca.certPem,
    clock: fixedClock,
    enrollmentStore: (stores: TenantStores) => new PostgresRunnerEnrollmentStore(stores.aux),
    principalStore: (stores: TenantStores) => new PostgresRunnerPrincipalStore(stores.aux),
    reviewRepository: (stores: TenantStores) => new PostgresReviewTaskRepository(stores.db),
  };

  const app = buildServer(deps);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const roleMapReverse: Record<string, string> = {
    admin: "qa-admin",
    tester: "qa-tester",
    reviewer: "qa-reviewer",
    viewer: "qa-viewer",
  };

  function token(
    tenantId: string,
    roles: readonly string[],
    overrides: Record<string, unknown> = {},
  ): string {
    return jwt.sign(
      standardClaims({
        iss: ISSUER,
        aud: AUDIENCE,
        [TENANT_CLAIM]: tenantId,
        [ROLES_CLAIM]: roles.map((role) => roleMapReverse[role] ?? role),
        ...overrides,
      }),
    );
  }

  return {
    app,
    baseUrl,
    jwt,
    ca,
    provider,
    container,
    token,
    async stop() {
      await app.close();
      await provider.close();
      await container.stop();
    },
  };
}
