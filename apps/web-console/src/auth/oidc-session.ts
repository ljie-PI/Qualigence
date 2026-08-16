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
  readonly expires_in?: number;
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
      | "JwksUnavailable",
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
  const roles: PublicApiRole[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const mapped = config.roleMap[value];
    if (mapped === undefined) {
      throw new OidcSessionError("RoleNotAllowed", `role ${value} is not allowed`);
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
    private readonly fetchImpl: typeof fetch = fetch,
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
    const record = JSON.parse(raw) as TransientRecord;
    if (record.state !== params.state) {
      throw new OidcSessionError("StateMismatch", "state does not match the transient record");
    }
    if (this.now() - record.createdAtMs > TRANSIENT_TTL_MS) {
      this.transient.remove(key);
      throw new OidcSessionError("TransientExpired", "the authorization request expired");
    }

    const token = await this.exchangeCode(params.code, record.codeVerifier);
    try {
      const claims = await this.idTokenVerifier.verify(token.id_token, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
      });
      if (claims.nonce !== record.nonce) {
        throw new OidcSessionError("NonceMismatch", "id_token nonce does not match");
      }

      const { tenantId, roles } = mapPrincipal(this.config, claims);
      const nowMs = this.now();
      const subject = typeof claims.sub === "string" ? claims.sub : "";
      const expiresAtMs =
        token.expires_in !== undefined
          ? nowMs + token.expires_in * 1000
          : nowMs + 3600 * 1000;
      this.transient.remove(key);
      return { subject, tenantId, roles, accessToken: token.access_token, expiresAtMs };
    } catch (error) {
      this.transient.remove(key);
      if (error instanceof IdTokenVerificationError) {
        throw toSessionVerificationError(error);
      }
      throw error;
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
    const response = await this.fetchImpl(this.config.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new OidcSessionError("TokenExchangeFailed", `token endpoint returned ${response.status}`);
    }
    return (await response.json()) as TokenResponse;
  }
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
