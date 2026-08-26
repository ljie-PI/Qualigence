import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from "node:crypto";
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

/** Current health summary for a JWKS resolver dependency. */
export interface JwksReadiness {
  readonly status: "ready" | "not-ready";
  readonly keyCount: number;
  readonly cacheExpiresAt?: string;
  readonly lastRefreshAt?: string;
  readonly lastError?: string;
}

/**
 * Resolves a token's signing key by `kid`. Production uses
 * {@link RemoteJwksResolver} to fetch and cache rotating remote JWKS with a
 * bounded timeout; {@link StaticJwksResolver} is a deterministic in-memory
 * resolver for tests and offline bootstrap fixtures.
 */
export interface JwksResolver {
  resolve(kid: string): Promise<OidcSigningKey | undefined>;
  refresh?(): Promise<void>;
  readiness?(): JwksReadiness;
}

export class StaticJwksResolver implements JwksResolver {
  private readonly byKid: Map<string, OidcSigningKey>;

  constructor(keys: readonly OidcSigningKey[]) {
    this.byKid = new Map(keys.map((key) => [key.kid, key]));
  }

  async resolve(kid: string): Promise<OidcSigningKey | undefined> {
    return this.byKid.get(kid);
  }

  readiness(): JwksReadiness {
    return { status: this.byKid.size > 0 ? "ready" : "not-ready", keyCount: this.byKid.size };
  }
}

export interface RemoteJwksResolverConfig {
  readonly jwksUri: string;
  readonly allowedAlgorithms: readonly OidcAlgorithm[];
  /** Network and response body timeout in milliseconds. Defaults to 5000. */
  readonly timeoutMs?: number;
  /** Maximum age for a fetched key set. Defaults to ten minutes. */
  readonly cacheTtlMs?: number;
  /** Minimum time between forced unknown-kid refreshes. Defaults to 30000. */
  readonly rotationCooldownMs?: number;
  readonly fetcher?: (input: URL, init: { readonly signal: AbortSignal }) => Promise<Response>;
  readonly clock?: Clock;
}

interface JwksDocument {
  readonly keys?: readonly unknown[];
}

const DEFAULT_JWKS_TIMEOUT_MS = 5_000;
const DEFAULT_JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_JWKS_ROTATION_COOLDOWN_MS = 30_000;

/**
 * Remote JWKS resolver for Self-hosted OIDC. It only accepts configured
 * asymmetric signing algorithms, fetches over an operator-pinned URI with a
 * hard timeout, caches key sets for a bounded TTL, and forces a bounded refresh
 * on an unknown `kid` so issuer key rotation works without accepting stale or
 * unverified claims.
 */
export class RemoteJwksResolver implements JwksResolver {
  private readonly jwksUri: URL;
  private readonly allowedAlgorithms: ReadonlySet<OidcAlgorithm>;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly rotationCooldownMs: number;
  private readonly fetcher: (input: URL, init: { readonly signal: AbortSignal }) => Promise<Response>;
  private readonly clock: Clock;
  private cache: { readonly keys: ReadonlyMap<string, OidcSigningKey>; readonly expiresAtMs: number } | undefined;
  private lastRefreshAtMs: number | undefined;
  private lastForcedRefreshAtMs: number | undefined;
  private lastError: string | undefined;
  private inFlightRefresh: Promise<void> | undefined;

  constructor(config: RemoteJwksResolverConfig) {
    this.jwksUri = parseJwksUri(config.jwksUri);
    if (config.allowedAlgorithms.length === 0) {
      throw new Error("remote JWKS allowedAlgorithms must not be empty");
    }
    this.allowedAlgorithms = new Set(config.allowedAlgorithms.map((alg) => {
      if (!isOidcAlgorithm(alg)) {
        throw new Error("remote JWKS allowedAlgorithms must contain only RS256 or ES256");
      }
      return alg;
    }));
    this.timeoutMs = boundedPositive(config.timeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS, "timeoutMs", 60_000);
    this.cacheTtlMs = boundedPositive(config.cacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS, "cacheTtlMs", 24 * 60 * 60 * 1000);
    this.rotationCooldownMs = boundedNonNegative(config.rotationCooldownMs ?? DEFAULT_JWKS_ROTATION_COOLDOWN_MS, "rotationCooldownMs", 60_000);
    this.fetcher = config.fetcher ?? ((input, init) => fetch(input, init));
    this.clock = config.clock ?? { now: () => new Date().toISOString() };
  }

  async resolve(kid: string): Promise<OidcSigningKey | undefined> {
    const nowMs = this.nowMs();
    const cached = this.cache;
    if (cached !== undefined && cached.expiresAtMs > nowMs) {
      const key = cached.keys.get(kid);
      if (key !== undefined) return key;
      if (this.lastForcedRefreshAtMs !== undefined && nowMs - this.lastForcedRefreshAtMs < this.rotationCooldownMs) {
        return undefined;
      }
      this.lastForcedRefreshAtMs = nowMs;
      await this.refreshAt(nowMs);
      return this.cache?.keys.get(kid);
    }

    await this.refreshAt(nowMs);
    return this.cache?.keys.get(kid);
  }

  async refresh(): Promise<void> {
    await this.refreshAt(this.nowMs());
  }

  readiness(): JwksReadiness {
    const nowMs = this.nowMs();
    const keyCount = this.cache?.keys.size ?? 0;
    return {
      status: this.cache !== undefined && this.cache.expiresAtMs > nowMs && this.lastError === undefined
        ? "ready"
        : "not-ready",
      keyCount,
      ...(this.cache === undefined ? {} : { cacheExpiresAt: new Date(this.cache.expiresAtMs).toISOString() }),
      ...(this.lastRefreshAtMs === undefined ? {} : { lastRefreshAt: new Date(this.lastRefreshAtMs).toISOString() }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  private async refreshAt(nowMs: number): Promise<void> {
    if (this.inFlightRefresh !== undefined) {
      await this.inFlightRefresh;
      return;
    }
    this.inFlightRefresh = this.fetchAndReplace(nowMs).finally(() => {
      this.inFlightRefresh = undefined;
    });
    await this.inFlightRefresh;
  }

  private async fetchAndReplace(nowMs: number): Promise<void> {
    try {
      const document = await fetchJwksDocument(this.jwksUri, this.timeoutMs, this.fetcher);
      const keys = parseJwks(document, this.allowedAlgorithms);
      if (keys.size === 0) {
        throw new OidcError("JwksInvalid", "JWKS did not contain any allowed signing keys");
      }
      this.cache = { keys, expiresAtMs: nowMs + this.cacheTtlMs };
      this.lastRefreshAtMs = nowMs;
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof OidcError ? error.code : "JwksUnavailable";
      throw error;
    }
  }

  private nowMs(): number {
    const nowMs = Date.parse(this.clock.now());
    if (!Number.isFinite(nowMs)) throw new Error("RemoteJwksResolver clock returned a non-ISO instant");
    return nowMs;
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
    if (config.allowedAlgorithms.length === 0 || !config.allowedAlgorithms.every(isOidcAlgorithm)) {
      throw new Error("OIDC allowedAlgorithms must contain only RS256 or ES256");
    }
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
    if (!Number.isFinite(nowMs)) {
      throw new Error("OIDC authenticator clock returned a non-ISO instant");
    }
    if (typeof claims.exp !== "number") {
      throw new OidcError("TokenMalformed", "token is missing exp");
    }
    if (nowMs > claims.exp * 1000 + this.toleranceMs) {
      throw new OidcError("TokenExpired", "token has expired");
    }
    if (claims.nbf !== undefined && typeof claims.nbf !== "number") {
      throw new OidcError("TokenMalformed", "token nbf must be numeric when present");
    }
    if (typeof claims.nbf === "number" && nowMs < claims.nbf * 1000 - this.toleranceMs) {
      throw new OidcError("TokenNotYetValid", "token is not yet valid");
    }

    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new OidcError("TokenMalformed", "token is missing subject");
    }
    return this.claimMapper.map(claims.sub, claims);
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

export function isOidcAlgorithm(value: string): value is OidcAlgorithm {
  return value === "RS256" || value === "ES256";
}

async function fetchJwksDocument(
  jwksUri: URL,
  timeoutMs: number,
  fetcher: (input: URL, init: { readonly signal: AbortSignal }) => Promise<Response>,
): Promise<JwksDocument> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new OidcError("JwksTimeout", "JWKS request timed out"));
      controller.abort();
    }, timeoutMs);
  });
  const request = (async (): Promise<string> => {
    const response = await fetcher(jwksUri, { signal: controller.signal });
    if (!response.ok) {
      throw new OidcError("JwksUnavailable", `JWKS endpoint returned ${response.status}`);
    }
    return response.text();
  })();

  let body: string;
  try {
    body = await Promise.race([request, timeout]);
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError("JwksUnavailable", "JWKS endpoint is unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  try {
    const parsed = JSON.parse(body) as JwksDocument;
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.keys)) {
      throw new Error("invalid JWKS shape");
    }
    return parsed;
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError("JwksInvalid", "JWKS response is not a valid key set");
  }
}

function parseJwks(
  document: JwksDocument,
  allowedAlgorithms: ReadonlySet<OidcAlgorithm>,
): ReadonlyMap<string, OidcSigningKey> {
  const keys = new Map<string, OidcSigningKey>();
  for (const entry of document.keys ?? []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const jwk = entry as Readonly<Record<string, unknown>>;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (typeof jwk.kid !== "string" || jwk.kid.length === 0) continue;
    if (typeof jwk.alg !== "string" || !isOidcAlgorithm(jwk.alg) || !allowedAlgorithms.has(jwk.alg)) continue;
    if (!isSupportedKeyType(jwk, jwk.alg)) continue;
    try {
      keys.set(jwk.kid, {
        kid: jwk.kid,
        alg: jwk.alg,
        publicKey: createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }),
      });
    } catch {
      continue;
    }
  }
  return keys;
}

function isSupportedKeyType(jwk: Readonly<Record<string, unknown>>, alg: OidcAlgorithm): boolean {
  return (alg === "RS256" && jwk.kty === "RSA") || (alg === "ES256" && jwk.kty === "EC" && jwk.crv === "P-256");
}

function parseJwksUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("jwksUri must be an absolute URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
    throw new Error("jwksUri must use HTTP(S) without credentials");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("jwksUri permits HTTP only on loopback");
  }
  return url;
}

function boundedPositive(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function boundedNonNegative(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be a non-negative safe integer no greater than ${maximum}`);
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
