import { randomUUID } from "node:crypto";
import {
  encodeCapsuleEntry,
  EvidenceCapsuleError,
  type EvidenceCapsuleBuildResult,
  type EvidenceCapsuleEntry,
  type EvidenceCapsuleEntryKind,
  type EvidenceCapsuleMediaType,
  type EvidenceCapsulePayload,
  type EvidenceEncryptionProfile,
  type LocalOnlyEvidenceRecord,
} from "@qualigence/evidence";
import {
  EvidenceEnvelopeEncryptor,
  type EncryptCapsuleContext,
} from "@qualigence/evidence";

/** One selected piece of evidence, with its actual bytes, before redaction. */
export interface CapsuleContentItem {
  readonly kind: EvidenceCapsuleEntryKind;
  readonly mediaType: EvidenceCapsuleMediaType;
  readonly bytes: Uint8Array;
  readonly entryId?: string;
}

/** A redactor removes sensitive bytes before the content is bounded/encoded. */
export type CapsuleRedactor = (item: CapsuleContentItem) => Uint8Array;

/** Build a scope-bound, uploadable remote Capsule from selected content. */
export interface RemoteCapsuleBuildInput {
  readonly disposition: "remote";
  readonly runId: string;
  readonly profile: EvidenceEncryptionProfile;
  readonly items: readonly CapsuleContentItem[];
  readonly context: EncryptCapsuleContext;
  readonly redactor?: CapsuleRedactor;
}

/** Build an explicit, non-uploadable local-only record. */
export interface LocalOnlyBuildInput {
  readonly disposition: "local";
  readonly tenantId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly reason: string;
  readonly localContentRefs: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly localRecordId?: string;
}

export type CapsuleBuildInput = RemoteCapsuleBuildInput | LocalOnlyBuildInput;

/**
 * Selects, redacts and bounds the actual evidence bytes, then either encrypts a
 * remote Capsule or returns an explicit local-only record. All bounds
 * (allowed kinds, per-entry, total plaintext and total ciphertext) are enforced
 * against the freshly recomputed byte counts — a caller-declared size is never
 * trusted — before allocation or upload.
 */
export class EvidenceCapsuleBuilder {
  private readonly encryptor: EvidenceEnvelopeEncryptor;

  constructor(encryptor: EvidenceEnvelopeEncryptor) {
    this.encryptor = encryptor;
  }

  async build(input: CapsuleBuildInput): Promise<EvidenceCapsuleBuildResult> {
    if (input.disposition === "local") {
      return this.buildLocalOnly(input);
    }
    return this.buildRemote(input);
  }

  private buildLocalOnly(
    input: LocalOnlyBuildInput,
  ): EvidenceCapsuleBuildResult {
    const record: LocalOnlyEvidenceRecord = {
      localRecordId: input.localRecordId ?? randomUUID(),
      tenantId: input.tenantId,
      caseId: input.caseId,
      runId: input.runId,
      disposition: "local_only",
      reason: input.reason,
      localContentRefs: [...input.localContentRefs],
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    };
    return { disposition: "local_only", record };
  }

  private async buildRemote(
    input: RemoteCapsuleBuildInput,
  ): Promise<EvidenceCapsuleBuildResult> {
    const { profile } = input;
    const allowed = new Set(profile.allowedEntryKinds);
    const entries: EvidenceCapsuleEntry[] = [];
    let totalPlaintext = 0;

    for (const item of input.items) {
      if (!allowed.has(item.kind)) {
        throw new EvidenceCapsuleError(
          "EvidenceKindNotAllowed",
          `Entry kind ${item.kind} is not allowed by profile ${profile.profileId}.`,
        );
      }
      const redacted = input.redactor ? input.redactor(item) : item.bytes;
      if (redacted.byteLength > profile.maximumEntryBytes) {
        throw new EvidenceCapsuleError(
          "EvidenceEntryLimitExceeded",
          `Entry of ${redacted.byteLength} bytes exceeds the per-entry limit of ${profile.maximumEntryBytes}.`,
        );
      }
      totalPlaintext += redacted.byteLength;
      if (totalPlaintext > profile.maximumPlaintextBytes) {
        throw new EvidenceCapsuleError(
          "EvidenceEntryLimitExceeded",
          `Total plaintext exceeds the limit of ${profile.maximumPlaintextBytes} bytes.`,
        );
      }
      entries.push(
        encodeCapsuleEntry({
          kind: item.kind,
          mediaType: item.mediaType,
          bytes: redacted,
          ...(item.entryId === undefined ? {} : { entryId: item.entryId }),
        }),
      );
    }

    const payload: EvidenceCapsulePayload = {
      schemaVersion: "evidence-capsule/v1",
      runId: input.runId,
      entries,
    };

    const encrypted = await this.encryptor.encrypt(
      payload,
      profile,
      input.context,
    );

    if (encrypted.ciphertext.byteLength > profile.maximumCiphertextBytes) {
      throw new EvidenceCapsuleError(
        "EvidenceEntryLimitExceeded",
        `Ciphertext of ${encrypted.ciphertext.byteLength} bytes exceeds the limit of ${profile.maximumCiphertextBytes}.`,
      );
    }

    return {
      disposition: "remote_capsule",
      manifest: encrypted.manifest,
      ciphertext: encrypted.ciphertext,
    };
  }
}
