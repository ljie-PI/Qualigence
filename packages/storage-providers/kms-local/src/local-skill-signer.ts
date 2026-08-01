import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bundlePayloadContentSha256,
  canonicalSigningPayload,
  SkillSigningError,
} from "@qualigence/skill";
import type {
  SignedSkillBundle,
  SkillBundleManifest,
  SkillSignatureVerification,
  SkillSigner,
  SkillVerificationScope,
  UnsignedSkillBundle,
} from "@qualigence/skill";

const PRIVATE_KEY_FILE = "skill-signing.key";
const PUBLIC_KEY_FILE = "skill-signing.pub";
const KEY_ID_LENGTH = 32;

export interface LocalSkillSignerKeys {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/**
 * A local Ed25519 signing service. The private key lives in the data directory
 * with OS user-only permissions and never enters a Bundle, log, or database. A
 * signing failure raises `SkillSigningFailed`; there is no unsigned fallback.
 */
export class LocalSkillSigner implements SkillSigner {
  readonly keyId: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(keys: LocalSkillSignerKeys) {
    this.keyId = keys.keyId;
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
  }

  /**
   * Load an existing signing key from {@link dataDir} or generate one atomically
   * (user-only permissions). The public key and keyId are safe to publish.
   */
  static open(dataDir: string): LocalSkillSigner {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const privatePath = join(dataDir, PRIVATE_KEY_FILE);
    const publicPath = join(dataDir, PUBLIC_KEY_FILE);

    let privatePem: string;
    try {
      privatePem = readFileSync(privatePath, "utf8");
    } catch {
      privatePem = generateAndPersist(dataDir, privatePath, publicPath);
    }

    const privateKey = createPrivateKey(privatePem);
    const publicKey = createPublicKey(privateKey);
    return new LocalSkillSigner({
      keyId: keyIdFromPublicKey(publicKey),
      privateKey,
      publicKey,
    });
  }

  static generate(): LocalSkillSigner {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return new LocalSkillSigner({
      keyId: keyIdFromPublicKey(publicKey),
      privateKey,
      publicKey,
    });
  }

  async sign(bundle: UnsignedSkillBundle): Promise<SignedSkillBundle> {
    if (bundle.signerKeyId !== this.keyId) {
      throw new SkillSigningError(
        `Bundle signerKeyId ${bundle.signerKeyId} does not match signer key ${this.keyId}.`,
      );
    }
    const payload = canonicalSigningPayload(bundle);
    let signature: Buffer;
    try {
      signature = edSign(null, payload, this.privateKey);
    } catch (cause) {
      throw new SkillSigningError("Ed25519 signing failed.", { cause });
    }

    const manifest: SkillBundleManifest = {
      bundleId: bundle.bundleId,
      skillId: bundle.skillId,
      skillVersion: bundle.skillVersion,
      schemaVersion: bundle.schemaVersion,
      compilerVersion: bundle.compilerVersion,
      contentSha256: bundle.contentSha256,
      signerKeyId: bundle.signerKeyId,
      signatureAlgorithm: "Ed25519",
      signatureBase64: signature.toString("base64"),
      issuedAt: bundle.issuedAt,
      ...(bundle.expiresAt === undefined ? {} : { expiresAt: bundle.expiresAt }),
    };
    return { manifest, payload: bundle.payload };
  }

  async verify(
    bundle: SignedSkillBundle,
    scope: SkillVerificationScope,
  ): Promise<SkillSignatureVerification> {
    const { manifest, payload } = bundle;

    if (manifest.signerKeyId !== this.keyId) {
      return invalid(
        "SkillSignatureInvalid",
        `Bundle was signed by key ${manifest.signerKeyId}, not ${this.keyId}.`,
      );
    }

    const recomputed = bundlePayloadContentSha256(payload);
    if (recomputed !== manifest.contentSha256) {
      return invalid(
        "SkillContentTampered",
        "Bundle payload does not match the manifest content hash.",
      );
    }

    const signable = canonicalSigningPayload(unsignedFrom(manifest, payload));
    let signatureOk = false;
    try {
      signatureOk = edVerify(
        null,
        signable,
        this.publicKey,
        Buffer.from(manifest.signatureBase64, "base64"),
      );
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) {
      return invalid("SkillSignatureInvalid", "Bundle signature is invalid.");
    }

    const scopeResult = checkScope(payload, manifest, scope);
    if (scopeResult !== undefined) {
      return scopeResult;
    }

    return { status: "valid" };
  }
}

function checkScope(
  payload: SignedSkillBundle["payload"],
  manifest: SkillBundleManifest,
  scope: SkillVerificationScope,
): SkillSignatureVerification | undefined {
  if (payload.projectId !== scope.projectId) {
    return invalid(
      "SkillTargetMismatch",
      `Bundle project ${payload.projectId} does not match scope ${scope.projectId}.`,
    );
  }
  if (payload.targetScope.targetId !== scope.targetId) {
    return invalid(
      "SkillTargetMismatch",
      `Bundle target ${payload.targetScope.targetId} does not match scope ${scope.targetId}.`,
    );
  }
  if (
    scope.origin !== undefined &&
    payload.targetScope.allowedOrigins.length > 0 &&
    !payload.targetScope.allowedOrigins.includes(scope.origin)
  ) {
    return invalid(
      "SkillTargetMismatch",
      `Origin ${scope.origin} is not allowed by the Bundle scope.`,
    );
  }
  if (manifest.expiresAt !== undefined && scope.now !== undefined) {
    if (scope.now >= manifest.expiresAt) {
      return invalid(
        "SkillBundleExpired",
        `Bundle expired at ${manifest.expiresAt}.`,
      );
    }
  }
  return undefined;
}

function unsignedFrom(
  manifest: SkillBundleManifest,
  payload: SignedSkillBundle["payload"],
): UnsignedSkillBundle {
  return {
    bundleId: manifest.bundleId,
    skillId: manifest.skillId,
    skillVersion: manifest.skillVersion,
    schemaVersion: manifest.schemaVersion,
    compilerVersion: manifest.compilerVersion,
    contentSha256: manifest.contentSha256,
    signerKeyId: manifest.signerKeyId,
    signatureAlgorithm: manifest.signatureAlgorithm,
    issuedAt: manifest.issuedAt,
    ...(manifest.expiresAt === undefined ? {} : { expiresAt: manifest.expiresAt }),
    payload,
  };
}

function invalid(
  code: Exclude<SkillSignatureVerification, { status: "valid" }>["code"],
  message: string,
): SkillSignatureVerification {
  return { status: "invalid", code, message };
}

function keyIdFromPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex").slice(0, KEY_ID_LENGTH);
}

function generateAndPersist(
  dataDir: string,
  privatePath: string,
  publicPath: string,
): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  writeAtomic(dataDir, privatePath, privatePem, 0o600);
  writeAtomic(dataDir, publicPath, publicPem, 0o644);
  return privatePem;
}

function writeAtomic(
  dataDir: string,
  target: string,
  contents: string,
  mode: number,
): void {
  const tmp = join(dataDir, `.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, contents, { mode });
  renameSync(tmp, target);
}
