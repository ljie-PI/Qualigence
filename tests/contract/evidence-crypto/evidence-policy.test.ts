import { describe, expect, it, beforeEach } from "vitest";
import {
  decodeCapsuleEntry,
  EvidenceEnvelopeEncryptor,
  type EvidenceAuditEvent,
  type EvidenceAuditSink,
  type EvidenceDecryptionContext,
  type EvidenceEncryptionProfile,
  type EvidenceKeyScope,
} from "@qualigence/evidence";
import { InMemoryTestKms } from "@qualigence/kms-self-hosted";
import {
  EvidenceCapsuleBuilder,
  type CapsuleContentItem,
} from "@qualigence/evidence-capsule";

class RecordingAuditSink implements EvidenceAuditSink {
  readonly events: EvidenceAuditEvent[] = [];
  record(event: EvidenceAuditEvent): void {
    this.events.push(event);
  }
}

const SCOPE: EvidenceKeyScope = {
  tenantId: "tenant-a",
  caseId: "case-1",
  region: "eu-local",
  purpose: "investigation",
};

function makeClock(start = "2026-08-01T00:00:00.000Z") {
  let value = start;
  return {
    now: () => value,
    set: (next: string) => {
      value = next;
    },
  };
}

function newSetup(options?: {
  readonly kmsOptions?: ConstructorParameters<typeof InMemoryTestKms>[0];
  readonly clock?: ReturnType<typeof makeClock>;
}) {
  const clock = options?.clock ?? makeClock();
  const kms = new InMemoryTestKms({
    ttlMs: 60 * 60 * 1000,
    now: clock.now,
    ...options?.kmsOptions,
  });
  const audit = new RecordingAuditSink();
  const encryptor = new EvidenceEnvelopeEncryptor({
    kms,
    audit,
    clock: { now: clock.now },
  });
  const builder = new EvidenceCapsuleBuilder(encryptor);
  return { clock, kms, audit, encryptor, builder };
}

function ctxFor(profile: EvidenceEncryptionProfile): EvidenceDecryptionContext {
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

const traceItem: CapsuleContentItem = {
  kind: "trace",
  mediaType: "application/json",
  bytes: Buffer.from('{"step":1}', "utf8"),
};

describe("evidence capsule build policy", () => {
  it("builds a local-only record with no manifest, ciphertext or wrapped DEK", async () => {
    const { builder } = newSetup();
    const result = await builder.build({
      disposition: "local",
      tenantId: SCOPE.tenantId,
      caseId: SCOPE.caseId,
      runId: "run-1",
      reason: "policy_disallows_upload",
      localContentRefs: ["artifact://local/1"],
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
    });
    expect(result).toMatchObject({
      disposition: "local_only",
      record: { disposition: "local_only", reason: "policy_disallows_upload" },
    });
    expect(result).not.toHaveProperty("manifest");
    expect(result).not.toHaveProperty("ciphertext");
    expect(JSON.stringify(result)).not.toContain("wrappedDek");
  });

  it("builds a remote capsule whose bytes round-trip after source deletion", async () => {
    const { builder, encryptor, kms } = newSetup();
    const profile = await kms.encryptionProfile(SCOPE);
    let source: Uint8Array | undefined = Buffer.from([9, 8, 7, 6, 5]);
    const result = await builder.build({
      disposition: "remote",
      runId: "run-1",
      profile,
      items: [
        { kind: "screenshot", mediaType: "image/png", bytes: source },
        traceItem,
      ],
      context: {
        actorType: "service",
        actorId: "runner-1",
        correlationId: "corr-1",
        capsuleId: "capsule-1",
      },
    });
    expect(result.disposition).toBe("remote_capsule");
    if (result.disposition !== "remote_capsule") return;

    const originalShot = Buffer.from(source);
    source = undefined; // drop the local source

    const recovered = await encryptor.decrypt(
      { manifest: result.manifest, ciphertext: result.ciphertext },
      ctxFor(profile),
    );
    const shot = recovered.entries.find((e) => e.kind === "screenshot");
    expect(decodeCapsuleEntry(shot!)).toEqual(originalShot);
  });

  it("rejects a disallowed entry kind", async () => {
    const { builder, kms } = newSetup({
      kmsOptions: { allowedEntryKinds: ["trace"] },
    });
    const profile = await kms.encryptionProfile(SCOPE);
    await expect(
      builder.build({
        disposition: "remote",
        runId: "run-1",
        profile,
        items: [{ kind: "screenshot", mediaType: "image/png", bytes: Buffer.from([1]) }],
        context: { actorType: "service", actorId: "r", correlationId: "c" },
      }),
    ).rejects.toMatchObject({ code: "EvidenceKindNotAllowed" });
  });

  it("rejects an entry that exceeds the per-entry byte limit", async () => {
    const { builder, kms } = newSetup({
      kmsOptions: { maximumEntryBytes: 4 },
    });
    const profile = await kms.encryptionProfile(SCOPE);
    await expect(
      builder.build({
        disposition: "remote",
        runId: "run-1",
        profile,
        items: [{ kind: "trace", mediaType: "application/json", bytes: Buffer.from([1, 2, 3, 4, 5]) }],
        context: { actorType: "service", actorId: "r", correlationId: "c" },
      }),
    ).rejects.toMatchObject({ code: "EvidenceEntryLimitExceeded" });
  });

  it("rejects when the total plaintext exceeds the limit", async () => {
    const { builder, kms } = newSetup({
      kmsOptions: { maximumEntryBytes: 100, maximumPlaintextBytes: 6 },
    });
    const profile = await kms.encryptionProfile(SCOPE);
    await expect(
      builder.build({
        disposition: "remote",
        runId: "run-1",
        profile,
        items: [
          { kind: "trace", mediaType: "application/json", bytes: Buffer.from([1, 2, 3, 4]) },
          { kind: "trace", mediaType: "application/json", bytes: Buffer.from([5, 6, 7, 8]) },
        ],
        context: { actorType: "service", actorId: "r", correlationId: "c" },
      }),
    ).rejects.toMatchObject({ code: "EvidenceEntryLimitExceeded" });
  });

  it("binds every protected-header field to the profile, ignoring caller values", async () => {
    const { encryptor, kms } = newSetup();
    const profile = await kms.encryptionProfile(SCOPE);
    const encrypted = await encryptor.encrypt(
      {
        schemaVersion: "evidence-capsule/v1",
        runId: "run-1",
        entries: [],
      },
      profile,
      { actorType: "service", actorId: "r", correlationId: "c" },
    );
    const header = encrypted.manifest.protectedHeader;
    expect(header.tenantId).toBe(profile.tenantId);
    expect(header.caseId).toBe(profile.caseId);
    expect(header.recipient).toBe(profile.recipient);
    expect(header.region).toBe(profile.region);
    expect(header.policyId).toBe(profile.policyId);
    expect(header.wrappingKeyId).toBe(profile.wrappingKeyId);
    expect(header.contentEncryptionAlgorithm).toBe("A256GCM");
    expect(header.keyWrappingAlgorithm).toBe("RSA-OAEP-256");
    expect(header.expiresAt).toBe(profile.expiresAt);
  });

  it("refuses to encrypt or decrypt when the KMS is unavailable", async () => {
    const { encryptor, kms } = newSetup();
    const profile = await kms.encryptionProfile(SCOPE);
    const encrypted = await encryptor.encrypt(
      { schemaVersion: "evidence-capsule/v1", runId: "run-1", entries: [] },
      profile,
      { actorType: "service", actorId: "r", correlationId: "c" },
    );
    kms.setAvailable(false);
    await expect(
      encryptor.decrypt(
        { manifest: encrypted.manifest, ciphertext: encrypted.ciphertext },
        ctxFor(profile),
      ),
    ).rejects.toMatchObject({ code: "EvidenceLimited" });
  });

  it("rejects an expired capsule and audits the denial", async () => {
    const clock = makeClock();
    const { encryptor, kms, audit } = newSetup({ clock });
    const profile = await kms.encryptionProfile(SCOPE);
    const encrypted = await encryptor.encrypt(
      { schemaVersion: "evidence-capsule/v1", runId: "run-1", entries: [] },
      profile,
      { actorType: "service", actorId: "r", correlationId: "c" },
    );
    clock.set("2027-01-01T00:00:00.000Z");
    await expect(
      encryptor.decrypt(
        { manifest: encrypted.manifest, ciphertext: encrypted.ciphertext },
        ctxFor(profile),
      ),
    ).rejects.toMatchObject({ code: "EvidenceExpired" });
    expect(audit.events.at(-1)).toMatchObject({
      operation: "unwrap",
      decision: "denied",
      reasonCode: "EvidenceExpired",
    });
  });

  it("rejects unwrap after the capsule's unwrap permission is revoked", async () => {
    const { encryptor, kms } = newSetup();
    const profile = await kms.encryptionProfile(SCOPE);
    const encrypted = await encryptor.encrypt(
      { schemaVersion: "evidence-capsule/v1", runId: "run-1", entries: [] },
      profile,
      { actorType: "service", actorId: "r", correlationId: "c", capsuleId: "capsule-x" },
    );
    await kms.revoke("capsule-x", "ttl_expired");
    await expect(
      encryptor.decrypt(
        { manifest: encrypted.manifest, ciphertext: encrypted.ciphertext },
        ctxFor(profile),
      ),
    ).rejects.toMatchObject({ code: "EvidenceKeyRevoked" });
  });
});
