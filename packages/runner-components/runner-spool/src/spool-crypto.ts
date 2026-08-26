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
export const SPOOL_RESUME_SCHEMA_VERSION = "spool-resume/v1";

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

export interface ResumeAssociatedData {
  readonly schemaVersion: string;
  readonly sessionId: string;
}

export interface ResumeSecretInput extends ResumeAssociatedData {
  readonly secret: string;
}

export interface EncryptedResumeSecret extends ResumeAssociatedData {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

export interface SpoolCrypto {
  encryptLease(input: LeaseSecretInput): Promise<EncryptedLeaseSecret>;
  decryptLease(input: EncryptedLeaseSecret): Promise<string>;
  encryptResume(input: ResumeSecretInput): Promise<EncryptedResumeSecret>;
  decryptResume(input: EncryptedResumeSecret): Promise<string>;
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
    const encrypted = encryptSecret(this.key, input.secret, leaseAssociatedData(input));
    return {
      schemaVersion: input.schemaVersion,
      jobId: input.jobId,
      runId: input.runId,
      leaseEpoch: input.leaseEpoch,
      expiresAt: input.expiresAt,
      ...encrypted,
    };
  }

  async decryptLease(input: EncryptedLeaseSecret): Promise<string> {
    return decryptSecret({
      key: this.key,
      nonce: input.nonce,
      tag: input.tag,
      ciphertext: input.ciphertext,
      associatedData: leaseAssociatedData(input),
      invalidLengthMessage: `Lease for job ${input.jobId} has an invalid nonce or tag length`,
      authenticationMessage: `Lease for job ${input.jobId} failed authentication and may have been tampered with`,
      integrityCode: "SpoolLeaseIntegrityViolation",
    });
  }

  async encryptResume(input: ResumeSecretInput): Promise<EncryptedResumeSecret> {
    const encrypted = encryptSecret(this.key, input.secret, resumeAssociatedData(input));
    return {
      schemaVersion: input.schemaVersion,
      sessionId: input.sessionId,
      ...encrypted,
    };
  }

  async decryptResume(input: EncryptedResumeSecret): Promise<string> {
    return decryptSecret({
      key: this.key,
      nonce: input.nonce,
      tag: input.tag,
      ciphertext: input.ciphertext,
      associatedData: resumeAssociatedData(input),
      invalidLengthMessage: `Resume token for session ${input.sessionId} has an invalid nonce or tag length`,
      authenticationMessage: `Resume token for session ${input.sessionId} failed authentication and may have been tampered with`,
      integrityCode: "SpoolResumeIntegrityViolation",
    });
  }
}

function encryptSecret(key: Buffer, secret: string, associatedData: Buffer): {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
} {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(secret, "utf8")),
    cipher.final(),
  ]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

function decryptSecret(input: {
  readonly key: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
  readonly associatedData: Buffer;
  readonly invalidLengthMessage: string;
  readonly authenticationMessage: string;
  readonly integrityCode: "SpoolLeaseIntegrityViolation" | "SpoolResumeIntegrityViolation";
}): string {
  if (input.nonce.length !== GCM_NONCE_BYTES || input.tag.length !== GCM_TAG_BYTES) {
    throw new RunnerSpoolError(input.integrityCode, input.invalidLengthMessage);
  }
  const decipher = createDecipheriv("aes-256-gcm", input.key, input.nonce, {
    authTagLength: GCM_TAG_BYTES,
  });
  decipher.setAAD(input.associatedData);
  decipher.setAuthTag(input.tag);
  try {
    return Buffer.concat([
      decipher.update(input.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw new RunnerSpoolError(input.integrityCode, input.authenticationMessage, { cause });
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

function resumeAssociatedData(data: ResumeAssociatedData): Buffer {
  const canonical = {
    schemaVersion: data.schemaVersion,
    sessionId: data.sessionId,
  };
  return Buffer.from(JSON.stringify(canonical), "utf8");
}
