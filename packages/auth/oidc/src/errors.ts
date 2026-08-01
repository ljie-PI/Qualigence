export type OidcErrorCode =
  | "TokenMalformed"
  | "AlgorithmNotAllowed"
  | "SigningKeyUnknown"
  | "SignatureInvalid"
  | "IssuerMismatch"
  | "AudienceMismatch"
  | "TokenExpired"
  | "TokenNotYetValid"
  | "TenantClaimMissing"
  | "TenantNotAllowed"
  | "RoleClaimMissing"
  | "RoleNotAllowed"
  | "Forbidden";

/**
 * A fail-closed authentication/authorization failure. Every unexpected token,
 * unknown key, unmapped claim or missing role surfaces as an {@link OidcError}
 * so the Server can translate it into a safe 401/403 without leaking why.
 */
export class OidcError extends Error {
  readonly code: OidcErrorCode;

  constructor(code: OidcErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "OidcError";
    this.code = code;
  }
}

/** Whether an {@link OidcError} is an authorization (403) rather than authentication (401) failure. */
export function isForbidden(error: OidcError): boolean {
  return error.code === "Forbidden";
}
