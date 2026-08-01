import { createHash, randomBytes } from "node:crypto";
import type { Clock, Instant } from "@qualigence/shared-kernel";

/**
 * An immutable, ingested PRD revision. Offsets used by {@link PrdSourceRef}
 * follow the JavaScript string convention (UTF-16 code units).
 */
export interface PrdDocument {
  readonly prdId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly title: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly ingestedAt: Instant;
}

/**
 * A provenance record citing an exact, byte-offset-addressable range of a
 * specific PRD revision, pinned by the SHA-256 of the quoted substring.
 */
export interface PrdSourceRef {
  readonly prdId: string;
  readonly revision: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly quotedTextSha256: string;
}

export interface CreatePrdInput {
  readonly prdId?: string;
  readonly projectId: string;
  readonly revision?: number;
  readonly title: string;
  readonly content: string;
}

/** SHA-256 hex digest of the UTF-8 encoding of {@link text}. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Generate a UUIDv7 (48-bit millisecond timestamp prefix + random tail).
 * Kept dependency-free so the domain layer imports no infrastructure.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now % 0x1000000000000, 0, 6);
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x70;
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const PrdDocument = {
  /**
   * Assemble a frozen {@link PrdDocument}, deriving the content hash from the
   * exact content string. `prdId` defaults to a fresh UUIDv7 and `revision`
   * defaults to 1; the application service supplies these for revisioning.
   */
  create(input: CreatePrdInput, clock: Clock): PrdDocument {
    return Object.freeze({
      prdId: input.prdId ?? uuidv7(),
      projectId: input.projectId,
      revision: input.revision ?? 1,
      title: input.title,
      content: input.content,
      contentSha256: sha256Hex(input.content),
      ingestedAt: clock.now(),
    });
  },
} as const;

/**
 * Verify that a {@link PrdSourceRef} still addresses the exact quoted text in
 * {@link document}: matching document/revision identity, in-bounds offsets and
 * a hash equal to the SHA-256 of the referenced substring.
 */
export function verifySourceRef(
  document: PrdDocument,
  ref: PrdSourceRef,
): boolean {
  if (ref.prdId !== document.prdId || ref.revision !== document.revision) {
    return false;
  }
  if (!Number.isInteger(ref.startOffset) || !Number.isInteger(ref.endOffset)) {
    return false;
  }
  if (ref.startOffset < 0 || ref.startOffset > ref.endOffset) {
    return false;
  }
  if (ref.endOffset > document.content.length) {
    return false;
  }
  const quoted = document.content.slice(ref.startOffset, ref.endOffset);
  return sha256Hex(quoted) === ref.quotedTextSha256;
}
