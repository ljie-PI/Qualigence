import { createHash, randomUUID } from "node:crypto";
import {
  EvidenceCapsuleError,
  type EvidenceCapsuleEntry,
  type EvidenceCapsuleEntryKind,
  type EvidenceCapsuleMediaType,
} from "./contracts.js";

/** Hex SHA-256 over raw bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Encode raw selected bytes into an `EvidenceCapsuleEntry`, recomputing the
 * plaintext hash and byte count from the actual bytes (never trusting a
 * caller-supplied length or digest).
 */
export function encodeCapsuleEntry(input: {
  readonly kind: EvidenceCapsuleEntryKind;
  readonly mediaType: EvidenceCapsuleMediaType;
  readonly bytes: Uint8Array;
  readonly entryId?: string;
}): EvidenceCapsuleEntry {
  const bytes = input.bytes;
  return {
    entryId: input.entryId ?? randomUUID(),
    kind: input.kind,
    mediaType: input.mediaType,
    plaintextSha256: sha256Hex(bytes),
    plaintextBytes: bytes.byteLength,
    dataBase64: Buffer.from(bytes).toString("base64"),
  };
}

/** Decode an entry's actual bytes from its base64 payload. */
export function decodeCapsuleEntry(entry: EvidenceCapsuleEntry): Buffer {
  return Buffer.from(entry.dataBase64, "base64");
}

/**
 * Verify an entry's declared hash/size match its decoded bytes. Raises
 * `EvidenceIntegrityViolation` on any mismatch so a tampered Payload can never
 * be returned as valid evidence.
 */
export function verifyCapsuleEntry(entry: EvidenceCapsuleEntry): void {
  const bytes = decodeCapsuleEntry(entry);
  if (bytes.byteLength !== entry.plaintextBytes) {
    throw new EvidenceCapsuleError(
      "EvidenceIntegrityViolation",
      `Entry ${entry.entryId} size ${bytes.byteLength} does not match declared ${entry.plaintextBytes}.`,
    );
  }
  if (sha256Hex(bytes) !== entry.plaintextSha256) {
    throw new EvidenceCapsuleError(
      "EvidenceIntegrityViolation",
      `Entry ${entry.entryId} hash does not match its bytes.`,
    );
  }
}
