import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import type { Clock } from "@qualigence/shared-kernel";
import type { RequestPrincipal } from "@qualigence/public-api";
import { ClaimMapper, type ClaimMapperConfig } from "./claim-mapper.js";
import { OidcError } from "./errors.js";

/** The JWS algorithms this deployment is permitted to accept. */
export type OidcAlgorithm = "RS256" | "ES256";

export interface OidcSigningKey {
  readonly kid: string;
  readonly alg: OidcAlgorithm;
  readonly publicKey: KeyObject;
}

/**
 * Resolves a token's signing key by `kid`. A production implementation fetches
 * and caches a rotating JWKS with a bounded timeout; {@link StaticJwksResolver}
 * is a deterministic in-memory resolver for composition/tests.
 */
export interface JwksResolver {
  resolve(kid: string): Promise<OidcSigningKey | undefined>;
}

export class StaticJwksResolver implements JwksResolver {
  private readonly byKid: Map<string, OidcSigningKey>;

  constructor(keys: readonly OidcSigningKey[]) {
    this.byKid = new Map(keys.map((key) => [key.kid, key]));
  }

  async resolve(kid: string): Promise<OidcSigningKey | undefined> {
    return this.byKid.get(kid);
  }
}

export interface OidcAuthenticatorConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly allowedAlgorithms: readonly OidcAlgorithm[];
  readonly jwks: JwksResolver;
  readonly clock: Clock;
  readonly claimMapper: ClaimMapper | ClaimMapperConfig;
  /** Permitted clock skew in seconds when checking exp/nbf. Defaults to 60. */
  readonly clockToleranceSeconds?: number;
}

interface JwtHeader {
  readonly alg?: string;
  readonly kid?: string;
  readonly typ?: string;
}

interface JwtClaims {
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | readonly string[];
  readonly exp?: number;
  readonly nbf?: number;
  readonly [claim: string]: unknown;
}

function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(json);
}

/**
 * Independently validates an OIDC access token: signature against the resolved
 * JWKS key, an allowlisted algorithm, exact issuer/audience, expiry/not-before,
 * and finally maps only the allowlisted tenant/role claims. Every deviation
 * fails closed via {@link OidcError}. This runs on the Server regardless of what
 * the browser did, so a forged or algorithm-downgraded token never authenticates.
 */
export class OidcAuthenticator {
  private readonly allowed: ReadonlySet<OidcAlgorithm>;
  private readonly claimMapper: ClaimMapper;
  private readonly toleranceMs: number;

  constructor(private readonly config: OidcAuthenticatorConfig) {
    this.allowed = new Set(config.allowedAlgorithms);
    this.claimMapper =
      config.claimMapper instanceof ClaimMapper
        ? config.claimMapper
        : new ClaimMapper(config.claimMapper);
    this.toleranceMs = (config.clockToleranceSeconds ?? 60) * 1000;
  }

  async authenticate(token: string): Promise<RequestPrincipal> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new OidcError("TokenMalformed", "a JWT must have three segments");
    }
    const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

    let header: JwtHeader;
    let claims: JwtClaims;
    try {
      header = decodeSegment(headerSegment) as JwtHeader;
      claims = decodeSegment(payloadSegment) as JwtClaims;
    } catch {
      throw new OidcError("TokenMalformed", "token segments are not valid base64url JSON");
    }

    const alg = header.alg;
    if (alg === undefined || !this.allowed.has(alg as OidcAlgorithm)) {
      throw new OidcError("AlgorithmNotAllowed", `algorithm ${String(alg)} is not allowed`);
    }
    if (header.kid === undefined) {
      throw new OidcError("SigningKeyUnknown", "token header has no kid");
    }

    const key = await this.config.jwks.resolve(header.kid);
    if (key === undefined || key.alg !== alg) {
      throw new OidcError("SigningKeyUnknown", `no signing key for kid ${header.kid}`);
    }

    this.verifySignature(
      alg as OidcAlgorithm,
      key.publicKey,
      `${headerSegment}.${payloadSegment}`,
      signatureSegment,
    );

    if (claims.iss !== this.config.issuer) {
      throw new OidcError("IssuerMismatch", `issuer ${String(claims.iss)} is not trusted`);
    }
    const audiences = Array.isArray(claims.aud)
      ? claims.aud
      : typeof claims.aud === "string"
        ? [claims.aud]
        : [];
    if (!audiences.includes(this.config.audience)) {
      throw new OidcError("AudienceMismatch", "audience does not include this deployment");
    }

    const nowMs = Date.parse(this.config.clock.now());
    if (typeof claims.exp === "number" && nowMs > claims.exp * 1000 + this.toleranceMs) {
      throw new OidcError("TokenExpired", "token has expired");
    }
    if (typeof claims.nbf === "number" && nowMs < claims.nbf * 1000 - this.toleranceMs) {
      throw new OidcError("TokenNotYetValid", "token is not yet valid");
    }

    const subject = typeof claims.sub === "string" ? claims.sub : "";
    return this.claimMapper.map(subject, claims);
  }

  private verifySignature(
    alg: OidcAlgorithm,
    publicKey: KeyObject,
    signingInput: string,
    signatureSegment: string,
  ): void {
    const signature = Buffer.from(signatureSegment, "base64url");
    const verifier = createVerify("SHA256");
    verifier.update(signingInput);
    verifier.end();
    const ok =
      alg === "ES256"
        ? verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, signature)
        : verifier.verify(publicKey, signature);
    if (!ok) {
      throw new OidcError("SignatureInvalid", "token signature verification failed");
    }
  }
}

/** Build an {@link OidcSigningKey} from a PEM SPKI public key. */
export function signingKeyFromPem(kid: string, alg: OidcAlgorithm, pem: string): OidcSigningKey {
  return { kid, alg, publicKey: createPublicKey(pem) };
}
