import { X509Certificate } from "node:crypto";
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
  readonly tenantId?: string;
  readonly model: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly modelName: string;
    readonly maximumTokensPerCall: number;
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
  const runnerId = required("RUNNER_ID", env);
  const cert = readFileSync(required("RUNNER_TLS_CERT", env));
  const tenantId = env.RUNNER_TENANT_ID ?? tenantIdFromCertificate(cert, runnerId);
  return {
    runnerId,
    coreAddress: env.CORE_ADDRESS ?? "127.0.0.1:50555",
    authority: env.CORE_AUTHORITY ?? "localhost",
    tls: {
      ca: readFileSync(required("RUNNER_TLS_CA", env)),
      cert,
      key: readFileSync(required("RUNNER_TLS_KEY", env)),
    },
    ...(tenantId === undefined ? {} : { tenantId }),
    dataDir: env.RUNNER_DATA_DIR ?? "./.qualigence-runner",
    model: {
      baseUrl: required("RUNNER_MODEL_BASE_URL", env),
      apiKey: required("RUNNER_MODEL_API_KEY", env),
      modelName: required("RUNNER_MODEL_NAME", env),
      maximumTokensPerCall: positiveInteger(
        "RUNNER_MODEL_MAXIMUM_TOKENS_PER_CALL",
        required("RUNNER_MODEL_MAXIMUM_TOKENS_PER_CALL", env),
      ),
    },
    headed: env.RUNNER_HEADED === "true",
    navigationTimeoutMs: Number.parseInt(env.RUNNER_NAVIGATION_TIMEOUT_MS ?? "30000", 10),
    actionTimeoutMs: Number.parseInt(env.RUNNER_ACTION_TIMEOUT_MS ?? "15000", 10),
  };
}

function tenantIdFromCertificate(cert: Buffer, runnerId: string): string | undefined {
  const subjectAltName = new X509Certificate(cert).subjectAltName;
  if (subjectAltName === undefined || subjectAltName === "") return undefined;
  for (const entry of subjectAltName.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed.toUpperCase().startsWith("URI:")) continue;
    const uri = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    const match = /^spiffe:\/\/qualigence\.local\/tenants\/([^/]+)\/runners\/([^/]+)$/.exec(uri);
    if (match !== null && match[2] === runnerId) return match[1];
  }
  return undefined;
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}
