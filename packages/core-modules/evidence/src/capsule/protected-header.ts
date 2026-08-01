import { createHash } from "node:crypto";
import type {
  EvidenceCapsuleProtectedHeader,
  EvidenceEncryptionProfile,
} from "./contracts.js";

/**
 * A JSON value restricted to what RFC 8785 canonicalization supports here. The
 * protected header contains only strings and integers, so this narrow subset is
 * sufficient and deterministic.
 */
type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/**
 * Deterministic RFC 8785-style JSON: object keys sorted lexicographically,
 * arrays in order, `undefined` entries dropped, integers serialized by
 * `JSON.stringify`. Two semantically equal headers always produce identical
 * bytes regardless of source key order.
 */
function canonicalJson(value: unknown): string {
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
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new TypeError(`Value of type ${typeof value} is not canonicalizable.`);
}

/**
 * The canonical UTF-8 bytes of a protected header. These bytes are the ONLY
 * AES-GCM AAD, so any change to any header field changes the AAD and fails
 * decryption.
 */
export function canonicalProtectedHeaderBytes(
  header: EvidenceCapsuleProtectedHeader,
): Buffer {
  return Buffer.from(canonicalJson(header), "utf8");
}

/** Hex SHA-256 of the canonical protected-header bytes (for audit/index use). */
export function protectedHeaderSha256(
  header: EvidenceCapsuleProtectedHeader,
): string {
  return createHash("sha256")
    .update(canonicalProtectedHeaderBytes(header))
    .digest("hex");
}

/** Server-issued, non-profile fields for a Capsule. */
export interface ProtectedHeaderServerFields {
  readonly capsuleId: string;
  readonly createdAt: string;
  readonly plaintextSha256: string;
  readonly plaintextBytes: number;
}

/**
 * Build the protected header ONLY from the authenticated profile plus
 * server-issued Capsule id/timestamps/plaintext digest. No caller-supplied
 * value can override a profile-bound field, because nothing else is read.
 */
export function headerFromProfile(
  profile: EvidenceEncryptionProfile,
  server: ProtectedHeaderServerFields,
): EvidenceCapsuleProtectedHeader {
  return {
    schemaVersion: profile.aadSchemaVersion,
    capsuleId: server.capsuleId,
    profileId: profile.profileId,
    payloadSchemaVersion: "evidence-capsule/v1",
    tenantId: profile.tenantId,
    caseId: profile.caseId,
    recipient: profile.recipient,
    region: profile.region,
    purpose: profile.purpose,
    policyId: profile.policyId,
    contentEncryptionAlgorithm: profile.contentEncryptionAlgorithm,
    keyWrappingAlgorithm: profile.keyWrappingAlgorithm,
    wrappingKeyId: profile.wrappingKeyId,
    plaintextSha256: server.plaintextSha256,
    plaintextBytes: server.plaintextBytes,
    createdAt: server.createdAt,
    expiresAt: profile.expiresAt,
  };
}

/** Canonical UTF-8 bytes of an arbitrary JSON-serializable Payload. */
export function canonicalPayloadBytes(payload: unknown): Buffer {
  return Buffer.from(canonicalJson(payload), "utf8");
}
