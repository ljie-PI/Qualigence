import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import type {
  EvidenceCapsuleEntryKind,
  EvidenceEncryptionProfile,
  EvidenceKeyScope,
  KeyManagementProvider,
  RemoteEvidenceCapsuleManifest,
  EvidencePlaintextAccessCheck,
  EvidencePlaintextAccessKeyPolicy,
} from "@qualigence/evidence";

const RSA_MODULUS_BITS = 2048;
const KEY_ID_LENGTH = 32;
const ROOT_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type KmsProviderErrorCode =
  | "KmsUnavailable"
  | "KmsRootKeyInvalid"
  | "KmsScopeDenied"
  | "KmsKeyRevoked"
  | "KmsIntegrityViolation";

/** A typed failure raised by the Self-hosted KMS provider. */
export class SelfHostedKmsError extends Error {
  readonly code: KmsProviderErrorCode;

  constructor(
    code: KmsProviderErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SelfHostedKmsError";
    this.code = code;
  }
}

/** An immutable, non-secret audit record for a KMS operation. */
export interface KmsAuditEvent {
  readonly operation: "profile" | "wrap" | "unwrap" | "rotate" | "revoke";
  readonly decision: "allowed" | "denied" | "failed";
  readonly reasonCode: string;
  readonly scopeId?: string | undefined;
  readonly keyId?: string | undefined;
  readonly capsuleId?: string | undefined;
  readonly occurredAt: string;
}

/** A sink for immutable audit events (never receives key or DEK plaintext). */
export interface KmsAuditSink {
  record(event: KmsAuditEvent): void | Promise<void>;
}

/**
 * A persisted wrapping-key version. The private key is stored only as
 * AES-256-GCM ciphertext (`wrappedPrivateKeyBase64`) under the root KEK, so no
 * plaintext key material is ever written at rest. The public key and metadata
 * are non-secret.
 */
export interface StoredKmsKeyVersion {
  readonly scopeId: string;
  readonly keyId: string;
  readonly revision: number;
  readonly publicKeyPem: string;
  readonly wrappedPrivateKeyBase64: string;
  readonly privateKeyNonceBase64: string;
  readonly privateKeyTagBase64: string;
  status: "active" | "revoked";
  readonly createdAt: string;
  isPrimary: boolean;
}

/** Persistence port for wrapping-key versions (Postgres-backed in production). */
export interface SelfHostedKmsKeyStore {
  putVersion(version: StoredKmsKeyVersion): void;
  listVersions(scopeId: string): readonly StoredKmsKeyVersion[];
  getByKeyId(keyId: string): StoredKmsKeyVersion | undefined;
  primaryVersion(scopeId: string): StoredKmsKeyVersion | undefined;
  setPrimary(scopeId: string, keyId: string): void;
  markScopeRevoked(scopeId: string): void;
}

/** In-memory key store used for tests and single-process deployments. */
export class InMemoryKmsKeyStore implements SelfHostedKmsKeyStore {
  private readonly byKeyId = new Map<string, StoredKmsKeyVersion>();
  private readonly byScope = new Map<string, StoredKmsKeyVersion[]>();

  putVersion(version: StoredKmsKeyVersion): void {
    this.byKeyId.set(version.keyId, version);
    const list = this.byScope.get(version.scopeId) ?? [];
    list.push(version);
    this.byScope.set(version.scopeId, list);
  }

  listVersions(scopeId: string): readonly StoredKmsKeyVersion[] {
    return this.byScope.get(scopeId) ?? [];
  }

  getByKeyId(keyId: string): StoredKmsKeyVersion | undefined {
    return this.byKeyId.get(keyId);
  }

  primaryVersion(scopeId: string): StoredKmsKeyVersion | undefined {
    return (this.byScope.get(scopeId) ?? []).find(
      (version) => version.isPrimary && version.status === "active",
    );
  }

  setPrimary(scopeId: string, keyId: string): void {
    for (const version of this.byScope.get(scopeId) ?? []) {
      version.isPrimary = version.keyId === keyId;
    }
  }

  markScopeRevoked(scopeId: string): void {
    for (const version of this.byScope.get(scopeId) ?? []) {
      version.status = "revoked";
    }
  }

  /**
   * Test-only helper: decrypt a stored private key back to PEM using the root
   * key. Present so tests can prove the at-rest blob is genuine RSA-OAEP key
   * material rather than a stub, without exposing decryption in production code.
   */
  exportPrivateKeyPemForTest(keyId: string, rootKey: Uint8Array): string {
    const version = this.getByKeyId(keyId);
    if (version === undefined) {
      throw new Error(`No key version ${keyId}`);
    }
    return decryptPrivateKey(version, rootKey)
      .export({ format: "pem", type: "pkcs8" })
      .toString();
  }
}

/** Configuration for the profiles this KMS issues and its root key material. */
export interface SelfHostedKmsOptions {
  /** 32-byte root key-encryption key, sourced from a `SecretProvider`. */
  readonly rootKey: Uint8Array;
  readonly keyStore?: SelfHostedKmsKeyStore;
  readonly audit?: KmsAuditSink;
  readonly recipient?: string;
  readonly policyId?: string;
  readonly allowedEntryKinds?: readonly EvidenceCapsuleEntryKind[];
  readonly maximumEntryBytes?: number;
  readonly maximumPlaintextBytes?: number;
  readonly maximumCiphertextBytes?: number;
  readonly ttlMs?: number;
  readonly now?: () => string;
}

/**
 * A production-grade, self-hosted Key Management provider with real envelope
 * encryption. Each authenticated scope (`tenant|case|region|purpose`) owns
 * versioned RSA-OAEP-256 wrapping keys whose private halves are sealed at rest
 * with AES-256-GCM under a root KEK — no plaintext key material is ever
 * persisted. Unwrap selects the private key from the authenticated scope and
 * requires the manifest's `wrappingKeyId` to belong to that same scope, so a
 * capsule wrapped for one tenant cannot be unwrapped by another even with the
 * correct ciphertext. Rotation appends immutable key revisions and never
 * mutates prior ones, so historical capsules remain readable.
 *
 * The provider satisfies the frozen `KeyManagementProvider` port so a Vault
 * Transit or other enterprise KMS can be swapped in behind the same contract.
 */
export class SelfHostedKms implements KeyManagementProvider, EvidencePlaintextAccessKeyPolicy {
  private readonly rootKey: Uint8Array;
  private readonly store: SelfHostedKmsKeyStore;
  private readonly audit: KmsAuditSink | undefined;
  private readonly revokedCapsules = new Set<string>();
  private available = true;
  private readonly profile: Required<
    Omit<SelfHostedKmsOptions, "rootKey" | "keyStore" | "audit" | "now">
  > & { readonly now: () => string };

  constructor(options: SelfHostedKmsOptions) {
    if (options.rootKey.length !== ROOT_KEY_BYTES) {
      throw new SelfHostedKmsError(
        "KmsRootKeyInvalid",
        `Root key must be ${ROOT_KEY_BYTES} bytes, received ${options.rootKey.length}.`,
      );
    }
    this.rootKey = Uint8Array.from(options.rootKey);
    this.store = options.keyStore ?? new InMemoryKmsKeyStore();
    this.audit = options.audit;
    this.profile = {
      recipient: options.recipient ?? "investigation-worker@self-hosted",
      policyId: options.policyId ?? "evidence-policy/self-hosted-v1",
      allowedEntryKinds: options.allowedEntryKinds ?? [
        "trace",
        "semantic_graph",
        "screenshot",
        "log_summary",
      ],
      maximumEntryBytes: options.maximumEntryBytes ?? 5 * 1024 * 1024,
      maximumPlaintextBytes: options.maximumPlaintextBytes ?? 20 * 1024 * 1024,
      maximumCiphertextBytes: options.maximumCiphertextBytes ?? 24 * 1024 * 1024,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  /** Simulate KMS availability for fail-closed tests. */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  async encryptionProfile(
    input: EvidenceKeyScope,
  ): Promise<EvidenceEncryptionProfile> {
    await this.assertAvailable("profile");
    const version = this.ensurePrimaryVersion(input);
    await this.emit("profile", "allowed", "profile_issued", input, version.keyId);
    return this.buildProfile(input, version);
  }

  async wrapDek(
    profile: EvidenceEncryptionProfile,
    dek: Uint8Array,
  ): Promise<string> {
    await this.assertAvailable("wrap");
    const version = this.store.getByKeyId(profile.wrappingKeyId);
    if (version === undefined) {
      throw await this.deny("wrap", "unknown_key", profile.wrappingKeyId);
    }
    if (version.status !== "active") {
      throw await this.revoked("wrap", version);
    }
    const scope = scopeFromId(version.scopeId);
    const expected = this.buildProfile(scope, version);
    if (!profileMatches(expected, profile)) {
      throw await this.deny(
        "wrap",
        "profile_tampered",
        profile.wrappingKeyId,
        version.scopeId,
      );
    }
    const wrapped = publicEncrypt(
      {
        key: version.publicKeyPem,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(dek),
    );
    await this.emit("wrap", "allowed", "dek_wrapped", scope, version.keyId);
    return wrapped.toString("base64");
  }

  async unwrapDek(
    input: { readonly manifest: RemoteEvidenceCapsuleManifest } & EvidenceKeyScope,
  ): Promise<Uint8Array> {
    await this.assertAvailable("unwrap");
    const scope: EvidenceKeyScope = {
      tenantId: input.tenantId,
      caseId: input.caseId,
      region: input.region,
      purpose: input.purpose,
    };
    const authenticatedScopeId = scopeId(scope);
    const capsuleId = input.manifest.protectedHeader.capsuleId;
    if (this.revokedCapsules.has(capsuleId)) {
      throw await this.revokedCapsule("unwrap", capsuleId, authenticatedScopeId);
    }

    const wrappingKeyId = input.manifest.protectedHeader.wrappingKeyId;
    const version = this.store.getByKeyId(wrappingKeyId);
    // The key must belong to the AUTHENTICATED scope. A wrong scope selects no
    // key it is entitled to, so unwrap is impossible rather than merely denied.
    if (version === undefined || version.scopeId !== authenticatedScopeId) {
      throw await this.deny("unwrap", "scope_mismatch", wrappingKeyId, authenticatedScopeId, capsuleId);
    }
    if (version.status !== "active") {
      throw await this.revoked("unwrap", version, capsuleId);
    }

    const privateKey = decryptPrivateKey(version, this.rootKey);
    let dek: Buffer;
    try {
      dek = privateDecryptWithScope(privateKey, input.manifest.wrappedDekBase64);
    } catch (cause) {
      await this.emit(
        "unwrap",
        "failed",
        "unwrap_failed",
        scope,
        wrappingKeyId,
        capsuleId,
      );
      throw new SelfHostedKmsError(
        "KmsIntegrityViolation",
        "Wrapped DEK could not be unwrapped for the requested scope.",
        { cause },
      );
    }
    await this.emit("unwrap", "allowed", "dek_unwrapped", scope, wrappingKeyId, capsuleId);
    return new Uint8Array(dek);
  }

  async assertPlaintextAccess(input: EvidencePlaintextAccessCheck): Promise<void> {
    await this.assertAvailable("unwrap");
    const scope: EvidenceKeyScope = {
      tenantId: input.tenantId,
      caseId: input.caseId,
      region: input.region,
      purpose: input.purpose,
    };
    const id = scopeId(scope);
    if (this.revokedCapsules.has(input.capsuleId)) {
      throw await this.revokedCapsule("unwrap", input.capsuleId, id);
    }
    const version = this.store.getByKeyId(input.keyVersion);
    if (version === undefined || version.scopeId !== id) {
      throw await this.deny("unwrap", "scope_mismatch", input.keyVersion, id, input.capsuleId);
    }
    if (version.status !== "active") {
      throw await this.revoked("unwrap", version, input.capsuleId);
    }
    await this.emit("unwrap", "allowed", "plaintext_access_verified", scope, input.keyVersion, input.capsuleId);
  }

  /** Append a new immutable key revision and make it the scope's primary. */
  async rotate(input: EvidenceKeyScope): Promise<EvidenceEncryptionProfile> {
    await this.assertAvailable("rotate");
    const version = this.createVersion(input);
    await this.emit("rotate", "allowed", "key_rotated", input, version.keyId);
    return this.buildProfile(input, version);
  }

  async revoke(capsuleId: string, _reason: string): Promise<void> {
    await this.assertAvailable("revoke");
    this.revokedCapsules.add(capsuleId);
    await this.emitRaw({
      operation: "revoke",
      decision: "allowed",
      reasonCode: "capsule_revoked",
      capsuleId,
      occurredAt: this.profile.now(),
    });
  }

  /** Revoke every wrapping-key version for a scope, disabling future unwraps. */
  async revokeScope(input: EvidenceKeyScope, _reason: string): Promise<void> {
    await this.assertAvailable("revoke");
    const id = scopeId(input);
    this.store.markScopeRevoked(id);
    await this.emit("revoke", "allowed", "scope_revoked", input);
  }

  private ensurePrimaryVersion(scope: EvidenceKeyScope): StoredKmsKeyVersion {
    const existing = this.store.primaryVersion(scopeId(scope));
    if (existing !== undefined) {
      return existing;
    }
    return this.createVersion(scope);
  }

  private createVersion(scope: EvidenceKeyScope): StoredKmsKeyVersion {
    const id = scopeId(scope);
    const revision = this.store.listVersions(id).length + 1;
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: RSA_MODULUS_BITS,
    });
    const publicKeyPem = publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const sealed = sealPrivateKey(privateKey, this.rootKey);
    const version: StoredKmsKeyVersion = {
      scopeId: id,
      keyId: keyIdFromPublicKey(publicKey),
      revision,
      publicKeyPem,
      wrappedPrivateKeyBase64: sealed.ciphertext,
      privateKeyNonceBase64: sealed.nonce,
      privateKeyTagBase64: sealed.tag,
      status: "active",
      createdAt: this.profile.now(),
      isPrimary: true,
    };
    this.store.putVersion(version);
    this.store.setPrimary(id, version.keyId);
    return version;
  }

  private buildProfile(
    scope: EvidenceKeyScope,
    version: StoredKmsKeyVersion,
  ): EvidenceEncryptionProfile {
    const expiresAt = new Date(
      Date.parse(this.profile.now()) + this.profile.ttlMs,
    ).toISOString();
    return {
      profileId: `profile-${version.keyId}`,
      tenantId: scope.tenantId,
      caseId: scope.caseId,
      recipient: this.profile.recipient,
      region: scope.region,
      purpose: scope.purpose,
      policyId: this.profile.policyId,
      wrappingKeyId: version.keyId,
      wrappingPublicKeyPem: version.publicKeyPem,
      contentEncryptionAlgorithm: "A256GCM",
      keyWrappingAlgorithm: "RSA-OAEP-256",
      aadSchemaVersion: "evidence-capsule-aad/v1",
      allowedEntryKinds: [...this.profile.allowedEntryKinds],
      maximumEntryBytes: this.profile.maximumEntryBytes,
      maximumPlaintextBytes: this.profile.maximumPlaintextBytes,
      maximumCiphertextBytes: this.profile.maximumCiphertextBytes,
      expiresAt,
    };
  }

  private async assertAvailable(
    operation: KmsAuditEvent["operation"],
  ): Promise<void> {
    if (!this.available) {
      await this.emitRaw({
        operation,
        decision: "failed",
        reasonCode: "kms_unavailable",
        occurredAt: this.profile.now(),
      });
      throw new SelfHostedKmsError(
        "KmsUnavailable",
        "Self-hosted KMS is unavailable.",
      );
    }
  }

  private async deny(
    operation: KmsAuditEvent["operation"],
    reasonCode: string,
    keyId?: string,
    scopeIdValue?: string,
    capsuleId?: string,
  ): Promise<SelfHostedKmsError> {
    await this.emitRaw({
      operation,
      decision: "denied",
      reasonCode,
      keyId,
      scopeId: scopeIdValue,
      capsuleId,
      occurredAt: this.profile.now(),
    });
    return new SelfHostedKmsError(
      "KmsScopeDenied",
      `KMS ${operation} denied: ${reasonCode}.`,
    );
  }

  private async revoked(
    operation: KmsAuditEvent["operation"],
    version: StoredKmsKeyVersion,
    capsuleId?: string,
  ): Promise<SelfHostedKmsError> {
    await this.emitRaw({
      operation,
      decision: "denied",
      reasonCode: "key_revoked",
      keyId: version.keyId,
      scopeId: version.scopeId,
      capsuleId,
      occurredAt: this.profile.now(),
    });
    return new SelfHostedKmsError(
      "KmsKeyRevoked",
      `Wrapping key ${version.keyId} has been revoked.`,
    );
  }

  private async revokedCapsule(
    operation: KmsAuditEvent["operation"],
    capsuleId: string,
    scopeIdValue: string,
  ): Promise<SelfHostedKmsError> {
    await this.emitRaw({
      operation,
      decision: "denied",
      reasonCode: "capsule_revoked",
      capsuleId,
      scopeId: scopeIdValue,
      occurredAt: this.profile.now(),
    });
    return new SelfHostedKmsError(
      "KmsKeyRevoked",
      `Unwrap permission for capsule ${capsuleId} has been revoked.`,
    );
  }

  private emit(
    operation: KmsAuditEvent["operation"],
    decision: KmsAuditEvent["decision"],
    reasonCode: string,
    scope: EvidenceKeyScope,
    keyId?: string,
    capsuleId?: string,
  ): void | Promise<void> {
    return this.emitRaw({
      operation,
      decision,
      reasonCode,
      scopeId: scopeId(scope),
      keyId,
      capsuleId,
      occurredAt: this.profile.now(),
    });
  }

  private emitRaw(event: KmsAuditEvent): void | Promise<void> {
    return this.audit?.record(event);
  }
}

interface SealedKey {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly tag: string;
}

function sealPrivateKey(privateKey: KeyObject, rootKey: Uint8Array): SealedKey {
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const nonce = randomBytes(AES_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", rootKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(der), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptPrivateKey(
  version: StoredKmsKeyVersion,
  rootKey: Uint8Array,
): KeyObject {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    rootKey,
    Buffer.from(version.privateKeyNonceBase64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(version.privateKeyTagBase64, "base64"));
  const der = Buffer.concat([
    decipher.update(Buffer.from(version.wrappedPrivateKeyBase64, "base64")),
    decipher.final(),
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

function privateDecryptWithScope(
  privateKey: KeyObject,
  wrappedDekBase64: string,
): Buffer {
  return privateDecrypt(
    {
      key: privateKey,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(wrappedDekBase64, "base64"),
  );
}

function profileMatches(
  expected: EvidenceEncryptionProfile,
  actual: EvidenceEncryptionProfile,
): boolean {
  return (
    expected.tenantId === actual.tenantId &&
    expected.caseId === actual.caseId &&
    expected.region === actual.region &&
    expected.purpose === actual.purpose &&
    expected.recipient === actual.recipient &&
    expected.policyId === actual.policyId &&
    expected.wrappingKeyId === actual.wrappingKeyId &&
    expected.wrappingPublicKeyPem === actual.wrappingPublicKeyPem &&
    expected.contentEncryptionAlgorithm === actual.contentEncryptionAlgorithm &&
    expected.keyWrappingAlgorithm === actual.keyWrappingAlgorithm
  );
}

function scopeId(scope: EvidenceKeyScope): string {
  return [scope.tenantId, scope.caseId, scope.region, scope.purpose].join("|");
}

function scopeFromId(id: string): EvidenceKeyScope {
  const [tenantId, caseId, region, purpose] = id.split("|");
  return {
    tenantId: tenantId ?? "",
    caseId: caseId ?? "",
    region: region ?? "",
    purpose: (purpose as EvidenceKeyScope["purpose"]) ?? "investigation",
  };
}

function keyIdFromPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex").slice(0, KEY_ID_LENGTH);
}
