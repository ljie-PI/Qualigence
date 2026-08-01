import { X509Certificate } from "node:crypto";
import { parseRunnerUriSan, type RunnerUriScope } from "@qualigence/runner-identity";

/** OID for the TLS Web Client Authentication extended key usage. */
export const CLIENT_AUTH_EKU_OID = "1.3.6.1.5.5.7.3.2";

export type RunnerClientCertificateInput =
  | X509Certificate
  | Buffer
  | string
  | { readonly raw: Buffer };

/** Normalize any accepted certificate representation into an {@link X509Certificate}. */
export function toX509Certificate(input: RunnerClientCertificateInput): X509Certificate {
  if (input instanceof X509Certificate) {
    return input;
  }
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    return new X509Certificate(input);
  }
  if (input.raw !== undefined && Buffer.isBuffer(input.raw)) {
    return new X509Certificate(input.raw);
  }
  throw new TypeError("unsupported certificate input");
}

/**
 * Canonical SHA-256 fingerprint (lowercase hex, no separators) used to bind a
 * certificate to a {@link RunnerPrincipal}. Both the issuer and the authenticator
 * derive fingerprints through this helper so the stored binding and the presented
 * peer certificate compare identically.
 */
export function certificateSha256Fingerprint(certificate: X509Certificate): string {
  return certificate.fingerprint256.replace(/:/g, "").toLowerCase();
}

/** Does the certificate declare the TLS client-authentication EKU? */
export function hasClientAuthEku(certificate: X509Certificate): boolean {
  const legacy = certificate.toLegacyObject() as { readonly ext_key_usage?: readonly string[] };
  return legacy.ext_key_usage?.includes(CLIENT_AUTH_EKU_OID) === true;
}

/** Extract the Runner tenant/runner scope from the certificate's URI SAN, if present. */
export function runnerScopeFromSan(certificate: X509Certificate): RunnerUriScope | undefined {
  const san = certificate.subjectAltName;
  if (san === undefined || san === "") {
    return undefined;
  }
  for (const entry of san.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed.toUpperCase().startsWith("URI:")) {
      continue;
    }
    const uri = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    const scope = parseRunnerUriSan(uri);
    if (scope !== undefined) {
      return scope;
    }
  }
  return undefined;
}
