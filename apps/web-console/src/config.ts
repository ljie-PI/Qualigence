import type { PublicApiRole } from "@qualigence/public-api";
import type { IdTokenAlgorithm } from "./auth/id-token-verifier.js";
import type { OidcClientConfig } from "./auth/oidc-session.js";

export interface ConsoleRuntimeConfig {
  readonly apiBaseUrl: string;
  readonly authMode: "oidc" | "bootstrap";
  readonly oidc: OidcClientConfig;
}

declare global {
  interface Window {
    __QUALIGENCE_CONFIG__?: unknown;
  }
}

type EnvironmentValues = Readonly<Record<string, string | undefined>>;

let cached: ConsoleRuntimeConfig | undefined;

export function loadRuntimeConfig(): ConsoleRuntimeConfig {
  const browserWindow = (globalThis as {
    readonly window?: {
      readonly __QUALIGENCE_CONFIG__?: unknown;
      readonly location: { readonly origin: string };
    };
  }).window;
  if (browserWindow === undefined) {
    throw new Error("Browser runtime is unavailable");
  }
  const meta = import.meta as ImportMeta & { readonly env: EnvironmentValues };
  cached ??= resolveRuntimeConfig(
    browserWindow.__QUALIGENCE_CONFIG__,
    browserWindow.location.origin,
    meta.env,
  );
  return cached;
}

export function resolveRuntimeConfig(
  injectedValue: unknown,
  consoleOrigin: string,
  environment: EnvironmentValues,
): ConsoleRuntimeConfig {
  const injected = optionalRecord(injectedValue, "runtime config");
  const injectedOidc = optionalRecord(injected.oidc, "oidc");
  const env = (key: string, fallback: string): string => environment[key] ?? fallback;
  const originUrl = parseUrl(consoleOrigin, "console origin", ["https:", "http:"]);
  if (originUrl.protocol === "http:" && !isLoopback(originUrl.hostname)) {
    throw new Error("console origin permits HTTP only on loopback");
  }
  const origin = originUrl.origin;

  const issuer = readString(
    injectedOidc.issuer,
    env("VITE_OIDC_ISSUER", "https://oidc.example.test/"),
    "issuer",
  );
  const explicitEnvironmentJwks = environment.VITE_OIDC_JWKS_URI;
  const jwksFallback = explicitEnvironmentJwks ?? new URL(".well-known/jwks.json", issuer).toString();

  const config: ConsoleRuntimeConfig = {
    apiBaseUrl: readString(
      injected.apiBaseUrl,
      env("VITE_API_BASE_URL", `${origin}/api`),
      "apiBaseUrl",
    ),
    authMode: parseAuthMode(injected.authMode ?? env("VITE_AUTH_MODE", "oidc")),
    oidc: {
      issuer,
      authorizationEndpoint: readString(
        injectedOidc.authorizationEndpoint,
        env("VITE_OIDC_AUTHORIZE", "https://oidc.example.test/authorize"),
        "authorizationEndpoint",
      ),
      tokenEndpoint: readString(
        injectedOidc.tokenEndpoint,
        env("VITE_OIDC_TOKEN", "https://oidc.example.test/token"),
        "tokenEndpoint",
      ),
      jwksUri: readString(injectedOidc.jwksUri, jwksFallback, "jwksUri"),
      allowedAlgorithms: parseAlgorithms(
        injectedOidc.allowedAlgorithms ?? env("VITE_OIDC_ALLOWED_ALGORITHMS", "RS256"),
      ),
      clientId: readString(
        injectedOidc.clientId,
        env("VITE_OIDC_CLIENT_ID", "qualigence-console"),
        "clientId",
      ),
      redirectUri: readString(
        injectedOidc.redirectUri,
        env("VITE_OIDC_REDIRECT_URI", `${origin}/auth/callback`),
        "redirectUri",
      ),
      scope: readString(
        injectedOidc.scope,
        env("VITE_OIDC_SCOPE", "openid profile email"),
        "scope",
      ),
      tenantClaim: readString(
        injectedOidc.tenantClaim,
        env("VITE_OIDC_TENANT_CLAIM", "https://qualigence.example/tenant"),
        "tenantClaim",
      ),
      rolesClaim: readString(
        injectedOidc.rolesClaim,
        env("VITE_OIDC_ROLES_CLAIM", "https://qualigence.example/roles"),
        "rolesClaim",
      ),
      roleMap: parseRoleMap(injectedOidc.roleMap),
      allowedTenants: parseStringList(
        injectedOidc.allowedTenants ?? env("VITE_OIDC_ALLOWED_TENANTS", "tenant-a,tenant-b"),
        "allowedTenants",
      ),
    },
  };

  validateRuntimeConfig(config, origin);
  return config;
}

function validateRuntimeConfig(config: ConsoleRuntimeConfig, consoleOrigin: string): void {
  const api = parseUrl(config.apiBaseUrl, "apiBaseUrl", ["https:", "http:"]);
  if (api.protocol === "http:" && !isLoopback(api.hostname)) {
    throw new Error("apiBaseUrl permits HTTP only on loopback");
  }
  parseUrl(config.oidc.issuer, "issuer", ["https:"]);
  parseUrl(config.oidc.authorizationEndpoint, "authorizationEndpoint", ["https:"]);
  parseUrl(config.oidc.tokenEndpoint, "tokenEndpoint", ["https:"]);
  parseUrl(config.oidc.jwksUri, "jwksUri", ["https:"]);
  const redirect = parseUrl(config.oidc.redirectUri, "redirectUri", ["https:", "http:"]);
  if (redirect.protocol === "http:" && !isLoopback(redirect.hostname)) {
    throw new Error("redirectUri permits HTTP only on loopback");
  }
  if (redirect.origin !== consoleOrigin) {
    throw new Error("redirectUri must use the Console origin");
  }
}

function parseAuthMode(value: unknown): ConsoleRuntimeConfig["authMode"] {
  if (value !== "oidc" && value !== "bootstrap") {
    throw new Error("authMode must be oidc or bootstrap");
  }
  return value;
}

function parseAlgorithms(value: unknown): readonly IdTokenAlgorithm[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map((entry) => entry.trim()).filter(Boolean)
      : [];
  if (
    values.length === 0 ||
    !values.every((entry): entry is IdTokenAlgorithm => entry === "RS256" || entry === "ES256")
  ) {
    throw new Error("allowedAlgorithms must contain only RS256 or ES256");
  }
  return [...new Set(values)];
}

function parseRoleMap(value: unknown): Readonly<Record<string, PublicApiRole>> {
  const defaults: Readonly<Record<string, PublicApiRole>> = {
    "qa-admin": "admin",
    "qa-tester": "tester",
    "qa-reviewer": "reviewer",
    "qa-viewer": "viewer",
  };
  if (value === undefined) {
    return defaults;
  }
  const record = optionalRecord(value, "roleMap");
  const result: Record<string, PublicApiRole> = {};
  for (const [key, role] of Object.entries(record)) {
    if (
      key.length === 0 ||
      (role !== "admin" && role !== "tester" && role !== "reviewer" && role !== "viewer")
    ) {
      throw new Error("roleMap contains an unsupported role");
    }
    result[key] = role;
  }
  if (Object.keys(result).length === 0) {
    throw new Error("roleMap must not be empty");
  }
  return result;
}

function parseStringList(value: unknown, name: string): readonly string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const normalized = values.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
  if (normalized.length === 0 || normalized.length !== values.length) {
    throw new Error(`${name} must contain non-empty strings`);
  }
  return [...new Set(normalized)];
}

function readString(value: unknown, fallback: string, name: string): string {
  const selected = value ?? fallback;
  if (typeof selected !== "string" || selected.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return selected.trim();
}

function parseUrl(value: string, name: string, protocols: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (!protocols.includes(parsed.protocol) || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${name} must use an approved scheme without credentials`);
  }
  return parsed;
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
