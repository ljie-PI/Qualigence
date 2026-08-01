import { createHash } from "node:crypto";
import type { ProcedureSkillVersion } from "./skill-types.js";

/** A JSON value restricted to what canonicalization supports. */
export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/**
 * Deterministic JSON serialization: object keys are sorted, arrays keep order,
 * and `undefined` object entries are dropped. Used for every hash and signature
 * so that byte-identical content always produces byte-identical bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): CanonicalJsonValue {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) {
        continue;
      }
      result[key] = canonicalize(entry);
    }
    return result;
  }
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  throw new TypeError(`Value of type ${typeof value} is not canonicalizable.`);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Stable digest of a Skill version's compiled content, excluding volatile
 * lifecycle fields (`version`, `state`) and the digest itself. Two versions with
 * identical compiled content share a `contentSha256`.
 */
export function skillContentSha256(
  content: Omit<ProcedureSkillVersion, "version" | "state" | "contentSha256">,
): string {
  return sha256Hex(canonicalJson(content));
}

export interface SkillBundleManifest {
  readonly bundleId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly schemaVersion: "skill-bundle/v1";
  readonly compilerVersion: string;
  readonly contentSha256: string;
  readonly signerKeyId: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly signatureBase64: string;
  readonly issuedAt: string;
  readonly expiresAt?: string;
}

/**
 * A Bundle before a signature is attached. It carries the full Skill payload and
 * every manifest field except the signature bytes.
 */
export interface UnsignedSkillBundle {
  readonly bundleId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly schemaVersion: "skill-bundle/v1";
  readonly compilerVersion: string;
  readonly contentSha256: string;
  readonly signerKeyId: string;
  readonly signatureAlgorithm: "Ed25519";
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly payload: ProcedureSkillVersion;
}

/** A signed Bundle: the manifest plus the Skill payload it authenticates. */
export interface SignedSkillBundle {
  readonly manifest: SkillBundleManifest;
  readonly payload: ProcedureSkillVersion;
}

/**
 * The canonical byte string a signature covers: every manifest field except the
 * signature bytes, plus the Skill payload hash (`contentSha256`). Flipping any
 * manifest byte or the key id changes these bytes and invalidates the signature.
 */
export function canonicalSigningPayload(bundle: UnsignedSkillBundle): Buffer {
  const signable = {
    bundleId: bundle.bundleId,
    skillId: bundle.skillId,
    skillVersion: bundle.skillVersion,
    schemaVersion: bundle.schemaVersion,
    compilerVersion: bundle.compilerVersion,
    contentSha256: bundle.contentSha256,
    signerKeyId: bundle.signerKeyId,
    signatureAlgorithm: bundle.signatureAlgorithm,
    issuedAt: bundle.issuedAt,
    ...(bundle.expiresAt === undefined ? {} : { expiresAt: bundle.expiresAt }),
  };
  return Buffer.from(canonicalJson(signable), "utf8");
}

/** Recompute the content hash of a Bundle's payload for integrity checks. */
export function bundlePayloadContentSha256(
  payload: ProcedureSkillVersion,
): string {
  const { version: _version, state: _state, contentSha256: _hash, ...content } =
    payload;
  return skillContentSha256(content);
}
