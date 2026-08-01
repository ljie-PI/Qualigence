import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  EvidenceCapsuleError,
  type EvidenceAuditEvent,
  type EvidenceAuditSink,
  type EvidenceCapsulePayload,
  type EvidenceCapsuleProtectedHeader,
  type EvidenceClock,
  type EvidenceEncryptionProfile,
  type KeyManagementProvider,
  type RemoteEvidenceCapsuleManifest,
} from "./contracts.js";
import {
  canonicalPayloadBytes,
  canonicalProtectedHeaderBytes,
  headerFromProfile,
} from "./protected-header.js";
import { sha256Hex, verifyCapsuleEntry } from "./capsule-entry.js";

const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_MANIFEST_CIPHERTEXT_BYTES = 64 * 1024 * 1024;

/** Actor/correlation context threaded into every audit event. */
export interface EvidenceActor {
  readonly actorType: "user" | "service";
  readonly actorId: string;
  readonly correlationId: string;
}

/** Server-issued fields for a Capsule build. */
export interface EncryptCapsuleContext extends EvidenceActor {
  readonly capsuleId?: string;
  readonly createdAt?: string;
}

/** The output of a successful encrypt. */
export interface EncryptedCapsule {
  readonly manifest: RemoteEvidenceCapsuleManifest;
  readonly ciphertext: Uint8Array;
}

/**
 * The authenticated context a decrypter is acting under. The header must match
 * this scope exactly; a mismatch is denied and audited before any unwrap.
 */
export interface EvidenceDecryptionContext extends EvidenceActor {
  readonly tenantId: string;
  readonly caseId: string;
  readonly recipient: string;
  readonly region: string;
  readonly purpose: "investigation";
  readonly policyId: string;
  readonly now?: string;
}

/**
 * Hybrid envelope crypto for Evidence Capsules.
 *
 * Encrypt: random 32-byte DEK + 12-byte nonce, AES-256-GCM over canonical
 * Payload bytes with the canonical protected-header bytes as the ONLY AAD, DEK
 * RSA-OAEP-256 wrapped by the KMS. The DEK buffer is zeroed in `finally`.
 *
 * Decrypt follows a fixed order: bound manifest → validate header scope against
 * the authenticated context → unwrap DEK (KMS enforces key status/revocation
 * and cryptographic scope) → GCM verify+decrypt with header AAD → validate
 * Payload/entry hashes → audit → return. Any tamper or scope mismatch fails
 * before plaintext is produced, and every terminal outcome writes exactly one
 * audit event.
 */
export class EvidenceEnvelopeEncryptor {
  private readonly kms: KeyManagementProvider;
  private readonly audit: EvidenceAuditSink;
  private readonly clock: EvidenceClock;

  constructor(deps: {
    readonly kms: KeyManagementProvider;
    readonly audit: EvidenceAuditSink;
    readonly clock: EvidenceClock;
  }) {
    this.kms = deps.kms;
    this.audit = deps.audit;
    this.clock = deps.clock;
  }

  async encrypt(
    payload: EvidenceCapsulePayload,
    profile: EvidenceEncryptionProfile,
    context: EncryptCapsuleContext,
  ): Promise<EncryptedCapsule> {
    const createdAt = context.createdAt ?? this.clock.now();
    const capsuleId = context.capsuleId ?? randomUUID();

    if (createdAt >= profile.expiresAt) {
      await this.write(profile, capsuleId, context, {
        operation: "wrap",
        decision: "denied",
        reasonCode: "EvidenceExpired",
      });
      throw new EvidenceCapsuleError(
        "EvidenceExpired",
        `Profile ${profile.profileId} expired at ${profile.expiresAt}.`,
      );
    }

    const plaintext = canonicalPayloadBytes(payload);
    const header = headerFromProfile(profile, {
      capsuleId,
      createdAt,
      plaintextSha256: sha256Hex(plaintext),
      plaintextBytes: plaintext.byteLength,
    });
    const aad = canonicalProtectedHeaderBytes(header);

    const dek = randomBytes(DEK_BYTES);
    try {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", dek, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      let wrappedDekBase64: string;
      try {
        wrappedDekBase64 = await this.kms.wrapDek(profile, dek);
      } catch (cause) {
        await this.write(profile, capsuleId, context, {
          operation: "wrap",
          decision: "failed",
          reasonCode: "EvidenceLimited",
        });
        throw new EvidenceCapsuleError(
          "EvidenceLimited",
          "KMS is unavailable; refusing plaintext fallback.",
          { cause },
        );
      }

      const manifest: RemoteEvidenceCapsuleManifest = {
        protectedHeader: header,
        ciphertextSha256: sha256Hex(ciphertext),
        ciphertextBytes: ciphertext.byteLength,
        wrappedDekBase64,
        nonceBase64: nonce.toString("base64"),
        authTagBase64: authTag.toString("base64"),
      };

      await this.write(profile, capsuleId, context, {
        operation: "wrap",
        decision: "allowed",
        reasonCode: "ok",
      });
      return { manifest, ciphertext };
    } finally {
      dek.fill(0);
    }
  }

  async decrypt(
    encrypted: EncryptedCapsule,
    context: EvidenceDecryptionContext,
  ): Promise<EvidenceCapsulePayload> {
    const { manifest, ciphertext } = encrypted;
    const header = manifest.protectedHeader;
    const now = context.now ?? this.clock.now();

    // 1 + 2. Bound the manifest and validate protected-header scope against the
    // authenticated context. Any boundary denial is audited before crypto.
    try {
      this.boundManifest(manifest, ciphertext);
      this.assertScope(manifest, context, now);
    } catch (error) {
      if (error instanceof EvidenceCapsuleError) {
        await this.writeFromHeader(header, context, {
          operation: "unwrap",
          decision: "denied",
          reasonCode: error.code,
        });
      }
      throw error;
    }

    // 3 + 4. Unwrap the DEK (KMS enforces key status/revocation and the
    // cryptographic scope binding). A wrong scope key cannot unwrap.
    let dek: Buffer;
    try {
      const unwrapped = await this.kms.unwrapDek({
        manifest,
        tenantId: context.tenantId,
        caseId: context.caseId,
        region: context.region,
        purpose: context.purpose,
      });
      dek = Buffer.from(unwrapped);
    } catch (cause) {
      const code =
        cause instanceof EvidenceCapsuleError &&
        (cause.code === "EvidenceKeyRevoked" || cause.code === "EvidenceLimited")
          ? cause.code
          : "EvidenceIntegrityViolation";
      await this.writeFromHeader(header, context, {
        operation: "unwrap",
        decision: code === "EvidenceLimited" ? "failed" : "denied",
        reasonCode: code,
      });
      throw cause instanceof EvidenceCapsuleError
        ? cause
        : new EvidenceCapsuleError(
            "EvidenceIntegrityViolation",
            "DEK unwrap failed.",
            { cause },
          );
    }

    // 5. GCM verify + decrypt with canonical header bytes as the only AAD.
    try {
      const aad = canonicalProtectedHeaderBytes(header);
      const nonce = Buffer.from(manifest.nonceBase64, "base64");
      const authTag = Buffer.from(manifest.authTagBase64, "base64");
      if (authTag.byteLength !== AUTH_TAG_BYTES) {
        throw new EvidenceCapsuleError(
          "EvidenceIntegrityViolation",
          "Auth tag length is invalid.",
        );
      }
      const decipher = createDecipheriv("aes-256-gcm", dek, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      let plaintext: Buffer;
      try {
        plaintext = Buffer.concat([
          decipher.update(Buffer.from(ciphertext)),
          decipher.final(),
        ]);
      } catch (cause) {
        throw new EvidenceCapsuleError(
          "EvidenceIntegrityViolation",
          "Ciphertext, auth tag or AAD failed authentication.",
          { cause },
        );
      }

      // 6. Validate Payload schema, plaintext digest and each entry.
      const payload = this.parsePayload(plaintext, header);

      // 7. Audit success then return.
      await this.writeFromHeader(header, context, {
        operation: "unwrap",
        decision: "allowed",
        reasonCode: "ok",
      });
      return payload;
    } catch (error) {
      if (error instanceof EvidenceCapsuleError) {
        await this.writeFromHeader(header, context, {
          operation: "unwrap",
          decision: "denied",
          reasonCode: error.code,
        });
      }
      throw error;
    } finally {
      dek.fill(0);
    }
  }

  private boundManifest(
    manifest: RemoteEvidenceCapsuleManifest,
    ciphertext: Uint8Array,
  ): void {
    const header = manifest.protectedHeader;
    const fail = (message: string): never => {
      throw new EvidenceCapsuleError("EvidenceManifestInvalid", message);
    };
    if (manifest.ciphertextBytes !== ciphertext.byteLength) {
      fail("Manifest ciphertextBytes does not match ciphertext length.");
    }
    if (manifest.ciphertextBytes > MAX_MANIFEST_CIPHERTEXT_BYTES) {
      fail("Manifest ciphertext exceeds the hard size bound.");
    }
    if (sha256Hex(Buffer.from(ciphertext)) !== manifest.ciphertextSha256) {
      throw new EvidenceCapsuleError(
        "EvidenceIntegrityViolation",
        "Ciphertext does not match the manifest digest.",
      );
    }
    if (header.contentEncryptionAlgorithm !== "A256GCM") {
      fail("Unsupported content encryption algorithm.");
    }
    if (header.keyWrappingAlgorithm !== "RSA-OAEP-256") {
      fail("Unsupported key wrapping algorithm.");
    }
  }

  private assertScope(
    manifest: RemoteEvidenceCapsuleManifest,
    context: EvidenceDecryptionContext,
    now: string,
  ): void {
    const header = manifest.protectedHeader;
    const mismatch =
      (header.tenantId !== context.tenantId && "tenantId") ||
      (header.caseId !== context.caseId && "caseId") ||
      (header.recipient !== context.recipient && "recipient") ||
      (header.region !== context.region && "region") ||
      (header.purpose !== context.purpose && "purpose") ||
      (header.policyId !== context.policyId && "policyId");
    if (mismatch) {
      throw new EvidenceCapsuleError(
        "EvidenceScopeMismatch",
        `Protected header ${mismatch} does not match the authenticated context.`,
      );
    }
    if (now >= header.expiresAt) {
      throw new EvidenceCapsuleError(
        "EvidenceExpired",
        `Capsule ${header.capsuleId} expired at ${header.expiresAt}.`,
      );
    }
  }

  private parsePayload(
    plaintext: Buffer,
    header: EvidenceCapsuleProtectedHeader,
  ): EvidenceCapsulePayload {
    if (
      plaintext.byteLength !== header.plaintextBytes ||
      sha256Hex(plaintext) !== header.plaintextSha256
    ) {
      throw new EvidenceCapsuleError(
        "EvidenceIntegrityViolation",
        "Decrypted plaintext does not match the header digest.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString("utf8"));
    } catch (cause) {
      throw new EvidenceCapsuleError(
        "EvidenceSchemaInvalid",
        "Payload is not valid JSON.",
        { cause },
      );
    }
    const payload = parsed as EvidenceCapsulePayload;
    if (
      payload === null ||
      typeof payload !== "object" ||
      payload.schemaVersion !== "evidence-capsule/v1" ||
      typeof payload.runId !== "string" ||
      !Array.isArray(payload.entries)
    ) {
      throw new EvidenceCapsuleError(
        "EvidenceSchemaInvalid",
        "Payload does not match evidence-capsule/v1.",
      );
    }
    for (const entry of payload.entries) {
      verifyCapsuleEntry(entry);
    }
    return payload;
  }

  private async write(
    profile: EvidenceEncryptionProfile,
    capsuleId: string,
    actor: EvidenceActor,
    outcome: Pick<
      EvidenceAuditEvent,
      "operation" | "decision" | "reasonCode"
    >,
  ): Promise<void> {
    await this.audit.record({
      auditId: randomUUID(),
      actorType: actor.actorType,
      actorId: actor.actorId,
      tenantId: profile.tenantId,
      caseId: profile.caseId,
      capsuleId,
      keyVersion: profile.wrappingKeyId,
      purpose: profile.purpose,
      operation: outcome.operation,
      decision: outcome.decision,
      reasonCode: outcome.reasonCode,
      correlationId: actor.correlationId,
      occurredAt: this.clock.now(),
    });
  }

  private async writeFromHeader(
    header: EvidenceCapsuleProtectedHeader,
    actor: EvidenceActor,
    outcome: Pick<
      EvidenceAuditEvent,
      "operation" | "decision" | "reasonCode"
    >,
  ): Promise<void> {
    await this.audit.record({
      auditId: randomUUID(),
      actorType: actor.actorType,
      actorId: actor.actorId,
      tenantId: header.tenantId,
      caseId: header.caseId,
      capsuleId: header.capsuleId,
      keyVersion: header.wrappingKeyId,
      purpose: header.purpose,
      operation: outcome.operation,
      decision: outcome.decision,
      reasonCode: outcome.reasonCode,
      correlationId: actor.correlationId,
      occurredAt: this.clock.now(),
    });
  }
}
