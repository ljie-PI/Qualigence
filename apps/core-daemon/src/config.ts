import { readFileSync } from "node:fs";

/** Resolved runtime configuration for the standalone Core Daemon process. */
export interface CoreDaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: {
    readonly ca: Buffer;
    readonly cert: Buffer;
    readonly key: Buffer;
  };
  readonly dataDir: string;
  readonly leaseDurationMs: number;
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
  return {
    host: env.CORE_HOST ?? "127.0.0.1",
    port: Number.parseInt(env.CORE_PORT ?? "50555", 10),
    tls: {
      ca: readFileSync(required("CORE_TLS_CA", env)),
      cert: readFileSync(required("CORE_TLS_CERT", env)),
      key: readFileSync(required("CORE_TLS_KEY", env)),
    },
    dataDir: env.CORE_DATA_DIR ?? "./.qualigence-core",
    leaseDurationMs: Number.parseInt(env.CORE_LEASE_DURATION_MS ?? "30000", 10),
  };
}
