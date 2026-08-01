import type { IssuedRunnerCertificate, RunnerEnrollment } from "../domain/runner-enrollment.js";
import type { RunnerPrincipal } from "../domain/runner-principal.js";

/**
 * Input to the certificate issuer. The `uriSan` is derived by the application from
 * the persisted enrollment (never from the CSR), and the issuer must ignore any
 * subject/SAN embedded in the CSR.
 */
export interface IssueRunnerCertificateInput {
  readonly runnerId: string;
  readonly tenantId: string;
  readonly csrPem: string;
  readonly uriSan: string;
}

/**
 * Port for signing a Runner's CSR into a scoped client certificate. The default
 * adapter (`@qualigence/runner-mtls`) uses an in-process PEM CA whose key comes
 * from a SecretProvider, but an enterprise PKI implementation is substitutable.
 * Implementations MUST validate CSR signature/key strength and derive SAN/scope
 * only from {@link IssueRunnerCertificateInput}.
 */
export interface RunnerCertificateIssuer {
  issue(input: IssueRunnerCertificateInput): Promise<IssuedRunnerCertificate>;
}

/**
 * Persistence port for enrollments. {@link consume} MUST be an atomic
 * test-and-set: it marks the enrollment consumed only if it was not already
 * consumed, returning `false` on a replay so single-use is enforced even under
 * concurrent exchanges.
 */
export interface RunnerEnrollmentStore {
  create(enrollment: RunnerEnrollment): Promise<void>;
  findById(enrollmentId: string): Promise<RunnerEnrollment | undefined>;
  consume(enrollmentId: string, consumedAt: string): Promise<boolean>;
  release(enrollmentId: string): Promise<void>;
}

/**
 * Persistence port for certificate bindings. A Runner may have more than one
 * `active` binding at a time (during rotation) so a new certificate can be issued
 * before the old one expires without forcing downtime. Lookups are keyed by
 * certificate fingerprint so an incoming mTLS peer resolves to exactly one
 * principal.
 */
export interface RunnerPrincipalStore {
  put(principal: RunnerPrincipal): Promise<void>;
  findByFingerprint(fingerprintSha256: string): Promise<RunnerPrincipal | undefined>;
  listByRunner(tenantId: string, runnerId: string): Promise<readonly RunnerPrincipal[]>;
  setStatusForRunner(
    tenantId: string,
    runnerId: string,
    status: RunnerPrincipal["status"],
  ): Promise<readonly RunnerPrincipal[]>;
}
