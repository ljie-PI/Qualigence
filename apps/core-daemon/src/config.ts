import { readFileSync } from "node:fs";

/** Resolved runtime configuration for the standalone Core Daemon process. */
export interface CoreDaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly httpPort?: number;
  readonly tls: {
    readonly ca: Buffer;
    readonly cert: Buffer;
    readonly key: Buffer;
  };
  readonly dataDir: string;
  readonly deploymentMode?: "local" | "self_hosted";
  readonly leaseDurationMs: number;
  readonly legacyM1LocalRecoveryCandidate?: unknown;
  readonly configuredRunnerId?: string;
  readonly userSessionTtlMs?: number;
  readonly completionReconciliationRetryBaseMs?: number;
  readonly completionReconciliationRetryMaximumMs?: number;
  readonly completionReconciliationMaximumAttempts?: number;
  readonly completionReconciliationPollIntervalMs?: number;
  readonly completionReconciliationBatchSize?: number;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/**
 * Read the Core Daemon configuration from the environment. TLS material is loaded
 * eagerly so a misconfigured certificate path fails fast at startup rather than
 * on the first Runner handshake.
 */
export function loadCoreDaemonConfig(env: NodeJS.ProcessEnv = process.env): CoreDaemonConfig {
  const recoveryManifest = env.CORE_LEGACY_M1_LOCAL_RECOVERY_MANIFEST;
  const deploymentMode = env.CORE_DEPLOYMENT_MODE;
  if (deploymentMode !== "local" && deploymentMode !== "self_hosted") {
    throw new Error("CORE_DEPLOYMENT_MODE must be exactly local or self_hosted.");
  }
  if (deploymentMode === "local" && (env.CORE_HOST ?? "127.0.0.1") !== "127.0.0.1") throw new Error("Local Core host must be exactly 127.0.0.1.");
  const config: CoreDaemonConfig = {
    host: env.CORE_HOST ?? "127.0.0.1",
    port: Number.parseInt(env.CORE_PORT ?? "50555", 10),
    ...(env.CORE_HTTP_PORT === undefined ? {} : { httpPort: positiveInteger(env.CORE_HTTP_PORT, "CORE_HTTP_PORT", 65_535) }),
    tls: {
      ca: readFileSync(required("CORE_TLS_CA", env)),
      cert: readFileSync(required("CORE_TLS_CERT", env)),
      key: readFileSync(required("CORE_TLS_KEY", env)),
    },
    dataDir: env.CORE_DATA_DIR ?? "./.qualigence-core",
    deploymentMode,
    leaseDurationMs: Number.parseInt(env.CORE_LEASE_DURATION_MS ?? "30000", 10),
    ...(env.CORE_CONFIGURED_RUNNER_ID === undefined ? {} : { configuredRunnerId: required("CORE_CONFIGURED_RUNNER_ID", env) }),
    userSessionTtlMs: positiveInteger(env.CORE_USER_SESSION_TTL_MS ?? "900000", "CORE_USER_SESSION_TTL_MS", 86_400_000),
    completionReconciliationRetryBaseMs: positiveInteger(env.CORE_COMPLETION_RETRY_BASE_MS ?? "1000", "CORE_COMPLETION_RETRY_BASE_MS", 60_000),
    completionReconciliationRetryMaximumMs: positiveInteger(env.CORE_COMPLETION_RETRY_MAXIMUM_MS ?? "60000", "CORE_COMPLETION_RETRY_MAXIMUM_MS", 300_000),
    completionReconciliationMaximumAttempts: positiveInteger(env.CORE_COMPLETION_MAXIMUM_ATTEMPTS ?? "8", "CORE_COMPLETION_MAXIMUM_ATTEMPTS", 64),
    completionReconciliationPollIntervalMs: positiveInteger(env.CORE_COMPLETION_POLL_INTERVAL_MS ?? "250", "CORE_COMPLETION_POLL_INTERVAL_MS", 60_000),
    completionReconciliationBatchSize: positiveInteger(env.CORE_COMPLETION_BATCH_SIZE ?? "64", "CORE_COMPLETION_BATCH_SIZE", 256),
    ...(recoveryManifest === undefined ? {} : { legacyM1LocalRecoveryCandidate: JSON.parse(readFileSync(recoveryManifest, "utf8")) }),
  };
  const poll = config.completionReconciliationPollIntervalMs ?? 250;
  const base = config.completionReconciliationRetryBaseMs ?? 1_000;
  const maximum = config.completionReconciliationRetryMaximumMs ?? 60_000;
  if (poll > base || base > maximum) throw new Error("Completion reconciliation timing relationship is invalid.");
  return config;
}

function positiveInteger(raw: string, name: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer.`);
  const value = Number(raw); if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`${name} exceeds its maximum.`);
  return value;
}
