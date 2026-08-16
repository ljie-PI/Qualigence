import type { IdTokenAlgorithm } from "./auth/id-token-verifier.js";
import type { OidcClientConfig } from "./auth/oidc-session.js";

/**
 * Runtime configuration for the immutable SPA bundle. Production injects a
 * `window.__QUALIGENCE_CONFIG__` object (served by the reverse proxy) so one
 * built bundle serves Local and every Self-hosted deployment without a rebuild.
 * During `vite dev` the values fall back to Vite env vars.
 */
export interface ConsoleRuntimeConfig {
  /** Absolute base URL of the Public API (e.g. `https://host/api`). */
  readonly apiBaseUrl: string;
  /** `bootstrap` uses a one-time loopback token (Local); `oidc` uses PKCE. */
  readonly authMode: "oidc" | "bootstrap";
  readonly oidc: OidcClientConfig;
}

declare global {
  interface Window {
    __QUALIGENCE_CONFIG__?: Partial<ConsoleRuntimeConfig>;
  }
}

function env(key: string, fallback: string): string {
  const value = import.meta.env[key as keyof ImportMetaEnv] as string | undefined;
  return value ?? fallback;
}

let cached: ConsoleRuntimeConfig | undefined;

function isIdTokenAlgorithm(value: string): value is IdTokenAlgorithm {
  return value === "RS256" || value === "ES256";
}

function parseAllowedAlgorithms(raw: string): readonly IdTokenAlgorithm[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0 || !values.every(isIdTokenAlgorithm)) {
    throw new Error("VITE_OIDC_ALLOWED_ALGORITHMS must contain only RS256 or ES256");
  }
  return values;
}

export function loadRuntimeConfig(): ConsoleRuntimeConfig {
  if (cached !== undefined) {
    return cached;
  }
  const injected = window.__QUALIGENCE_CONFIG__ ?? {};
  const origin = window.location.origin;
  const issuer = env("VITE_OIDC_ISSUER", "https://oidc.example.test/");
  const defaults: ConsoleRuntimeConfig = {
    apiBaseUrl: env("VITE_API_BASE_URL", `${origin}/api`),
    authMode: (env("VITE_AUTH_MODE", "oidc") as ConsoleRuntimeConfig["authMode"]),
    oidc: {
      issuer,
      authorizationEndpoint: env("VITE_OIDC_AUTHORIZE", "https://oidc.example.test/authorize"),
      tokenEndpoint: env("VITE_OIDC_TOKEN", "https://oidc.example.test/token"),
      jwksUri: env(
        "VITE_OIDC_JWKS_URI",
        new URL(".well-known/jwks.json", issuer).toString(),
      ),
      allowedAlgorithms: parseAllowedAlgorithms(
        env("VITE_OIDC_ALLOWED_ALGORITHMS", "RS256"),
      ),
      clientId: env("VITE_OIDC_CLIENT_ID", "qualigence-console"),
      redirectUri: env("VITE_OIDC_REDIRECT_URI", `${origin}/auth/callback`),
      scope: env("VITE_OIDC_SCOPE", "openid profile email"),
      tenantClaim: env("VITE_OIDC_TENANT_CLAIM", "https://qualigence.example/tenant"),
      rolesClaim: env("VITE_OIDC_ROLES_CLAIM", "https://qualigence.example/roles"),
      roleMap: {
        "qa-admin": "admin",
        "qa-tester": "tester",
        "qa-reviewer": "reviewer",
        "qa-viewer": "viewer",
      },
      allowedTenants: env("VITE_OIDC_ALLOWED_TENANTS", "tenant-a,tenant-b")
        .split(",")
        .map((tenant) => tenant.trim())
        .filter((tenant) => tenant.length > 0),
    },
  };
  cached = {
    ...defaults,
    ...injected,
    oidc: { ...defaults.oidc, ...(injected.oidc ?? {}) },
  };
  return cached;
}
