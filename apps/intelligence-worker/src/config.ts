import { readFileSync } from "node:fs";

/** Resolved runtime configuration for the standalone Intelligence Worker. */
export interface IntelligenceWorkerConfig {
  readonly workerId: string;
  readonly postgres: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
  };
  readonly artifacts: {
    readonly region: string;
    readonly endpoint?: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  };
  readonly model: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly modelName: string;
  };
  readonly leaseDurationMs: number;
  readonly idleBackoffMs: number;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function fromFileOrValue(name: string, env: NodeJS.ProcessEnv): string {
  const fileVar = `${name}_FILE`;
  const filePath = env[fileVar];
  if (filePath !== undefined && filePath.length > 0) {
    return readFileSync(filePath, "utf8").trim();
  }
  return required(name, env);
}

/**
 * Read the Worker configuration from the environment. The Worker connects to
 * PostgreSQL as its dedicated least-privilege role, so a misconfigured role or
 * secret fails fast at startup rather than mid-lease.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): IntelligenceWorkerConfig {
  return {
    workerId: env.WORKER_ID ?? `worker-${process.pid}`,
    postgres: {
      host: required("WORKER_PG_HOST", env),
      port: Number.parseInt(env.WORKER_PG_PORT ?? "5432", 10),
      database: required("WORKER_PG_DATABASE", env),
      user: required("WORKER_PG_USER", env),
      password: fromFileOrValue("WORKER_PG_PASSWORD", env),
    },
    artifacts: {
      region: env.WORKER_S3_REGION ?? "us-east-1",
      ...(env.WORKER_S3_ENDPOINT !== undefined ? { endpoint: env.WORKER_S3_ENDPOINT } : {}),
      bucket: required("WORKER_S3_BUCKET", env),
      accessKeyId: fromFileOrValue("WORKER_S3_ACCESS_KEY_ID", env),
      secretAccessKey: fromFileOrValue("WORKER_S3_SECRET_ACCESS_KEY", env),
      forcePathStyle: env.WORKER_S3_FORCE_PATH_STYLE !== "false",
    },
    model: {
      baseUrl: required("WORKER_MODEL_BASE_URL", env),
      apiKey: fromFileOrValue("WORKER_MODEL_API_KEY", env),
      modelName: required("WORKER_MODEL_NAME", env),
    },
    leaseDurationMs: Number.parseInt(env.WORKER_LEASE_DURATION_MS ?? "60000", 10),
    idleBackoffMs: Number.parseInt(env.WORKER_IDLE_BACKOFF_MS ?? "1000", 10),
  };
}
