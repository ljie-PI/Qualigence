import { readFileSync } from "node:fs";

/** Resolved runtime configuration for the standalone Runner process. */
export interface RunnerConfig {
  readonly runnerId: string;
  readonly coreAddress: string;
  readonly authority: string;
  readonly tls: {
    readonly ca: Buffer;
    readonly cert: Buffer;
    readonly key: Buffer;
  };
  readonly dataDir: string;
  readonly model: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly modelName: string;
  };
  readonly headed: boolean;
  readonly navigationTimeoutMs: number;
  readonly actionTimeoutMs: number;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/**
 * Read the Runner configuration from the environment. TLS material is loaded
 * eagerly so a misconfigured certificate path fails fast at startup rather than
 * on the first Core handshake.
 */
export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return {
    runnerId: required("RUNNER_ID", env),
    coreAddress: env.CORE_ADDRESS ?? "127.0.0.1:50555",
    authority: env.CORE_AUTHORITY ?? "localhost",
    tls: {
      ca: readFileSync(required("RUNNER_TLS_CA", env)),
      cert: readFileSync(required("RUNNER_TLS_CERT", env)),
      key: readFileSync(required("RUNNER_TLS_KEY", env)),
    },
    dataDir: env.RUNNER_DATA_DIR ?? "./.qualigence-runner",
    model: {
      baseUrl: required("RUNNER_MODEL_BASE_URL", env),
      apiKey: required("RUNNER_MODEL_API_KEY", env),
      modelName: required("RUNNER_MODEL_NAME", env),
    },
    headed: env.RUNNER_HEADED === "true",
    navigationTimeoutMs: Number.parseInt(env.RUNNER_NAVIGATION_TIMEOUT_MS ?? "30000", 10),
    actionTimeoutMs: Number.parseInt(env.RUNNER_ACTION_TIMEOUT_MS ?? "15000", 10),
  };
}
