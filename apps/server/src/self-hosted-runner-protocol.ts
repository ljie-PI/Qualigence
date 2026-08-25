import type { PeerCertificate } from "node:tls";
import {
  TenantRunnerApplicationResolver,
  type RunCompletionSink,
  type SessionWelcomeParameters,
  type TenantRunnerApplicationResolverOptions,
} from "@qualigence/core-application";
import {
  OperationScopedPostgresRunnerControlStore,
  OperationScopedPostgresTraceStore,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import type { RunnerPrincipalStore } from "@qualigence/runner-identity";
import {
  RunnerIdentityError,
} from "@qualigence/runner-identity";
import {
  runnerScopeFromSan,
  SelfHostedRunnerAuthenticator,
  toX509Certificate,
  type SelfHostedAuthenticatedRunner,
} from "@qualigence/runner-mtls";
import type { RunnerHello } from "@qualigence/runner-protocol";
import type { Clock } from "@qualigence/shared-kernel";
import type { TenantStores } from "./server-context.js";

export interface SelfHostedRunnerPeerAuthenticatorOptions {
  readonly provider: TenantTransactionProvider;
  readonly caCertificatePem: string | Buffer;
  readonly clock: Clock;
  readonly principalStore: (stores: TenantStores) => RunnerPrincipalStore;
}

export interface SelfHostedRunnerApplicationResolverOptions {
  readonly provider: TenantTransactionProvider;
  readonly welcome: SessionWelcomeParameters;
  readonly clock: Clock;
  readonly integrityEvents: TenantRunnerApplicationResolverOptions["integrityEvents"];
  readonly leaseDurationMs?: number;
  readonly completionSink?: RunCompletionSink;
}

/**
 * Runner gRPC authenticator for Self-hosted composition. It derives the tenant
 * routing key from the verified certificate SAN before opening a tenant-scoped
 * transaction, then delegates principal validation to the Runner mTLS module.
 */
export function selfHostedRunnerPeerAuthenticator(
  options: SelfHostedRunnerPeerAuthenticatorOptions,
): { authenticate(peer: PeerCertificate | undefined, hello: RunnerHello): Promise<SelfHostedAuthenticatedRunner> } {
  return {
    async authenticate(peer, hello) {
      if (peer === undefined || Object.keys(peer).length === 0) {
        throw new RunnerIdentityError("RunnerCertificateUntrusted", "no client certificate was presented");
      }
      const certificate = toX509Certificate(peer);
      const scope = runnerScopeFromSan(certificate);
      if (scope === undefined) {
        throw new RunnerIdentityError("RunnerIdentityMismatch", "certificate has no runner URI SAN");
      }
      return options.provider.withTenant(scope.tenantId, async ({ db }) => {
        const stores = { db, aux: db } as unknown as TenantStores;
        const authenticator = new SelfHostedRunnerAuthenticator({
          caCertificatePem: options.caCertificatePem,
          principals: options.principalStore(stores),
          clock: options.clock,
        });
        return authenticator.authenticate(peer, hello);
      });
    },
  };
}

/**
 * Build the tenant-bound Runner application resolver used by Self-hosted Runner
 * protocol servers. The returned resolver caches only the stateless service
 * graph per tenant; the injected PostgreSQL stores open fresh RLS transactions
 * for every operation.
 */
export function selfHostedRunnerApplicationResolver(
  options: SelfHostedRunnerApplicationResolverOptions,
): TenantRunnerApplicationResolver {
  return new TenantRunnerApplicationResolver({
    welcome: options.welcome,
    runnerControlStore: (tenantId) => new OperationScopedPostgresRunnerControlStore(options.provider, tenantId, { projectSelfHostedCompletion: true }),
    traceStore: (tenantId) => new OperationScopedPostgresTraceStore(options.provider, tenantId, options.clock),
    integrityEvents: options.integrityEvents,
    now: () => Date.parse(options.clock.now()),
    ...(options.leaseDurationMs === undefined ? {} : { leaseDurationMs: options.leaseDurationMs }),
    ...(options.completionSink === undefined ? {} : { completionSink: options.completionSink }),
  });
}
