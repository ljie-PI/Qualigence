import {
  constants as cryptoConstants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  type KeyObject,
} from "node:crypto";
import {
  EvidenceCapsuleError,
  type EvidenceCapsuleEntryKind,
  type EvidenceEncryptionProfile,
  type EvidenceKeyScope,
  type KeyManagementProvider,
  type RemoteEvidenceCapsuleManifest,
} from "@qualigence/evidence";

const RSA_MODULUS_BITS = 2048;
const KEY_ID_LENGTH = 32;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface ScopeKey {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  status: "active" | "revoked";
}

/** Configuration for the profiles this KMS issues. */
export interface InMemoryTestKmsOptions {
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
 * A real, local-only Key Management provider backed by per-scope RSA keypairs.
 *
 * This is NOT a stub: DEKs are genuinely RSA-OAEP-256 wrapped/unwrapped with
 * Node's `crypto`. The private key is chosen by the AUTHENTICATED request scope
 * (`tenant|case|region|purpose`), never by the manifest's `wrappingKeyId`, so a
 * capsule wrapped for one scope cannot be unwrapped under another scope even
 * with the correct ciphertext — wrong-scope access is cryptographically
 * impossible, not a bypassable permission check.
 *
 * The port is provider-agnostic: a future Self-hosted enterprise KMS can be
 * swapped in behind `KeyManagementProvider` without changing capsule logic.
 */
export class InMemoryTestKms implements KeyManagementProvider {
  private readonly scopes = new Map<string, ScopeKey>();
  private readonly revokedCapsules = new Set<string>();
  private readonly options: Required<
    Omit<InMemoryTestKmsOptions, "now">
  > & { readonly now: () => string };
  private available = true;

  constructor(options: InMemoryTestKmsOptions = {}) {
    this.options = {
      recipient: options.recipient ?? "investigation-worker@local",
      policyId: options.policyId ?? "evidence-policy/local-v1",
      allowedEntryKinds:
        options.allowedEntryKinds ?? [
          "trace",
          "semantic_graph",
          "screenshot",
          "log_summary",
        ],
      maximumEntryBytes: options.maximumEntryBytes ?? 5 * 1024 * 1024,
      maximumPlaintextBytes: options.maximumPlaintextBytes ?? 20 * 1024 * 1024,
      maximumCiphertextBytes:
        options.maximumCiphertextBytes ?? 24 * 1024 * 1024,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  /** Simulate KMS availability for `EvidenceLimited` tests. */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  async encryptionProfile(
    input: EvidenceKeyScope,
  ): Promise<EvidenceEncryptionProfile> {
    this.assertAvailable();
    const scopeKey = this.scopeKey(input);
    const expiresAt = new Date(
      Date.parse(this.options.now()) + this.options.ttlMs,
    ).toISOString();
    return {
      profileId: `profile-${scopeKey.keyId}`,
      tenantId: input.tenantId,
      caseId: input.caseId,
      recipient: this.options.recipient,
      region: input.region,
      purpose: input.purpose,
      policyId: this.options.policyId,
      wrappingKeyId: scopeKey.keyId,
      wrappingPublicKeyPem: scopeKey.publicKeyPem,
      contentEncryptionAlgorithm: "A256GCM",
      keyWrappingAlgorithm: "RSA-OAEP-256",
      aadSchemaVersion: "evidence-capsule-aad/v1",
      allowedEntryKinds: [...this.options.allowedEntryKinds],
      maximumEntryBytes: this.options.maximumEntryBytes,
      maximumPlaintextBytes: this.options.maximumPlaintextBytes,
      maximumCiphertextBytes: this.options.maximumCiphertextBytes,
      expiresAt,
    };
  }

  async wrapDek(
    profile: EvidenceEncryptionProfile,
    dek: Uint8Array,
  ): Promise<string> {
    this.assertAvailable();
    const wrapped = publicEncrypt(
      {
        key: profile.wrappingPublicKeyPem,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(dek),
    );
    return wrapped.toString("base64");
  }

  async unwrapDek(
    input: { readonly manifest: RemoteEvidenceCapsuleManifest } & EvidenceKeyScope,
  ): Promise<Uint8Array> {
    this.assertAvailable();
    const capsuleId = input.manifest.protectedHeader.capsuleId;
    if (this.revokedCapsules.has(capsuleId)) {
      throw new EvidenceCapsuleError(
        "EvidenceKeyRevoked",
        `Unwrap permission for capsule ${capsuleId} has been revoked.`,
      );
    }
    // Select the private key by the AUTHENTICATED request scope only. A wrong
    // scope selects a different (or absent) key and cannot decrypt the DEK.
    const scopeKey = this.scopes.get(scopeId(input));
    if (scopeKey === undefined || scopeKey.status !== "active") {
      throw new EvidenceCapsuleError(
        "EvidenceKeyRevoked",
        `No active wrapping key for the requested scope.`,
      );
    }
    try {
      const dek = privateDecrypt(
        {
          key: scopeKey.privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(input.manifest.wrappedDekBase64, "base64"),
      );
      return new Uint8Array(dek);
    } catch (cause) {
      throw new EvidenceCapsuleError(
        "EvidenceIntegrityViolation",
        "Wrapped DEK could not be unwrapped for the requested scope.",
        { cause },
      );
    }
  }

  async revoke(capsuleId: string, _reason: string): Promise<void> {
    this.revokedCapsules.add(capsuleId);
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new EvidenceCapsuleError(
        "EvidenceLimited",
        "Local KMS is unavailable.",
      );
    }
  }

  private scopeKey(scope: EvidenceKeyScope): ScopeKey {
    const id = scopeId(scope);
    const existing = this.scopes.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: RSA_MODULUS_BITS,
    });
    const publicKeyPem = publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const created: ScopeKey = {
      keyId: keyIdFromPublicKey(publicKey),
      publicKey,
      privateKey,
      publicKeyPem,
      status: "active",
    };
    this.scopes.set(id, created);
    return created;
  }
}

function scopeId(scope: EvidenceKeyScope): string {
  return [scope.tenantId, scope.caseId, scope.region, scope.purpose].join("|");
}

function keyIdFromPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex").slice(0, KEY_ID_LENGTH);
}
