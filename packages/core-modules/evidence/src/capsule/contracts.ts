/**
 * Evidence Capsule v1 contracts (LS-10 Task 4).
 *
 * These types freeze the confidentiality boundary for offline-investigable
 * evidence. A remote Capsule is a scope-bound, authenticated envelope: the
 * Payload is AES-256-GCM encrypted under a per-Capsule Data Encryption Key
 * (DEK), the DEK is RSA-OAEP-256 wrapped under a recipient KMS public key, and
 * the canonical `EvidenceCapsuleProtectedHeader` bytes are the only AEAD AAD so
 * that any metadata tamper fails before plaintext is ever returned.
 *
 * `EvidenceCapsuleBuildResult` is a disjoint union: `remote_capsule` carries a
 * Manifest + ciphertext, while `local_only` carries only a
 * `LocalOnlyEvidenceRecord` and can never enter a remote upload queue.
 */

/** Content encryption algorithm for the Payload. */
export type EvidenceContentEncryptionAlgorithm = "A256GCM";

/** DEK wrapping algorithm. */
export type EvidenceKeyWrappingAlgorithm = "RSA-OAEP-256";

/** Non-secret purpose binding for a Capsule and its audit trail. */
export type EvidencePurpose = "investigation";

/** Kinds of evidence entry that may appear in a Payload. */
export type EvidenceCapsuleEntryKind =
  | "trace"
  | "semantic_graph"
  | "screenshot"
  | "log_summary";

/** Permitted entry media types. */
export type EvidenceCapsuleMediaType =
  | "application/json"
  | "image/png"
  | "image/jpeg"
  | "text/plain";

/**
 * A scope-bound encryption profile issued by an authenticated KMS channel. The
 * Builder never accepts caller overrides of any bound field; every value here
 * is copied verbatim into the protected header.
 */
export interface EvidenceEncryptionProfile {
  readonly profileId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly recipient: string;
  readonly region: string;
  readonly purpose: EvidencePurpose;
  readonly policyId: string;
  readonly wrappingKeyId: string;
  readonly wrappingPublicKeyPem: string;
  readonly contentEncryptionAlgorithm: EvidenceContentEncryptionAlgorithm;
  readonly keyWrappingAlgorithm: EvidenceKeyWrappingAlgorithm;
  readonly aadSchemaVersion: "evidence-capsule-aad/v1";
  readonly allowedEntryKinds: readonly EvidenceCapsuleEntryKind[];
  readonly maximumEntryBytes: number;
  readonly maximumPlaintextBytes: number;
  readonly maximumCiphertextBytes: number;
  readonly expiresAt: string;
}

/** One encrypted-at-rest evidence blob carrying its actual bytes. */
export interface EvidenceCapsuleEntry {
  readonly entryId: string;
  readonly kind: EvidenceCapsuleEntryKind;
  readonly mediaType: EvidenceCapsuleMediaType;
  readonly plaintextSha256: string;
  readonly plaintextBytes: number;
  readonly dataBase64: string;
}

/** The closed Payload encrypted inside a Capsule. */
export interface EvidenceCapsulePayload {
  readonly schemaVersion: "evidence-capsule/v1";
  readonly runId: string;
  readonly entries: readonly EvidenceCapsuleEntry[];
}

/**
 * The authenticated, non-secret protected header. Its RFC 8785 canonical UTF-8
 * bytes are the sole AES-GCM AAD; every field below is therefore integrity
 * protected and any change fails decryption.
 */
export interface EvidenceCapsuleProtectedHeader {
  readonly schemaVersion: "evidence-capsule-aad/v1";
  readonly capsuleId: string;
  readonly profileId: string;
  readonly payloadSchemaVersion: "evidence-capsule/v1";
  readonly tenantId: string;
  readonly caseId: string;
  readonly recipient: string;
  readonly region: string;
  readonly purpose: EvidencePurpose;
  readonly policyId: string;
  readonly contentEncryptionAlgorithm: EvidenceContentEncryptionAlgorithm;
  readonly keyWrappingAlgorithm: EvidenceKeyWrappingAlgorithm;
  readonly wrappingKeyId: string;
  readonly plaintextSha256: string;
  readonly plaintextBytes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** A remote, uploadable Capsule manifest. Always carries a wrapped DEK. */
export interface RemoteEvidenceCapsuleManifest {
  readonly protectedHeader: EvidenceCapsuleProtectedHeader;
  readonly ciphertextSha256: string;
  readonly ciphertextBytes: number;
  readonly wrappedDekBase64: string;
  readonly nonceBase64: string;
  readonly authTagBase64: string;
}

/**
 * A local-only evidence record. It never has a Manifest, ciphertext or wrapped
 * DEK and is structurally incapable of entering the remote upload queue.
 */
export interface LocalOnlyEvidenceRecord {
  readonly localRecordId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly disposition: "local_only";
  readonly reason: string;
  readonly localContentRefs: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Disjoint build result: remote Capsule bytes, or a local-only record. */
export type EvidenceCapsuleBuildResult =
  | {
      readonly disposition: "remote_capsule";
      readonly manifest: RemoteEvidenceCapsuleManifest;
      readonly ciphertext: Uint8Array;
    }
  | {
      readonly disposition: "local_only";
      readonly record: LocalOnlyEvidenceRecord;
    };

/** An immutable audit record for every Capsule key/crypto operation. */
export interface EvidenceAuditEvent {
  readonly auditId: string;
  readonly actorType: "user" | "service";
  readonly actorId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly capsuleId: string;
  readonly keyVersion: string;
  readonly purpose: EvidencePurpose;
  readonly operation:
    | "profile"
    | "wrap"
    | "unwrap"
    | "rewrap"
    | "revoke"
    | "delete";
  readonly decision: "allowed" | "denied" | "failed";
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly occurredAt: string;
}

/** Scope input for requesting a profile or unwrapping a DEK. */
export interface EvidenceKeyScope {
  readonly tenantId: string;
  readonly caseId: string;
  readonly region: string;
  readonly purpose: EvidencePurpose;
}

/**
 * The frozen Key Management port. A Local KMS and an enterprise KMS satisfy the
 * same contract; wrong-scope unwrap must be cryptographically impossible, not a
 * bypassable permission check.
 */
export interface KeyManagementProvider {
  encryptionProfile(input: EvidenceKeyScope): Promise<EvidenceEncryptionProfile>;
  wrapDek(profile: EvidenceEncryptionProfile, dek: Uint8Array): Promise<string>;
  unwrapDek(
    input: {
      readonly manifest: RemoteEvidenceCapsuleManifest;
    } & EvidenceKeyScope,
  ): Promise<Uint8Array>;
  revoke(capsuleId: string, reason: string): Promise<void>;
}

/** A sink that persists immutable audit events (never DEK/plaintext). */
export interface EvidenceAuditSink {
  record(event: EvidenceAuditEvent): void | Promise<void>;
}

/** Minimal clock so crypto code does not depend on wall-clock directly. */
export interface EvidenceClock {
  now(): string;
}

/**
 * A remote upload port. It only accepts `RemoteEvidenceCapsuleManifest`, so the
 * compiler rejects any attempt to hand it a local-only record.
 */
export interface RemoteCapsuleUploadPort {
  enqueue(
    manifest: RemoteEvidenceCapsuleManifest,
    ciphertext: Uint8Array,
  ): Promise<void>;
}

/** Error codes raised by Capsule crypto/policy enforcement. */
export type EvidenceCapsuleErrorCode =
  | "EvidenceIntegrityViolation"
  | "EvidenceScopeMismatch"
  | "EvidenceProfileMismatch"
  | "EvidenceExpired"
  | "EvidenceKeyRevoked"
  | "EvidenceLimited"
  | "EvidenceEntryLimitExceeded"
  | "EvidenceKindNotAllowed"
  | "EvidenceSchemaInvalid"
  | "EvidenceManifestInvalid";

/** A typed failure in the Capsule crypto/policy path. */
export class EvidenceCapsuleError extends Error {
  readonly code: EvidenceCapsuleErrorCode;

  constructor(
    code: EvidenceCapsuleErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "EvidenceCapsuleError";
    this.code = code;
  }
}
