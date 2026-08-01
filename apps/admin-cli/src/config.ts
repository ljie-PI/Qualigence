import { readFileSync, statSync } from "node:fs";
import type { PgConnectionInfo } from "./pg-tools.js";
import type { S3Config } from "./s3-ops.js";
import { AdminCliError } from "./errors.js";

/** A least-privilege runtime role name + password. */
export interface RoleCredential {
  readonly name: string;
  readonly password: string;
}

/**
 * The fully-resolved configuration a Self-hosted operator command needs. Every
 * secret is sourced from a file (mounted at `/run/secrets/*` under Compose),
 * never from a plaintext environment variable or an image layer.
 */
export interface SelfHostedAdminConfig {
  readonly postgres: {
    /** Owner/migration role, used offline for migrate/backup/restore only. */
    readonly admin: PgConnectionInfo;
    readonly server: RoleCredential;
    readonly worker: RoleCredential;
  };
  readonly s3: S3Config;
  readonly kms: { readonly rootKey: Uint8Array };
  readonly server: { readonly baseUrl: string };
  /** Directory backups are written to / restored from. */
  readonly backupDir: string;
  readonly productVersion: string;
  /** Secret file paths whose permissions `doctor` verifies. */
  readonly secretFiles: readonly string[];
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new AdminCliError("ConfigInvalid", `missing required environment variable ${name}`);
  }
  return value;
}

/** Read a secret from its file path; the value never appears in the environment. */
export function readSecretFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (cause) {
    throw new AdminCliError("SecretUnreadable", `unable to read secret file ${path}`, {
      cause,
    });
  }
}

function secretFrom(nameFileVar: string, env: NodeJS.ProcessEnv): string {
  return readSecretFile(required(nameFileVar, env));
}

/**
 * Assert a secret file is not group/world readable. Returns the octal mode for a
 * caller (e.g. `doctor`) to report. On platforms without POSIX modes this is a
 * best-effort no-op.
 */
export function assertSecretPermissions(path: string): number {
  const stats = statSync(path);
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new AdminCliError(
      "SecretPermissionsUnsafe",
      `secret file ${path} is group/world accessible (mode ${mode.toString(8)})`,
      { details: { mode: mode.toString(8) } },
    );
  }
  return mode;
}

/**
 * Load the operator configuration from the environment. Secret *values* come
 * only from `*_FILE` paths; the environment holds paths and non-sensitive
 * settings. A missing production dependency (DB, S3, KMS root key, OIDC/Server
 * URL) fails fast here rather than mid-operation.
 */
export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): SelfHostedAdminConfig {
  const pgHost = required("ADMIN_PG_HOST", env);
  const pgPort = Number.parseInt(env.ADMIN_PG_PORT ?? "5432", 10);
  const pgDatabase = required("ADMIN_PG_DATABASE", env);

  const adminPasswordFile = required("ADMIN_PG_PASSWORD_FILE", env);
  const serverPasswordFile = required("ADMIN_SERVER_PG_PASSWORD_FILE", env);
  const workerPasswordFile = required("ADMIN_WORKER_PG_PASSWORD_FILE", env);
  const s3AccessKeyFile = required("ADMIN_S3_ACCESS_KEY_ID_FILE", env);
  const s3SecretKeyFile = required("ADMIN_S3_SECRET_ACCESS_KEY_FILE", env);
  const kmsRootKeyFile = required("ADMIN_KMS_ROOT_KEY_FILE", env);

  const rootKeyRaw = readFileSync(kmsRootKeyFile);
  const rootKey = normalizeRootKey(rootKeyRaw, kmsRootKeyFile);

  return {
    postgres: {
      admin: {
        host: pgHost,
        port: pgPort,
        database: pgDatabase,
        user: required("ADMIN_PG_USER", env),
        password: readSecretFile(adminPasswordFile),
      },
      server: {
        name: required("ADMIN_SERVER_PG_USER", env),
        password: readSecretFile(serverPasswordFile),
      },
      worker: {
        name: required("ADMIN_WORKER_PG_USER", env),
        password: readSecretFile(workerPasswordFile),
      },
    },
    s3: {
      region: env.ADMIN_S3_REGION ?? "us-east-1",
      ...(env.ADMIN_S3_ENDPOINT !== undefined ? { endpoint: env.ADMIN_S3_ENDPOINT } : {}),
      bucket: required("ADMIN_S3_BUCKET", env),
      accessKeyId: readSecretFile(s3AccessKeyFile),
      secretAccessKey: readSecretFile(s3SecretKeyFile),
      forcePathStyle: env.ADMIN_S3_FORCE_PATH_STYLE !== "false",
    },
    kms: { rootKey },
    server: { baseUrl: required("ADMIN_SERVER_BASE_URL", env) },
    backupDir: required("ADMIN_BACKUP_DIR", env),
    productVersion: env.ADMIN_PRODUCT_VERSION ?? "0.1.0",
    secretFiles: [
      adminPasswordFile,
      serverPasswordFile,
      workerPasswordFile,
      s3AccessKeyFile,
      s3SecretKeyFile,
      kmsRootKeyFile,
    ],
  };
}

/** A KMS root key is 32 raw bytes, tolerating a hex or base64 encoded file. */
export function normalizeRootKey(raw: Buffer, path: string): Uint8Array {
  if (raw.length === 32) {
    return Uint8Array.from(raw);
  }
  const text = raw.toString("utf8").trim();
  const hex = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, "hex") : undefined;
  if (hex !== undefined && hex.length === 32) {
    return Uint8Array.from(hex);
  }
  const b64 = tryBase64(text);
  if (b64 !== undefined && b64.length === 32) {
    return Uint8Array.from(b64);
  }
  throw new AdminCliError(
    "ConfigInvalid",
    `KMS root key file ${path} must contain 32 raw/hex/base64 bytes`,
  );
}

function tryBase64(text: string): Buffer | undefined {
  try {
    return Buffer.from(text, "base64");
  } catch {
    return undefined;
  }
}
