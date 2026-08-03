import { RunnerIdentityError } from "./errors.js";

/**
 * Lifecycle status of a Runner's certificate binding. A binding is only usable
 * for an incoming mTLS connection while it is `active`; `suspended` and `revoked`
 * bindings fail closed before any Job payload is exchanged.
 */
export type RunnerStatus = "active" | "suspended" | "revoked";

/**
 * A Runner's cryptographic identity bound to a specific tenant/project scope.
 *
 * Unlike LS-05's single-tenant {@link CertificateRunnerIdentity} (which only
 * checks `URI:runner://<id>` against a claimed id), a Self-hosted principal binds
 * the certificate's SHA-256 fingerprint to a `tenantId` + `projectIds` scope so a
 * Runner enrolled for tenant A can never be reinterpreted as belonging to tenant B.
 */
export interface RunnerPrincipal {
  readonly runnerId: string;
  readonly tenantId: string;
  readonly projectIds: readonly string[];
  readonly certificateFingerprintSha256: string;
  readonly certificateUriSan: string;
  readonly enrollmentId: string;
  readonly status: RunnerStatus;
  readonly certificateNotAfter: string;
}

/** SPIFFE trust domain used for Self-hosted Runner URI SANs. */
export const RUNNER_TRUST_DOMAIN = "qualigence.local";

/**
 * Build the frozen URI SAN for a Runner principal:
 * `spiffe://qualigence.local/tenants/<tenantId>/runners/<runnerId>`.
 * The tenant/runner scope is derived only from the persisted enrollment; a CSR's
 * self-declared SAN is always ignored by the issuer.
 */
export function runnerUriSan(tenantId: string, runnerId: string): string {
  return `spiffe://${RUNNER_TRUST_DOMAIN}/tenants/${tenantId}/runners/${runnerId}`;
}

export interface RunnerUriScope {
  readonly tenantId: string;
  readonly runnerId: string;
}

const URI_SAN_PATTERN = new RegExp(
  `^spiffe://${RUNNER_TRUST_DOMAIN.replace(/\./g, "\\.")}/tenants/([^/]+)/runners/([^/]+)$`,
);

/** Parse a Runner URI SAN back into its tenant/runner scope, or `undefined`. */
export function parseRunnerUriSan(uri: string): RunnerUriScope | undefined {
  const match = URI_SAN_PATTERN.exec(uri);
  if (match === null) {
    return undefined;
  }
  const tenantId = match[1];
  const runnerId = match[2];
  if (tenantId === undefined || runnerId === undefined) {
    return undefined;
  }
  return { tenantId, runnerId };
}

export interface RunnerOperationScope {
  readonly tenantId: string;
  readonly projectId: string;
}

/**
 * Authorize a resolved principal against the tenant/project scope of the operation
 * it is attempting. A revoked/suspended principal or a tenant/project mismatch fails
 * closed. This is the seam the gRPC adapter applies before serializing an Offer.
 */
export function authorizeRunnerScope(principal: RunnerPrincipal, scope: RunnerOperationScope): void {
  if (principal.status !== "active") {
    throw new RunnerIdentityError(
      principal.status === "revoked" ? "RunnerCertificateRevoked" : "RunnerSuspended",
      `runner ${principal.runnerId} is ${principal.status}`,
      { details: { runnerId: principal.runnerId, status: principal.status } },
    );
  }
  if (principal.tenantId !== scope.tenantId) {
    throw new RunnerIdentityError(
      "RunnerScopeViolation",
      `runner ${principal.runnerId} is scoped to tenant ${principal.tenantId}, not ${scope.tenantId}`,
      { details: { runnerId: principal.runnerId, tenantId: principal.tenantId, requestedTenantId: scope.tenantId } },
    );
  }
  if (!principal.projectIds.includes(scope.projectId)) {
    throw new RunnerIdentityError(
      "RunnerScopeViolation",
      `runner ${principal.runnerId} is not authorized for project ${scope.projectId}`,
      { details: { runnerId: principal.runnerId, projectIds: principal.projectIds, requestedProjectId: scope.projectId } },
    );
  }
}
