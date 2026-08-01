import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A Runner registering itself with a Self-hosted Core deployment for a specific
 * tenant/project. The raw bootstrap token is never persisted; only its SHA-256
 * hash is stored, and the enrollment is single-use: once {@link consumedAt} is set,
 * a replayed token exchange is rejected.
 */
export interface RunnerEnrollment {
  readonly enrollmentId: string;
  readonly tenantId: string;
  readonly runnerId: string;
  readonly projectIds: readonly string[];
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

/**
 * A signed client certificate scoped to a Runner's principal, returned by the
 * certificate issuer. The CA certificate is included so the Runner can pin its
 * trust chain; the fingerprint/expiry are recorded on the {@link RunnerPrincipal}.
 */
export interface IssuedRunnerCertificate {
  readonly runnerId: string;
  readonly certificatePem: string;
  readonly caCertificatePem: string;
  readonly certificateFingerprintSha256: string;
  readonly certificateNotAfter: string;
}

/** Number of random bytes in a bootstrap enrollment token (256-bit). */
export const ENROLLMENT_TOKEN_BYTES = 32;

/** Generate a fresh, high-entropy bootstrap enrollment token (base64url). */
export function generateEnrollmentToken(): string {
  return randomBytes(ENROLLMENT_TOKEN_BYTES).toString("base64url");
}

/** Hash a bootstrap token for at-rest storage. Only the hash is ever persisted. */
export function hashEnrollmentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of a presented token against a stored hash. Rehashing
 * the presented token and comparing digests avoids leaking length/timing of the
 * secret while keeping the stored value a non-reversible hash.
 */
export function tokenMatchesHash(token: string, tokenHash: string): boolean {
  const presented = Buffer.from(hashEnrollmentToken(token), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  if (presented.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(presented, expected);
}
