import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
  LocalConfig,
  ResolvedSecret,
  SecretProvider,
  VisualInputMode,
} from "@qualigence/local-control";

export type { LocalConfig, ResolvedSecret, SecretProvider, VisualInputMode };

/** Ordered configuration sources, lowest precedence first. */
export interface ConfigSources {
  /** Parsed YAML configuration object (already deserialized). */
  readonly yaml?: unknown;
  /** Process environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Parsed non-secret CLI flags (camelCase keys). */
  readonly cli?: Readonly<Record<string, unknown>>;
}

export type LocalConfigErrorCode = "SecretInConfiguration" | "InvalidConfiguration";

export class LocalConfigError extends Error {
  readonly code: LocalConfigErrorCode;

  constructor(code: LocalConfigErrorCode, message: string) {
    super(message);
    this.name = "LocalConfigError";
    this.code = code;
  }
}

const DEFAULTS = {
  dataDir: "./.qualigence-local",
  core: { host: "127.0.0.1", port: 50_555, httpPort: 50_556 },
  runner: { spoolSoftBytes: 64 * 1024 * 1024, spoolHardBytes: 128 * 1024 * 1024 },
  modelProfile: { provider: "openai-compatible", visualInput: "disabled" as VisualInputMode },
  auth: { bootstrapTtlMs: 600_000, userSessionTtlMs: 900_000 },
  completionReconciliationRetryBaseMs: 1_000,
  completionReconciliationRetryMaximumMs: 60_000,
  completionReconciliationMaximumAttempts: 8,
  completionReconciliationPollIntervalMs: 250,
  completionReconciliationBatchSize: 64,
  shutdown: { stopRequestPollIntervalMs: 250, stopRequestMaximumAgeMs: 30_000, stopRequestWaitTimeoutMs: 60_000, drainTimeoutMs: 30_000 },
} as const;

/**
 * Keys that must never appear in a configuration file or CLI flag because they
 * would embed a secret in plaintext. Compared after normalising away case and
 * separators, so `apiKey`, `api_key` and `API-KEY` are all rejected while the
 * non-secret `credentialRef` reference is allowed.
 */
const FORBIDDEN_SECRET_KEYS: ReadonlySet<string> = new Set([
  "apikey",
  "secret",
  "secretkey",
  "password",
  "passphrase",
  "privatekey",
  "accesskey",
  "token",
  "credential",
  "credentials",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoSecretKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEYS.has(normalizeKey(key))) {
      throw new LocalConfigError(
        "SecretInConfiguration",
        `Secret-bearing key "${path === "" ? key : `${path}.${key}`}" is not allowed in configuration; use credentialRef and a SecretProvider instead.`,
      );
    }
    assertNoSecretKeys(child, path === "" ? key : `${path}.${key}`);
  }
}

/**
 * Parse a YAML configuration document and reject any inline secret. Returns the
 * plain object for merging via {@link loadLocalConfig}.
 */
export function loadYaml(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = parseYaml(text) as unknown;
  } catch (cause) {
    throw new LocalConfigError(
      "InvalidConfiguration",
      `Configuration YAML could not be parsed: ${String((cause as Error).message ?? cause)}`,
    );
  }
  assertNoSecretKeys(parsed ?? {}, "");
  return parsed;
}

/**
 * Replace every secret-bearing value with `[redacted]`, recursively, so a
 * configuration or diagnostic object can be safely logged. Reference fields such
 * as `credentialRef` are preserved because they carry no secret material.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (typeof value === "string") {
    return looksLikeSecretValue(value) ? "[redacted]" : value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = FORBIDDEN_SECRET_KEYS.has(normalizeKey(key))
      ? "[redacted]"
      : redactSecrets(child);
  }
  return output;
}

/**
 * Detect a string that carries secret material by shape (a PEM private-key
 * block), so embedded key bytes are redacted even under a benign key name.
 */
function looksLikeSecretValue(value: string): boolean {
  return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(value);
}

type MutableConfig = {
  dataDir?: unknown;
  core?: { host?: unknown; port?: unknown; httpPort?: unknown };
  runner?: { id?: unknown; spoolSoftBytes?: unknown; spoolHardBytes?: unknown };
  modelProfile?: {
    provider?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    credentialRef?: unknown;
    visualInput?: unknown;
  };
  auth?: { bootstrapTtlMs?: unknown; userSessionTtlMs?: unknown };
  completionReconciliationRetryBaseMs?: unknown;
  completionReconciliationRetryMaximumMs?: unknown;
  completionReconciliationMaximumAttempts?: unknown;
  completionReconciliationPollIntervalMs?: unknown;
  completionReconciliationBatchSize?: unknown;
  shutdown?: { stopRequestPollIntervalMs?: unknown; stopRequestMaximumAgeMs?: unknown; stopRequestWaitTimeoutMs?: unknown; drainTimeoutMs?: unknown };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function envPartial(env: NodeJS.ProcessEnv): MutableConfig {
  const partial: MutableConfig = {};
  const set = (path: () => void, raw: string | undefined): void => {
    if (raw !== undefined && raw.length > 0) {
      path();
    }
  };
  if (env.QUALIGENCE_DATA_DIR) partial.dataDir = env.QUALIGENCE_DATA_DIR;
  set(
    () => ((partial.core ??= {}).port = env.QUALIGENCE_CORE_PORT),
    env.QUALIGENCE_CORE_PORT,
  );
  set(() => ((partial.core ??= {}).httpPort = env.QUALIGENCE_CORE_HTTP_PORT), env.QUALIGENCE_CORE_HTTP_PORT);
  if (env.QUALIGENCE_RUNNER_ID) (partial.runner ??= {}).id = env.QUALIGENCE_RUNNER_ID;
  if (env.QUALIGENCE_SPOOL_SOFT_BYTES)
    (partial.runner ??= {}).spoolSoftBytes = env.QUALIGENCE_SPOOL_SOFT_BYTES;
  if (env.QUALIGENCE_SPOOL_HARD_BYTES)
    (partial.runner ??= {}).spoolHardBytes = env.QUALIGENCE_SPOOL_HARD_BYTES;
  if (env.QUALIGENCE_MODEL_PROVIDER)
    (partial.modelProfile ??= {}).provider = env.QUALIGENCE_MODEL_PROVIDER;
  if (env.QUALIGENCE_MODEL_BASE_URL)
    (partial.modelProfile ??= {}).baseUrl = env.QUALIGENCE_MODEL_BASE_URL;
  if (env.QUALIGENCE_MODEL) (partial.modelProfile ??= {}).model = env.QUALIGENCE_MODEL;
  if (env.QUALIGENCE_CREDENTIAL_REF)
    (partial.modelProfile ??= {}).credentialRef = env.QUALIGENCE_CREDENTIAL_REF;
  if (env.QUALIGENCE_VISUAL_INPUT)
    (partial.modelProfile ??= {}).visualInput = env.QUALIGENCE_VISUAL_INPUT;
  return partial;
}

const CLI_KEY_TO_PATH: Readonly<Record<string, readonly string[]>> = {
  dataDir: ["dataDir"],
  corePort: ["core", "port"],
  coreHttpPort: ["core", "httpPort"],
  runnerId: ["runner", "id"],
  spoolSoftBytes: ["runner", "spoolSoftBytes"],
  spoolHardBytes: ["runner", "spoolHardBytes"],
  provider: ["modelProfile", "provider"],
  baseUrl: ["modelProfile", "baseUrl"],
  model: ["modelProfile", "model"],
  credentialRef: ["modelProfile", "credentialRef"],
  visualInput: ["modelProfile", "visualInput"],
};

function cliPartial(cli: Readonly<Record<string, unknown>>): MutableConfig {
  assertNoSecretKeys(cli, "");
  const partial: MutableConfig = {};
  for (const [key, value] of Object.entries(cli)) {
    if (value === undefined) continue;
    const path = CLI_KEY_TO_PATH[key];
    if (path === undefined) continue;
    let cursor = partial as Record<string, unknown>;
    for (let index = 0; index < path.length - 1; index += 1) {
      const segment = path[index] as string;
      cursor[segment] ??= {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[path[path.length - 1] as string] = value;
  }
  return partial;
}

function mergeInto(target: Record<string, unknown>, source: unknown): void {
  if (!isPlainObject(source)) {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (isPlainObject(value)) {
      const existing = isPlainObject(target[key]) ? (target[key] as Record<string, unknown>) : {};
      target[key] = existing;
      mergeInto(existing, value);
    } else {
      target[key] = value;
    }
  }
}

function mergeConfigSources(input: ConfigSources): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  mergeInto(merged, structuredClone(DEFAULTS));
  if (input.yaml !== undefined) {
    assertNoSecretKeys(input.yaml, "");
    mergeInto(merged, input.yaml);
  }
  mergeInto(merged, envPartial(input.env ?? {}));
  mergeInto(merged, cliPartial(input.cli ?? {}));
  // Local mode always binds Core to loopback regardless of any source.
  (merged.core as Record<string, unknown>).host = "127.0.0.1";
  return merged;
}

const numeric = z.coerce.number().int().nonnegative();

const localConfigSchema = z
  .object({
    dataDir: z.string().min(1),
    core: z
      .object({
        host: z.literal("127.0.0.1"),
        port: z.coerce.number().int().min(1).max(65_535),
        httpPort: z.coerce.number().int().min(1).max(65_535),
      })
      .strict(),
    runner: z
      .object({
        id: z.string().min(1),
        spoolSoftBytes: numeric,
        spoolHardBytes: numeric,
      })
      .strict()
      .refine((runner) => runner.spoolSoftBytes < runner.spoolHardBytes, {
        message: "spoolSoftBytes must be strictly less than spoolHardBytes",
        path: ["spoolSoftBytes"],
      }),
    modelProfile: z
      .object({
        provider: z.literal("openai-compatible"),
        baseUrl: z.string().url(),
        model: z.string().min(1),
        credentialRef: z.string().min(1),
        visualInput: z.enum(["disabled", "on-demand"]),
      })
      .strict(),
    auth: z.object({ bootstrapTtlMs: z.coerce.number().int().positive().max(86_400_000), userSessionTtlMs: z.coerce.number().int().positive().max(86_400_000) }).strict(),
    completionReconciliationRetryBaseMs: z.coerce.number().int().positive().max(60_000),
    completionReconciliationRetryMaximumMs: z.coerce.number().int().positive().max(300_000),
    completionReconciliationMaximumAttempts: z.coerce.number().int().positive().max(64),
    completionReconciliationPollIntervalMs: z.coerce.number().int().positive().max(60_000),
    completionReconciliationBatchSize: z.coerce.number().int().positive().max(256),
    shutdown: z.object({ stopRequestPollIntervalMs: z.coerce.number().int().positive().max(5_000), stopRequestMaximumAgeMs: z.coerce.number().int().positive().max(300_000), stopRequestWaitTimeoutMs: z.coerce.number().int().positive().max(600_000), drainTimeoutMs: z.coerce.number().int().positive().max(300_000) }).strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.completionReconciliationPollIntervalMs > config.completionReconciliationRetryBaseMs || config.completionReconciliationRetryBaseMs > config.completionReconciliationRetryMaximumMs) context.addIssue({ code: "custom", message: "completion reconciliation timing relationship is invalid", path: ["completionReconciliationPollIntervalMs"] });
    const minimumWait = config.shutdown.drainTimeoutMs + 2 * 5_000 + 2 * 3_000;
    if (config.shutdown.stopRequestPollIntervalMs > config.shutdown.stopRequestMaximumAgeMs || config.shutdown.stopRequestMaximumAgeMs > config.shutdown.stopRequestWaitTimeoutMs || config.shutdown.stopRequestWaitTimeoutMs < minimumWait) context.addIssue({ code: "custom", message: "shutdown timing relationship is invalid", path: ["shutdown"] });
  });

/**
 * Merge configuration sources by precedence (safe defaults < YAML < environment
 * < non-secret CLI flags), forbid inline secrets, and validate the result into a
 * frozen {@link LocalConfig}. `dataDir` is canonicalised to an absolute path.
 */
export function loadLocalConfig(input: ConfigSources): LocalConfig {
  const merged = mergeConfigSources(input);
  const result = localConfigSchema.safeParse(merged);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.join(".") ?? "";
    throw new LocalConfigError(
      "InvalidConfiguration",
      `Invalid local configuration${location === "" ? "" : ` at ${location}`}: ${issue?.message ?? "unknown error"}`,
    );
  }
  const parsed = result.data;
  return {
    dataDir: resolve(parsed.dataDir),
    core: { host: "127.0.0.1", port: parsed.core.port, httpPort: parsed.core.httpPort },
    runner: {
      id: parsed.runner.id,
      spoolSoftBytes: parsed.runner.spoolSoftBytes,
      spoolHardBytes: parsed.runner.spoolHardBytes,
    },
    modelProfile: {
      provider: "openai-compatible",
      baseUrl: parsed.modelProfile.baseUrl,
      model: parsed.modelProfile.model,
      credentialRef: parsed.modelProfile.credentialRef,
      visualInput: parsed.modelProfile.visualInput,
    },
    auth: parsed.auth,
    completionReconciliationRetryBaseMs: parsed.completionReconciliationRetryBaseMs,
    completionReconciliationRetryMaximumMs: parsed.completionReconciliationRetryMaximumMs,
    completionReconciliationMaximumAttempts: parsed.completionReconciliationMaximumAttempts,
    completionReconciliationPollIntervalMs: parsed.completionReconciliationPollIntervalMs,
    completionReconciliationBatchSize: parsed.completionReconciliationBatchSize,
    shutdown: parsed.shutdown,
  };
}

export const LOCAL_SHUTDOWN_GRACE_MS = 5_000;
export const LOCAL_REAP_TIMEOUT_MS = 3_000;
