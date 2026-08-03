import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { platform } from "node:process";
import { RunnerSpoolError } from "./errors.js";

/**
 * Size, in bytes, of the local spool key. It is a 256-bit key used with
 * AES-256-GCM to protect lease secrets at rest.
 */
export const SPOOL_KEY_BYTES = 32;

const OWNER_ONLY_MODE = 0o600;

/**
 * Load the 32-byte spool key from disk, creating it on first use.
 *
 * The key file lives next to the local CA private key and is only readable by
 * the current OS user: on Unix it is written with mode `0600`; on Windows an
 * explicit DACL grants only the current logon SID. It never enters SQLite,
 * logs or backups.
 */
export async function loadOrCreateSpoolKey(keyFile: string): Promise<Buffer> {
  const existing = await readSpoolKey(keyFile);
  if (existing !== undefined) {
    return existing;
  }

  const key = randomBytes(SPOOL_KEY_BYTES);
  await mkdir(dirname(keyFile), { recursive: true });
  const temporaryPath = `${keyFile}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, key, { mode: OWNER_ONLY_MODE, flag: "wx" });
    await restrictToOwner(temporaryPath);
    await rename(temporaryPath, keyFile);
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new RunnerSpoolError(
      "SpoolKeyInvalid",
      `Failed to create spool key at ${keyFile}`,
      { cause },
    );
  }
  await restrictToOwner(keyFile);
  return key;
}

/**
 * Load the spool key from disk without creating it. Returns `undefined` when
 * the key file is absent (a lost or never-initialised key), so callers can drop
 * lease metadata and preserve Trace rather than crashing.
 */
export async function readSpoolKey(keyFile: string): Promise<Buffer | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(keyFile);
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw new RunnerSpoolError(
      "SpoolKeyUnavailable",
      `Failed to read spool key at ${keyFile}`,
      { cause },
    );
  }
  if (bytes.length !== SPOOL_KEY_BYTES) {
    throw new RunnerSpoolError(
      "SpoolKeyInvalid",
      `Spool key at ${keyFile} must be ${SPOOL_KEY_BYTES} bytes, found ${bytes.length}`,
    );
  }
  return bytes;
}

async function restrictToOwner(path: string): Promise<void> {
  if (platform === "win32") {
    await restrictWindowsDacl(path);
    return;
  }
  await chmod(path, OWNER_ONLY_MODE);
}

async function restrictWindowsDacl(path: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const account = process.env["USERNAME"] ?? process.env["USERDOMAIN"] ?? "";
  try {
    await run("icacls", [path, "/inheritance:r"]);
    if (account.length > 0) {
      await run("icacls", [path, "/grant:r", `${account}:F`]);
    }
  } catch (cause) {
    throw new RunnerSpoolError(
      "SpoolKeyInvalid",
      `Failed to restrict spool key ACL at ${path}`,
      { cause },
    );
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}
