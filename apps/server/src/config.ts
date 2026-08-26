import { readFileSync } from "node:fs";
import type { PostgresConnectionConfig } from "@qualigence/postgres-runtime";
import type { ClaimMapperConfig, OidcAlgorithm } from "@qualigence/oidc";

export type ServerOidcJwksConfig =
  | { readonly kind: "static"; readonly jwksJson: string }
  | {
      readonly kind: "remote";
      readonly jwksUri: string;
      readonly timeoutMs: number;
      readonly cacheTtlMs: number;
      readonly rotationCooldownMs: number;
    };

/** Resolved runtime configuration for the Public API Server. */
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly postgres: PostgresConnectionConfig;
  readonly runnerGrpc?: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly tlsCertificatePem: Buffer;
    readonly tlsPrivateKeyPem: Buffer;
  };
  readonly missionDispatch?: {
    readonly enabled: boolean;
    readonly tenantIds: readonly string[];
    readonly batchSize: number;
    readonly intervalMs: number;
    readonly initialBackoffMs: number;
    readonly maximumBackoffMs: number;
  };
  readonly intelligenceResultConsumer: {
    readonly enabled: boolean;
    readonly consumerId: string;
    readonly tenantBatchSize: number;
    readonly resultBatchSize: number;
    readonly leaseDurationMs: number;
    readonly idleBackoffMs: number;
    readonly errorBackoffMs: number;
    readonly maximumBackoffMs: number;
  };
  readonly oidc: {
    readonly issuer: string;
    readonly audience: string;
    readonly allowedAlgorithms: readonly OidcAlgorithm[];
    readonly jwks?: ServerOidcJwksConfig;
    /** Backward-compatible static JWKS fixture path for direct test composition; runtime config writes `jwks`. */
    readonly jwksJson?: string;
    readonly claimMapper: ClaimMapperConfig;
  };
  readonly runnerCa: {
    readonly certificatePem: string;
    readonly privateKeyPem: string;
  };
  readonly artifactDataDir: string;
  readonly artifactS3?: {
    readonly region: string;
    readonly endpoint?: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  };
  readonly evidenceKms?: {
    readonly rootKey: Uint8Array;
  };
  readonly objectStorageReadinessUrl?: string;
  readonly skillSigningDataDir?: string;
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

function fromFileOrValue(name: string, env: NodeJS.ProcessEnv): string {
  const filePath = env[`${name}_FILE`];
  if (filePath !== undefined && filePath.length > 0) {
    return readFileSync(filePath, "utf8").trim();
  }
  return required(name, env);
}

function optionalFromFileOrValue(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath !== undefined && filePath.length > 0) {
    return readFileSync(filePath, "utf8").trim();
  }
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function optionalFileContents(name: string, env: NodeJS.ProcessEnv): Buffer | undefined {
  const path = env[name];
  return path === undefined || path.length === 0 ? undefined : readFileSync(path);
}

function positiveInteger(raw: string, name: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`${name} exceeds its maximum.`);
  return value;
}

function nonNegativeInteger(raw: string, name: string, maximum: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} must be a non-negative integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`${name} exceeds its maximum.`);
  return value;
}

function parseAlgorithms(raw: string): readonly OidcAlgorithm[] {
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || !values.every((value): value is OidcAlgorithm => value === "RS256" || value === "ES256")) {
    throw new Error("SERVER_OIDC_ALGORITHMS must contain only RS256 or ES256.");
  }
  return [...new Set(values)];
}

function validateHttpUrl(raw: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${name} must use HTTP(S) without credentials.`);
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw new Error(`${name} permits HTTP only on loopback.`);
  }
  return parsed.toString();
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function tenantList(raw: string | undefined, fallback: readonly string[]): readonly string[] {
  const values = (raw === undefined ? fallback : raw.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) throw new Error("At least one Server tenant id must be configured for dispatch readiness.");
  return [...new Set(values)];
}

function oidcJwksConfig(env: NodeJS.ProcessEnv): ServerOidcJwksConfig {
  const jwksUri = optionalFromFileOrValue("SERVER_OIDC_JWKS_URI", env);
  const jwksFile = env.SERVER_OIDC_JWKS_FILE;
  if (jwksUri !== undefined) {
    return {
      kind: "remote",
      jwksUri: validateHttpUrl(jwksUri, "SERVER_OIDC_JWKS_URI"),
      timeoutMs: positiveInteger(env.SERVER_OIDC_JWKS_TIMEOUT_MS ?? "5000", "SERVER_OIDC_JWKS_TIMEOUT_MS", 60_000),
      cacheTtlMs: positiveInteger(env.SERVER_OIDC_JWKS_CACHE_TTL_MS ?? "600000", "SERVER_OIDC_JWKS_CACHE_TTL_MS", 24 * 60 * 60 * 1000),
      rotationCooldownMs: nonNegativeInteger(env.SERVER_OIDC_JWKS_ROTATION_COOLDOWN_MS ?? "30000", "SERVER_OIDC_JWKS_ROTATION_COOLDOWN_MS", 60_000),
    };
  }
  if (jwksFile !== undefined && jwksFile.length > 0) {
    if (env.SERVER_OIDC_ALLOW_STATIC_JWKS_NON_PRODUCTION !== "true") {
      throw new Error(
        "SERVER_OIDC_JWKS_URI is required for production self-hosted deployments; static JWKS requires SERVER_OIDC_ALLOW_STATIC_JWKS_NON_PRODUCTION=true.",
      );
    }
    return { kind: "static", jwksJson: fileContents("SERVER_OIDC_JWKS_FILE", env) };
  }
  throw new Error("SERVER_OIDC_JWKS_URI is required for production self-hosted deployments.");
}

function optionalRootKey(env: NodeJS.ProcessEnv): Uint8Array | undefined {
  const encoded = optionalFromFileOrValue("SERVER_KMS_ROOT_KEY_BASE64", env);
  if (encoded === undefined) return undefined;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== 32) {
    throw new Error("SERVER_KMS_ROOT_KEY_BASE64 must decode to exactly 32 bytes.");
  }
  return new Uint8Array(decoded);
}

/**
 * Read the Server configuration from the environment. The OIDC issuer/audience,
 * JWKS, allowed algorithms and tenant/role claim allowlists are pinned by
 * configuration so a forged or unmapped token fails closed.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const claimMapper = JSON.parse(fileContents("SERVER_OIDC_CLAIM_MAP_FILE", env)) as ClaimMapperConfig;
  const allowedAlgorithms = parseAlgorithms(env.SERVER_OIDC_ALGORITHMS ?? "RS256");
  const jwks = oidcJwksConfig(env);
  const runnerGrpcEnabled = env.SERVER_RUNNER_GRPC_ENABLED !== "false";
  const kmsRootKey = optionalRootKey(env);
  const runnerGrpcCert = runnerGrpcEnabled ? optionalFileContents("SERVER_RUNNER_GRPC_TLS_CERT_FILE", env) : undefined;
  const runnerGrpcKey = runnerGrpcEnabled ? optionalFileContents("SERVER_RUNNER_GRPC_TLS_KEY_FILE", env) : undefined;
  if (runnerGrpcEnabled && (runnerGrpcCert === undefined || runnerGrpcKey === undefined)) {
    throw new Error("SERVER_RUNNER_GRPC_TLS_CERT_FILE and SERVER_RUNNER_GRPC_TLS_KEY_FILE are required when Runner gRPC is enabled.");
  }
  return {
    host: env.SERVER_HOST ?? "0.0.0.0",
    port: positiveInteger(env.SERVER_PORT ?? "8080", "SERVER_PORT", 65_535),
    postgres: {
      host: required("SERVER_PG_HOST", env),
      port: positiveInteger(env.SERVER_PG_PORT ?? "5432", "SERVER_PG_PORT", 65_535),
      database: required("SERVER_PG_DATABASE", env),
      user: required("SERVER_PG_USER", env),
      password: env.SERVER_PG_PASSWORD_FILE
        ? readFileSync(env.SERVER_PG_PASSWORD_FILE, "utf8").trim()
        : required("SERVER_PG_PASSWORD", env),
    },
    runnerGrpc: {
      enabled: runnerGrpcEnabled,
      host: env.SERVER_RUNNER_GRPC_HOST ?? "0.0.0.0",
      port: positiveInteger(env.SERVER_RUNNER_GRPC_PORT ?? "50555", "SERVER_RUNNER_GRPC_PORT", 65_535),
      tlsCertificatePem: runnerGrpcCert ?? Buffer.alloc(0),
      tlsPrivateKeyPem: runnerGrpcKey ?? Buffer.alloc(0),
    },
    missionDispatch: {
      enabled: env.SERVER_MISSION_DISPATCH_ENABLED !== "false",
      tenantIds: tenantList(env.SERVER_TENANT_IDS, claimMapper.allowedTenants),
      batchSize: positiveInteger(env.SERVER_MISSION_DISPATCH_BATCH_SIZE ?? "32", "SERVER_MISSION_DISPATCH_BATCH_SIZE", 256),
      intervalMs: positiveInteger(env.SERVER_MISSION_DISPATCH_INTERVAL_MS ?? "1000", "SERVER_MISSION_DISPATCH_INTERVAL_MS", 60_000),
      initialBackoffMs: positiveInteger(env.SERVER_MISSION_DISPATCH_INITIAL_BACKOFF_MS ?? "250", "SERVER_MISSION_DISPATCH_INITIAL_BACKOFF_MS", 60_000),
      maximumBackoffMs: positiveInteger(env.SERVER_MISSION_DISPATCH_MAXIMUM_BACKOFF_MS ?? "30000", "SERVER_MISSION_DISPATCH_MAXIMUM_BACKOFF_MS", 300_000),
    },
    intelligenceResultConsumer: {
      enabled: env.SERVER_INTELLIGENCE_RESULT_CONSUMER_ENABLED !== "false",
      consumerId: env.SERVER_INTELLIGENCE_RESULT_CONSUMER_ID ?? `server-${process.pid}`,
      tenantBatchSize: positiveInteger(env.SERVER_INTELLIGENCE_RESULT_TENANT_BATCH_SIZE ?? "16", "SERVER_INTELLIGENCE_RESULT_TENANT_BATCH_SIZE", 256),
      resultBatchSize: positiveInteger(env.SERVER_INTELLIGENCE_RESULT_BATCH_SIZE ?? "32", "SERVER_INTELLIGENCE_RESULT_BATCH_SIZE", 256),
      leaseDurationMs: positiveInteger(env.SERVER_INTELLIGENCE_RESULT_LEASE_MS ?? "30000", "SERVER_INTELLIGENCE_RESULT_LEASE_MS", 300_000),
      idleBackoffMs: positiveInteger(env.SERVER_INTELLIGENCE_RESULT_IDLE_BACKOFF_MS ?? "1000", "SERVER_INTELLIGENCE_RESULT_IDLE_BACKOFF_MS", 60_000),
      errorBackoffMs: positiveInteger(env.SERVER_INTELLIGENCE_RESULT_ERROR_BACKOFF_MS ?? "1000", "SERVER_INTELLIGENCE_RESULT_ERROR_BACKOFF_MS", 60_000),
      maximumBackoffMs: positiveInteger(env.SERVER_INTELLIGENCE_RESULT_MAXIMUM_BACKOFF_MS ?? "30000", "SERVER_INTELLIGENCE_RESULT_MAXIMUM_BACKOFF_MS", 300_000),
    },
    oidc: {
      issuer: required("SERVER_OIDC_ISSUER", env),
      audience: required("SERVER_OIDC_AUDIENCE", env),
      allowedAlgorithms,
      jwks,
      claimMapper,
    },
    runnerCa: {
      certificatePem: fileContents("SERVER_RUNNER_CA_CERT_FILE", env),
      privateKeyPem: fileContents("SERVER_RUNNER_CA_KEY_FILE", env),
    },
    artifactDataDir: env.SERVER_ARTIFACT_DATA_DIR ?? ".qualigence-server/artifacts",
    ...(env.SERVER_S3_BUCKET === undefined
      ? {}
      : {
          artifactS3: {
            region: env.SERVER_S3_REGION ?? "us-east-1",
            ...(env.SERVER_S3_ENDPOINT === undefined ? {} : { endpoint: env.SERVER_S3_ENDPOINT }),
            bucket: env.SERVER_S3_BUCKET,
            accessKeyId: fromFileOrValue("SERVER_S3_ACCESS_KEY_ID", env),
            secretAccessKey: fromFileOrValue("SERVER_S3_SECRET_ACCESS_KEY", env),
            forcePathStyle: env.SERVER_S3_FORCE_PATH_STYLE !== "false",
          },
        }),
    ...(kmsRootKey === undefined ? {} : { evidenceKms: { rootKey: kmsRootKey } }),
    ...(env.SERVER_OBJECT_STORAGE_READY_URL === undefined
      ? {}
      : { objectStorageReadinessUrl: env.SERVER_OBJECT_STORAGE_READY_URL }),
    ...(env.SERVER_SKILL_SIGNING_DATA_DIR === undefined
      ? {}
      : { skillSigningDataDir: env.SERVER_SKILL_SIGNING_DATA_DIR }),
  };
}
