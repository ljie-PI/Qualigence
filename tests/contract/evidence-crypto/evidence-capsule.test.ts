import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import {
  canonicalProtectedHeaderBytes,
  decodeCapsuleEntry,
  encodeCapsuleEntry,
  EvidenceCapsuleError,
  EvidenceEnvelopeEncryptor,
  type EvidenceAuditEvent,
  type EvidenceAuditSink,
  type EvidenceCapsulePayload,
  type EvidenceCapsuleProtectedHeader,
  type EvidenceDecryptionContext,
  type EvidenceEncryptionProfile,
  type EvidenceKeyScope,
  type EncryptedCapsule,
} from "@qualigence/evidence";
import { InMemoryTestKms } from "@qualigence/kms-self-hosted";

class RecordingAuditSink implements EvidenceAuditSink {
  readonly events: EvidenceAuditEvent[] = [];
  record(event: EvidenceAuditEvent): void {
    this.events.push(event);
  }
}

const SCOPE_A: EvidenceKeyScope = {
  tenantId: "tenant-a",
  caseId: "case-1",
  region: "eu-local",
  purpose: "investigation",
};

function makeClock(): { now: () => string; set: (value: string) => void } {
  let value = "2026-08-01T00:00:00.000Z";
  return {
    now: () => value,
    set: (next: string) => {
      value = next;
    },
  };
}

interface Harness {
  readonly kms: InMemoryTestKms;
  readonly encryptor: EvidenceEnvelopeEncryptor;
  readonly audit: RecordingAuditSink;
  readonly clock: ReturnType<typeof makeClock>;
}

function newHarness(): Harness {
  const clock = makeClock();
  const kms = new InMemoryTestKms({ ttlMs: 60 * 60 * 1000, now: clock.now });
  const audit = new RecordingAuditSink();
  const encryptor = new EvidenceEnvelopeEncryptor({
    kms,
    audit,
    clock: { now: clock.now },
  });
  return { kms, encryptor, audit, clock };
}

const SCREENSHOT_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);

function samplePayload(): EvidenceCapsulePayload {
  return {
    schemaVersion: "evidence-capsule/v1",
    runId: "run-1",
    entries: [
      encodeCapsuleEntry({
        kind: "trace",
        mediaType: "application/json",
        bytes: Buffer.from('{"steps":[1,2,3]}', "utf8"),
        entryId: "entry-trace",
      }),
      encodeCapsuleEntry({
        kind: "screenshot",
        mediaType: "image/png",
        bytes: SCREENSHOT_BYTES,
        entryId: "entry-shot",
      }),
    ],
  };
}

function authorizedContext(
  profile: EvidenceEncryptionProfile,
): EvidenceDecryptionContext {
  return {
    actorType: "service",
    actorId: "worker-1",
    correlationId: "corr-1",
    tenantId: profile.tenantId,
    caseId: profile.caseId,
    recipient: profile.recipient,
    region: profile.region,
    purpose: "investigation",
    policyId: profile.policyId,
  };
}

describe("evidence capsule envelope crypto", () => {
  let h: Harness;
  let profile: EvidenceEncryptionProfile;
  let encrypted: EncryptedCapsule;

  beforeEach(async () => {
    h = newHarness();
    profile = await h.kms.encryptionProfile(SCOPE_A);
    encrypted = await h.encryptor.encrypt(samplePayload(), profile, {
      actorType: "service",
      actorId: "runner-1",
      correlationId: "corr-1",
      capsuleId: "capsule-1",
    });
  });

  it("round-trips an allowed capsule and audits wrap+unwrap", async () => {
    const recovered = await h.encryptor.decrypt(
      encrypted,
      authorizedContext(profile),
    );
    expect(recovered).toEqual(samplePayload());

    const wrap = h.audit.events.find((e) => e.operation === "wrap");
    const unwrap = h.audit.events.find((e) => e.operation === "unwrap");
    expect(wrap).toMatchObject({ decision: "allowed", capsuleId: "capsule-1" });
    expect(unwrap).toMatchObject({
      decision: "allowed",
      capsuleId: "capsule-1",
      actorId: "worker-1",
      keyVersion: profile.wrappingKeyId,
    });
  });

  it("uses distinct 12-byte nonces and 16-byte tags per capsule", async () => {
    const second = await h.encryptor.encrypt(samplePayload(), profile, {
      actorType: "service",
      actorId: "runner-1",
      correlationId: "corr-2",
      capsuleId: "capsule-2",
    });
    expect(encrypted.manifest.nonceBase64).not.toEqual(
      second.manifest.nonceBase64,
    );
    expect(Buffer.from(encrypted.manifest.nonceBase64, "base64")).toHaveLength(
      12,
    );
    expect(
      Buffer.from(encrypted.manifest.authTagBase64, "base64"),
    ).toHaveLength(16);
  });

  it("canonicalizes semantically equal headers to identical bytes", () => {
    const header = encrypted.manifest.protectedHeader;
    const reordered = reorderKeys(header);
    expect(canonicalProtectedHeaderBytes(reordered)).toEqual(
      canonicalProtectedHeaderBytes(header),
    );
  });

  it("rejects a flipped ciphertext byte before returning plaintext", async () => {
    const tampered = tamperCiphertext(encrypted);
    await expect(
      h.encryptor.decrypt(tampered, authorizedContext(profile)),
    ).rejects.toMatchObject({ code: "EvidenceIntegrityViolation" });
    expect(lastUnwrap(h.audit)).toMatchObject({ decision: "denied" });
  });

  it("rejects a flipped auth tag", async () => {
    const tag = Buffer.from(encrypted.manifest.authTagBase64, "base64");
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    const tampered: EncryptedCapsule = {
      ciphertext: encrypted.ciphertext,
      manifest: {
        ...encrypted.manifest,
        authTagBase64: tag.toString("base64"),
      },
    };
    await expect(
      h.encryptor.decrypt(tampered, authorizedContext(profile)),
    ).rejects.toMatchObject({ code: "EvidenceIntegrityViolation" });
  });

  it("rejects a mutated protected-header AAD field", async () => {
    const tampered: EncryptedCapsule = {
      ciphertext: encrypted.ciphertext,
      manifest: {
        ...encrypted.manifest,
        protectedHeader: {
          ...encrypted.manifest.protectedHeader,
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      },
    };
    await expect(
      h.encryptor.decrypt(tampered, authorizedContext(profile)),
    ).rejects.toMatchObject({ code: "EvidenceIntegrityViolation" });
  });

  it("rejects a flipped wrapped DEK", async () => {
    const wrapped = Buffer.from(encrypted.manifest.wrappedDekBase64, "base64");
    wrapped[0] = (wrapped[0] ?? 0) ^ 0xff;
    const tampered: EncryptedCapsule = {
      ciphertext: encrypted.ciphertext,
      manifest: {
        ...encrypted.manifest,
        wrappedDekBase64: wrapped.toString("base64"),
      },
    };
    await expect(
      h.encryptor.decrypt(tampered, authorizedContext(profile)),
    ).rejects.toMatchObject({ code: "EvidenceIntegrityViolation" });
    expect(lastUnwrap(h.audit)).toMatchObject({ decision: "denied" });
  });

  it("denies a wrong-scope authenticated context and audits it", async () => {
    const wrongTenant: EvidenceDecryptionContext = {
      ...authorizedContext(profile),
      tenantId: "tenant-b",
    };
    await expect(
      h.encryptor.decrypt(encrypted, wrongTenant),
    ).rejects.toMatchObject({ code: "EvidenceScopeMismatch" });
    expect(lastUnwrap(h.audit)).toMatchObject({
      decision: "denied",
      reasonCode: "EvidenceScopeMismatch",
    });
  });

  it("cryptographically prevents unwrapping the DEK under a different scope", async () => {
    const scopeB: EvidenceKeyScope = { ...SCOPE_A, caseId: "case-2" };
    await h.kms.encryptionProfile(scopeB);
    await expect(
      h.kms.unwrapDek({ manifest: encrypted.manifest, ...scopeB }),
    ).rejects.toMatchObject({ code: "EvidenceIntegrityViolation" });
  });

  it("cannot relabel a capsule to another scope to unwrap it", async () => {
    const scopeB: EvidenceKeyScope = { ...SCOPE_A, caseId: "case-2" };
    await h.kms.encryptionProfile(scopeB);
    const relabeled: EncryptedCapsule = {
      ciphertext: encrypted.ciphertext,
      manifest: {
        ...encrypted.manifest,
        protectedHeader: {
          ...encrypted.manifest.protectedHeader,
          caseId: "case-2",
        },
      },
    };
    await expect(
      h.encryptor.decrypt(relabeled, {
        ...authorizedContext(profile),
        caseId: "case-2",
      }),
    ).rejects.toBeInstanceOf(EvidenceCapsuleError);
  });

  it("recovers screenshot bytes offline after the local source is gone", async () => {
    const recovered = await h.encryptor.decrypt(
      encrypted,
      authorizedContext(profile),
    );
    const shot = recovered.entries.find((e) => e.kind === "screenshot");
    expect(shot).toBeDefined();
    expect(decodeCapsuleEntry(shot!)).toEqual(SCREENSHOT_BYTES);
  });
});

function reorderKeys(
  header: EvidenceCapsuleProtectedHeader,
): EvidenceCapsuleProtectedHeader {
  const entries = Object.entries(header).reverse();
  return Object.fromEntries(
    entries,
  ) as unknown as EvidenceCapsuleProtectedHeader;
}

function tamperCiphertext(encrypted: EncryptedCapsule): EncryptedCapsule {
  const bytes = Buffer.from(encrypted.ciphertext);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    ciphertext: bytes,
    manifest: { ...encrypted.manifest, ciphertextSha256: digest },
  };
}

function lastUnwrap(audit: RecordingAuditSink): EvidenceAuditEvent | undefined {
  return [...audit.events].reverse().find((e) => e.operation === "unwrap");
}
