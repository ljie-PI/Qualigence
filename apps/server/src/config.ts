import { readFileSync } from "node:fs";
import type { PostgresConnectionConfig } from "@qualigence/postgres-runtime";
import type { ClaimMapperConfig } from "@qualigence/oidc";
import type { OidcAlgorithm } from "@qualigence/oidc";

/** Resolved runtime configuration for the Public API Server. */
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly postgres: PostgresConnectionConfig;
  readonly oidc: {
    readonly issuer: string;
    readonly audience: string;
    readonly allowedAlgorithms: readonly OidcAlgorithm[];
    readonly jwksJson: string;
    readonly claimMapper: ClaimMapperConfig;
  };
  readonly runnerCa: {
    readonly certificatePem: string;
    readonly privateKeyPem: string;
  };
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function fileContents(name: string, env: NodeJS.ProcessEnv): string {
  return readFileSync(required(name, env), "utf8");
}

/**
 * Read the Server configuration from the environment. The OIDC issuer/audience,
 * JWKS, allowed algorithms and tenant/role claim allowlists are pinned by
 * configuration so a forged or unmapped token fails closed.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.SERVER_HOST ?? "0.0.0.0",
    port: Number.parseInt(env.SERVER_PORT ?? "8080", 10),
    postgres: {
      host: required("SERVER_PG_HOST", env),
      port: Number.parseInt(env.SERVER_PG_PORT ?? "5432", 10),
      database: required("SERVER_PG_DATABASE", env),
      user: required("SERVER_PG_USER", env),
      password: env.SERVER_PG_PASSWORD_FILE
        ? readFileSync(env.SERVER_PG_PASSWORD_FILE, "utf8").trim()
        : required("SERVER_PG_PASSWORD", env),
    },
    oidc: {
      issuer: required("SERVER_OIDC_ISSUER", env),
      audience: required("SERVER_OIDC_AUDIENCE", env),
      allowedAlgorithms: (env.SERVER_OIDC_ALGORITHMS ?? "RS256")
        .split(",")
        .map((value) => value.trim()) as OidcAlgorithm[],
      jwksJson: fileContents("SERVER_OIDC_JWKS_FILE", env),
      claimMapper: JSON.parse(fileContents("SERVER_OIDC_CLAIM_MAP_FILE", env)) as ClaimMapperConfig,
    },
    runnerCa: {
      certificatePem: fileContents("SERVER_RUNNER_CA_CERT_FILE", env),
      privateKeyPem: fileContents("SERVER_RUNNER_CA_KEY_FILE", env),
    },
  };
}
