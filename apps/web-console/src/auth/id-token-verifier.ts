import { createRemoteJWKSet, errors, jwtVerify } from "jose";

export type IdTokenAlgorithm = "RS256" | "ES256";

export interface IdTokenVerifier {
  verify(
    token: string,
    expected: { readonly issuer: string; readonly audience: string },
  ): Promise<Record<string, unknown>>;
}

export type IdTokenVerificationFailure =
  | "signature_invalid"
  | "jwks_unavailable"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "token_expired"
  | "token_malformed";

export class IdTokenVerificationError extends Error {
  constructor(readonly failure: IdTokenVerificationFailure) {
    super(failure);
    this.name = "IdTokenVerificationError";
  }
}

export interface RemoteJwksIdTokenVerifierConfig {
  readonly jwksUri: string;
  readonly allowedAlgorithms: readonly string[];
  readonly timeoutDuration?: number;
  readonly cooldownDuration?: number;
  readonly cacheMaxAge?: number;
}

/**
 * Browser-compatible ID Token verifier bound to one deployment-pinned JWKS
 * endpoint. The resolver is created once so its key set, cooldown, and cache
 * survive every authorization handled by this verifier instance.
 */
export class RemoteJwksIdTokenVerifier implements IdTokenVerifier {
  private readonly jwks;
  private readonly allowedAlgorithms: readonly IdTokenAlgorithm[];

  constructor(config: RemoteJwksIdTokenVerifierConfig) {
    if (config.allowedAlgorithms.length === 0 || !config.allowedAlgorithms.every(isAllowedAlgorithm)) {
      throw new Error("ID Token algorithms must contain only RS256 or ES256");
    }
    this.allowedAlgorithms = config.allowedAlgorithms;
    this.jwks = createRemoteJWKSet(new URL(config.jwksUri), {
      timeoutDuration: config.timeoutDuration ?? 5_000,
      cooldownDuration: config.cooldownDuration ?? 30_000,
      cacheMaxAge: config.cacheMaxAge ?? 10 * 60 * 1000,
    });
  }

  async verify(
    token: string,
    expected: { readonly issuer: string; readonly audience: string },
  ): Promise<Record<string, unknown>> {
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: expected.issuer,
        audience: expected.audience,
        algorithms: [...this.allowedAlgorithms],
        requiredClaims: ["iss", "aud", "exp", "sub"],
      });
      return { ...result.payload };
    } catch (error) {
      throw mapVerificationError(error);
    }
  }
}

function isAllowedAlgorithm(value: string): value is IdTokenAlgorithm {
  return value === "RS256" || value === "ES256";
}

function mapVerificationError(error: unknown): IdTokenVerificationError {
  if (error instanceof errors.JWTExpired) {
    return new IdTokenVerificationError("token_expired");
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case "iss":
        return new IdTokenVerificationError("issuer_mismatch");
      case "aud":
        return new IdTokenVerificationError("audience_mismatch");
      case "exp":
        return new IdTokenVerificationError("token_expired");
      default:
        return new IdTokenVerificationError("token_malformed");
    }
  }
  if (error instanceof errors.JWKSTimeout) {
    return new IdTokenVerificationError("jwks_unavailable");
  }
  if (error instanceof errors.JOSEError) {
    if (error.code === "ERR_JOSE_GENERIC" || error.code === "ERR_JWKS_INVALID") {
      return new IdTokenVerificationError("jwks_unavailable");
    }
    if (error.code === "ERR_JWT_INVALID" || error.code === "ERR_JWS_INVALID") {
      return new IdTokenVerificationError("token_malformed");
    }
    return new IdTokenVerificationError("signature_invalid");
  }
  return new IdTokenVerificationError("signature_invalid");
}
