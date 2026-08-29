import type { PublicApiRole } from "@qualigence/public-api";
import { createPkceMaterial } from "./pkce.js";
import type { ConsoleSession } from "./memory-token-store.js";
import {
  IdTokenVerificationError,
  type IdTokenAlgorithm,
  type IdTokenVerifier,
} from "./id-token-verifier.js";

/**
 * A minimal transient store for the short-lived, per-authorization `state` /
 * `nonce` / `code_verifier` record. The browser adapter backs this with
 * TTL-bounded `sessionStorage`; the access token is deliberately NOT eligible
 * for this store. Abstracting it keeps `oidc-session` pure and testable.
 */
export interface TransientStore {
  set(key: string, value: string): void;
  get(key: string): string | undefined;
  remove(key: string): void;
}

/** Deployment-pinned OIDC client configuration (mirrors the server allowlist). */
export interface OidcClientConfig {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly allowedAlgorithms: readonly IdTokenAlgorithm[];
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly tenantClaim: string;
  readonly rolesClaim: string;
  readonly roleMap: Readonly<Record<string, PublicApiRole>>;
  readonly allowedTenants: readonly string[];
}

interface TransientRecord {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly createdAtMs: number;
}

export interface AuthorizationRequest {
  /** The full IdP authorization URL to which the browser must redirect. */
  readonly authorizationUrl: string;
  /** The generated `state`, stored transiently and echoed on the callback. */
  readonly state: string;
}

export interface CallbackParams {
  readonly code: string;
  readonly state: string;
}

interface TokenResponse {
  readonly access_token: string;
  readonly id_token: string;
  readonly token_type: string;
  readonly expires_in: number;
}

const TRANSIENT_PREFIX = "oidc.tx.";
/** Transient authorization records older than this are rejected as stale. */
export const TRANSIENT_TTL_MS = 10 * 60 * 1000;

export class OidcSessionError extends Error {
  constructor(
    readonly reason:
      | "StateMismatch"
      | "TransientMissing"
      | "TransientExpired"
      | "NonceMismatch"
      | "IssuerMismatch"
      | "AudienceMismatch"
      | "TokenExpired"
      | "TenantNotAllowed"
      | "RoleNotAllowed"
      | "TokenExchangeFailed"
      | "TokenMalformed"
      | "TokenSignatureInvalid"
      | "JwksUnavailable"
      | "AuthorizationFailed",
    message: string,
  ) {
    super(message);
    this.name = "OidcSessionError";
  }
}

function mapPrincipal(
  config: OidcClientConfig,
  claims: Record<string, unknown>,
): { tenantId: string; roles: readonly PublicApiRole[] } {
  const tenant = claims[config.tenantClaim];
  if (typeof tenant !== "string" || !config.allowedTenants.includes(tenant)) {
    throw new OidcSessionError("TenantNotAllowed", "tenant claim is missing or not allowed");
  }
  const rawRoles = claims[config.rolesClaim];
  const values = typeof rawRoles === "string" ? [rawRoles] : Array.isArray(rawRoles) ? rawRoles : [];
  if (values.length === 0 || !values.every((value) => typeof value === "string")) {
    throw new OidcSessionError("RoleNotAllowed", "role claim is missing or malformed");
  }
  const roles: PublicApiRole[] = [];
  for (const value of values) {
    const mapped = config.roleMap[value];
    if (mapped === undefined) {
      throw new OidcSessionError("RoleNotAllowed", "an ID Token role is not allowed");
    }
    if (!roles.includes(mapped)) {
      roles.push(mapped);
    }
  }
  if (roles.length === 0) {
    throw new OidcSessionError("RoleNotAllowed", "no allowed role claim present");
  }
  return { tenantId: tenant, roles };
}

/**
 * Drives the OIDC Authorization Code + PKCE S256 flow. `beginAuthorization`
 * generates independent per-authorization secrets, persists only the transient
 * record and returns the IdP URL. `completeAuthorization` validates the echoed
 * `state`, exchanges the code (proving possession of the `code_verifier`),
 * validates the `id_token` `nonce`/issuer/audience/expiry, maps allowlisted
 * tenant/role claims (fail-closed) and returns a {@link ConsoleSession} whose
 * access token the caller places in the in-memory store — never in storage.
 */
export class OidcSession {
  constructor(
    private readonly config: OidcClientConfig,
    private readonly transient: TransientStore,
    private readonly idTokenVerifier: IdTokenVerifier,
    // Browser `fetch` is a Window member: preserve its receiver when the
    // default dependency is later invoked from this session instance.
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async beginAuthorization(): Promise<AuthorizationRequest> {
    const pkce = await createPkceMaterial();
    const record: TransientRecord = {
      state: pkce.state,
      nonce: pkce.nonce,
      codeVerifier: pkce.codeVerifier,
      createdAtMs: this.now(),
    };
    this.transient.set(TRANSIENT_PREFIX + pkce.state, JSON.stringify(record));

    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scope);
    url.searchParams.set("state", pkce.state);
    url.searchParams.set("nonce", pkce.nonce);
    url.searchParams.set("code_challenge", pkce.codeChallenge);
    url.searchParams.set("code_challenge_method", pkce.codeChallengeMethod);
    return { authorizationUrl: url.toString(), state: pkce.state };
  }

  async completeAuthorization(params: CallbackParams): Promise<ConsoleSession> {
    const key = TRANSIENT_PREFIX + params.state;
    const raw = this.transient.get(key);
    if (raw === undefined) {
      throw new OidcSessionError("TransientMissing", "no transient record for the returned state");
    }
    try {
      const record = parseTransientRecord(raw);
      if (record.state !== params.state) {
        throw new OidcSessionError("StateMismatch", "state does not match the transient record");
      }
      if (this.now() - record.createdAtMs > TRANSIENT_TTL_MS) {
        throw new OidcSessionError("TransientExpired", "the authorization request expired");
      }

      const token = await this.exchangeCode(params.code, record.codeVerifier);
      const claims = await this.idTokenVerifier.verify(token.id_token, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
      });
      if (claims.nonce !== record.nonce) {
        throw new OidcSessionError("NonceMismatch", "id_token nonce does not match");
      }

      const { tenantId, roles } = mapPrincipal(this.config, claims);
      const nowMs = this.now();
      const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
      if (subject.length === 0) {
        throw new OidcSessionError("TokenMalformed", "id_token subject is missing");
      }
      const expiresAtMs = nowMs + token.expires_in * 1000;
      return { subject, tenantId, roles, accessToken: token.access_token, expiresAtMs };
    } catch (error) {
      if (error instanceof IdTokenVerificationError) {
        throw toSessionVerificationError(error);
      }
      if (error instanceof OidcSessionError) {
        throw error;
      }
      throw new OidcSessionError("TokenMalformed", "the authorization response is malformed");
    } finally {
      this.transient.remove(key);
    }
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: codeVerifier,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
      });
    } catch {
      throw new OidcSessionError("TokenExchangeFailed", "token endpoint is unavailable");
    }
    if (!response.ok) {
      throw new OidcSessionError("TokenExchangeFailed", `token endpoint returned ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OidcSessionError("TokenMalformed", "token endpoint returned malformed JSON");
    }
    return parseTokenResponse(payload);
  }
}

function parseTransientRecord(raw: string): TransientRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OidcSessionError("TokenMalformed", "transient authorization state is malformed");
  }
  if (!isRecord(value)) {
    throw new OidcSessionError("TokenMalformed", "transient authorization state is malformed");
  }
  const { state, nonce, codeVerifier, createdAtMs } = value;
  if (
    typeof state !== "string" || state.length === 0 ||
    typeof nonce !== "string" || nonce.length === 0 ||
    typeof codeVerifier !== "string" || codeVerifier.length === 0 ||
    typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)
  ) {
    throw new OidcSessionError("TokenMalformed", "transient authorization state is malformed");
  }
  return { state, nonce, codeVerifier, createdAtMs };
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!isRecord(value)) {
    throw new OidcSessionError("TokenMalformed", "token endpoint response is malformed");
  }
  const accessToken = value.access_token;
  const idToken = value.id_token;
  const tokenType = value.token_type;
  const expiresIn = value.expires_in;
  if (
    typeof accessToken !== "string" || accessToken.length === 0 ||
    typeof idToken !== "string" || idToken.length === 0 ||
    tokenType !== "Bearer" ||
    typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0
  ) {
    throw new OidcSessionError("TokenMalformed", "token endpoint response is malformed");
  }
  return {
    access_token: accessToken,
    id_token: idToken,
    token_type: tokenType,
    expires_in: expiresIn,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSessionVerificationError(error: IdTokenVerificationError): OidcSessionError {
  switch (error.failure) {
    case "jwks_unavailable":
      return new OidcSessionError("JwksUnavailable", "the ID Token key set is unavailable");
    case "issuer_mismatch":
      return new OidcSessionError("IssuerMismatch", "id_token issuer is not trusted");
    case "audience_mismatch":
      return new OidcSessionError(
        "AudienceMismatch",
        "id_token audience does not include this client",
      );
    case "token_expired":
      return new OidcSessionError("TokenExpired", "id_token has expired");
    case "token_malformed":
      return new OidcSessionError("TokenMalformed", "id_token is malformed");
    case "signature_invalid":
      return new OidcSessionError(
        "TokenSignatureInvalid",
        "id_token signature or signing key is not valid",
      );
  }
}
