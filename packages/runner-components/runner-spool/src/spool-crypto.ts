import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { RunnerSpoolError } from "./errors.js";
import { SPOOL_KEY_BYTES } from "./spool-key.js";

const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * Schema version stamped into the lease AAD. Bumping it changes the bound
 * associated data so leases written under an old schema no longer authenticate.
 */
export const SPOOL_LEASE_SCHEMA_VERSION = "spool-lease/v1";

/**
 * The authenticated, but not encrypted, associated data bound to a lease
 * ciphertext. Any change to one of these fields on disk fails GCM verification.
 */
export interface LeaseAssociatedData {
  readonly schemaVersion: string;
  readonly jobId: string;
  readonly runId: string;
  readonly leaseEpoch: number;
  readonly expiresAt: string;
}

export interface LeaseSecretInput extends LeaseAssociatedData {
  readonly secret: string;
}

export interface EncryptedLeaseSecret extends LeaseAssociatedData {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

export interface SpoolCrypto {
  encryptLease(input: LeaseSecretInput): Promise<EncryptedLeaseSecret>;
  decryptLease(input: EncryptedLeaseSecret): Promise<string>;
}

/**
 * AES-256-GCM {@link SpoolCrypto}. Each lease secret is sealed under a random
 * 96-bit nonce and a 128-bit authentication tag, with canonical UTF-8 JSON
 * `{schemaVersion,jobId,runId,leaseEpoch,expiresAt}` bound as associated data so
 * that tampering with either the ciphertext, the tag or the stored metadata is
 * detected as an integrity violation.
 */
export class AesGcmSpoolCrypto implements SpoolCrypto {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== SPOOL_KEY_BYTES) {
      throw new RunnerSpoolError(
        "SpoolKeyInvalid",
        `Spool key must be ${SPOOL_KEY_BYTES} bytes, received ${key.length}`,
      );
    }
    this.key = Buffer.from(key);
  }

  async encryptLease(input: LeaseSecretInput): Promise<EncryptedLeaseSecret> {
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    cipher.setAAD(leaseAssociatedData(input));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(input.secret, "utf8")),
      cipher.final(),
    ]);
    return {
      schemaVersion: input.schemaVersion,
      jobId: input.jobId,
      runId: input.runId,
      leaseEpoch: input.leaseEpoch,
      expiresAt: input.expiresAt,
      nonce,
      ciphertext,
      tag: cipher.getAuthTag(),
    };
  }

  async decryptLease(input: EncryptedLeaseSecret): Promise<string> {
    if (input.nonce.length !== GCM_NONCE_BYTES || input.tag.length !== GCM_TAG_BYTES) {
      throw new RunnerSpoolError(
        "SpoolLeaseIntegrityViolation",
        `Lease for job ${input.jobId} has an invalid nonce or tag length`,
      );
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, input.nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(leaseAssociatedData(input));
    decipher.setAuthTag(input.tag);
    try {
      return Buffer.concat([
        decipher.update(input.ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch (cause) {
      throw new RunnerSpoolError(
        "SpoolLeaseIntegrityViolation",
        `Lease for job ${input.jobId} failed authentication and may have been tampered with`,
        { cause },
      );
    }
  }
}

function leaseAssociatedData(data: LeaseAssociatedData): Buffer {
  const canonical = {
    expiresAt: data.expiresAt,
    jobId: data.jobId,
    leaseEpoch: data.leaseEpoch,
    runId: data.runId,
    schemaVersion: data.schemaVersion,
  };
  return Buffer.from(JSON.stringify(canonical), "utf8");
}
