import { constants as cryptoConstants, privateDecrypt, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InMemoryKmsKeyStore,
  SelfHostedKms,
  SelfHostedKmsError,
  type KmsAuditEvent,
} from "@qualigence/kms-self-hosted";
import type {
  EvidenceKeyScope,
  RemoteEvidenceCapsuleManifest,
} from "@qualigence/evidence";

const rootKey = new Uint8Array(randomBytes(32));

const scopeA: EvidenceKeyScope = {
  tenantId: "tenant-a",
  caseId: "case-1",
  region: "eu",
  purpose: "investigation",
};

function manifestFor(
  capsuleId: string,
  wrappingKeyId: string,
  wrappedDekBase64: string,
): RemoteEvidenceCapsuleManifest {
  return {
    protectedHeader: {
      schemaVersion: "evidence-capsule-aad/v1",
      capsuleId,
      profileId: "profile",
      payloadSchemaVersion: "evidence-capsule/v1",
      tenantId: "tenant-a",
      caseId: "case-1",
      recipient: "investigation-worker@self-hosted",
      region: "eu",
      purpose: "investigation",
      policyId: "evidence-policy/self-hosted-v1",
      contentEncryptionAlgorithm: "A256GCM",
      keyWrappingAlgorithm: "RSA-OAEP-256",
      wrappingKeyId,
      plaintextSha256: "0".repeat(64),
      plaintextBytes: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-02T00:00:00.000Z",
    },
    ciphertextSha256: "0".repeat(64),
    ciphertextBytes: 1,
    wrappedDekBase64,
    nonceBase64: "",
    authTagBase64: "",
  };
}

function newKms(audit?: KmsAuditEvent[]) {
  const store = new InMemoryKmsKeyStore();
  const kms = new SelfHostedKms({
    rootKey,
    keyStore: store,
    now: () => "2026-08-01T00:00:00.000Z",
    ...(audit
      ? {
          audit: {
            record: (event: KmsAuditEvent) => {
              audit.push(event);
            },
          },
        }
      : {}),
  });
  return { kms, store };
}

describe("SelfHostedKms", () => {
  it("rejects a root key that is not 32 bytes", () => {
    expect(
      () => new SelfHostedKms({ rootKey: new Uint8Array(16) }),
    ).toThrow(SelfHostedKmsError);
  });

  it("publishes a scope-bound RSA-OAEP-256 profile from server policy", async () => {
    const { kms } = newKms();
    const profile = await kms.encryptionProfile(scopeA);
    expect(profile.tenantId).toBe("tenant-a");
    expect(profile.caseId).toBe("case-1");
    expect(profile.region).toBe("eu");
    expect(profile.purpose).toBe("investigation");
    expect(profile.keyWrappingAlgorithm).toBe("RSA-OAEP-256");
    expect(profile.contentEncryptionAlgorithm).toBe("A256GCM");
    expect(profile.wrappingPublicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  it("round-trips a DEK through wrap and unwrap", async () => {
    const { kms } = newKms();
    const profile = await kms.encryptionProfile(scopeA);
    const dek = new Uint8Array(randomBytes(32));
    const wrapped = await kms.wrapDek(profile, dek);
    const manifest = manifestFor("capsule-1", profile.wrappingKeyId, wrapped);
    const unwrapped = await kms.unwrapDek({ manifest, ...scopeA });
    expect(Array.from(unwrapped)).toEqual(Array.from(dek));
  });

  it("uses RSA-OAEP with SHA-256/MGF1 and an empty label", async () => {
    const { kms, store } = newKms();
    const profile = await kms.encryptionProfile(scopeA);
    const dek = new Uint8Array(randomBytes(32));
    const wrapped = await kms.wrapDek(profile, dek);
    const privateKeyPem = store.exportPrivateKeyPemForTest(
      profile.wrappingKeyId,
      rootKey,
    );
    const decrypted = privateDecrypt(
      {
        key: privateKeyPem,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(wrapped, "base64"),
    );
    expect(Array.from(new Uint8Array(decrypted))).toEqual(Array.from(dek));
  });

  it("stores no plaintext private key material at rest", async () => {
    const { kms, store } = newKms();
    const profile = await kms.encryptionProfile(scopeA);
    const versions = store.listVersions("tenant-a|case-1|eu|investigation");
    expect(versions).toHaveLength(1);
    const version = versions[0]!;
    expect(version.keyId).toBe(profile.wrappingKeyId);
    expect(version.wrappedPrivateKeyBase64.length).toBeGreaterThan(0);
    const blob = Buffer.from(
      version.wrappedPrivateKeyBase64,
      "base64",
    ).toString("latin1");
    expect(blob).not.toContain("PRIVATE KEY");
    expect(blob).not.toContain("BEGIN");
  });

  it("denies unwrap for a different tenant scope", async () => {
    const { kms } = newKms();
    const profile = await kms.encryptionProfile(scopeA);
    const wrapped = await kms.wrapDek(profile, new Uint8Array(randomBytes(32)));
    const manifest = manifestFor("capsule-1", profile.wrappingKeyId, wrapped);
    await expect(
      kms.unwrapDek({ manifest, ...scopeA, tenantId: "tenant-b" }),
    ).rejects.toMatchObject({ code: "KmsScopeDenied" });
  });

  it("denies unwrap when the key belongs to a different scope than authenticated", async () => {
    const { kms } = newKms();
    const profileA = await kms.encryptionProfile(scopeA);
    const wrapped = await kms.wrapDek(profileA, new Uint8Array(randomBytes(32)));
    const otherScope: EvidenceKeyScope = {
      tenantId: "tenant-a",
      caseId: "case-2",
      region: "eu",
      purpose: "investigation",
    };
    await kms.encryptionProfile(otherScope);
    const manifest = manifestFor("capsule-x", profileA.wrappingKeyId, wrapped);
    await expect(
      kms.unwrapDek({ manifest, ...otherScope }),
    ).rejects.toMatchObject({ code: "KmsScopeDenied" });
  });

  it("rejects wrapping under a forged (unknown) key id", async () => {
    const { kms } = newKms();
    const profile = await kms.encryptionProfile(scopeA);
    const forged = { ...profile, wrappingKeyId: "deadbeef".repeat(4) };
    await expect(
      kms.wrapDek(forged, new Uint8Array(randomBytes(32))),
    ).rejects.toMatchObject({ code: "KmsScopeDenied" });
  });

  it("rejects wrapping when a bound policy field is tampered", async () => {
    const { kms } = newKms();
    const profile = await kms.encryptionProfile(scopeA);
    const tampered = { ...profile, recipient: "attacker@evil" };
    await expect(
      kms.wrapDek(tampered, new Uint8Array(randomBytes(32))),
    ).rejects.toMatchObject({ code: "KmsScopeDenied" });
  });

  it("disables unwrap after the capsule is revoked", async () => {
    const { kms } = newKms();
    const profile = await kms.encryptionProfile(scopeA);
    const wrapped = await kms.wrapDek(profile, new Uint8Array(randomBytes(32)));
    const manifest = manifestFor("capsule-9", profile.wrappingKeyId, wrapped);
    await kms.revoke("capsule-9", "compromised");
    await expect(
      kms.unwrapDek({ manifest, ...scopeA }),
    ).rejects.toMatchObject({ code: "KmsKeyRevoked" });
  });

  it("disables unwrap after the scope key is revoked", async () => {
    const { kms } = newKms();
    const profile = await kms.encryptionProfile(scopeA);
    const wrapped = await kms.wrapDek(profile, new Uint8Array(randomBytes(32)));
    const manifest = manifestFor("capsule-r", profile.wrappingKeyId, wrapped);
    await kms.revokeScope(scopeA, "rotation-of-compromised-scope");
    await expect(
      kms.unwrapDek({ manifest, ...scopeA }),
    ).rejects.toMatchObject({ code: "KmsKeyRevoked" });
  });

  it("appends immutable revisions on rotation and keeps old capsules readable", async () => {
    const { kms, store } = newKms();
    const v1 = await kms.encryptionProfile(scopeA);
    const dek1 = new Uint8Array(randomBytes(32));
    const wrapped1 = await kms.wrapDek(v1, dek1);
    const before = store.getByKeyId(v1.wrappingKeyId)!;

    const v2 = await kms.rotate(scopeA);
    expect(v2.wrappingKeyId).not.toBe(v1.wrappingKeyId);

    const after = store.getByKeyId(v1.wrappingKeyId)!;
    expect(after.wrappedPrivateKeyBase64).toBe(before.wrappedPrivateKeyBase64);
    expect(after.revision).toBe(1);
    expect(store.getByKeyId(v2.wrappingKeyId)!.revision).toBe(2);

    const current = await kms.encryptionProfile(scopeA);
    expect(current.wrappingKeyId).toBe(v2.wrappingKeyId);

    const manifest = manifestFor("capsule-old", v1.wrappingKeyId, wrapped1);
    const unwrapped = await kms.unwrapDek({ manifest, ...scopeA });
    expect(Array.from(unwrapped)).toEqual(Array.from(dek1));
  });

  it("fails closed when the KMS is marked unavailable", async () => {
    const { kms } = newKms();
    const profile = await kms.encryptionProfile(scopeA);
    kms.setAvailable(false);
    await expect(kms.encryptionProfile(scopeA)).rejects.toMatchObject({
      code: "KmsUnavailable",
    });
    await expect(kms.wrapDek(profile, new Uint8Array(randomBytes(32)))).rejects.toMatchObject({
      code: "KmsUnavailable",
    });
    await expect(kms.revoke("capsule-unavailable", "ttl_expired")).rejects.toMatchObject({
      code: "KmsUnavailable",
    });
  });

  it("records audit events without any plaintext key material", async () => {
    const audit: KmsAuditEvent[] = [];
    const { kms } = newKms(audit);
    const profile = await kms.encryptionProfile(scopeA);
    const wrapped = await kms.wrapDek(profile, new Uint8Array(randomBytes(32)));
    const manifest = manifestFor("capsule-a", profile.wrappingKeyId, wrapped);
    await kms.unwrapDek({ manifest, ...scopeA });

    expect(audit.map((e) => e.operation)).toEqual(
      expect.arrayContaining(["profile", "wrap", "unwrap"]),
    );
    for (const event of audit) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("PRIVATE KEY");
      expect(serialized).not.toContain(wrapped);
    }
  });

  it("awaits audit persistence before returning sensitive KMS outputs", async () => {
    let failAudit = false;
    const audit: KmsAuditEvent[] = [];
    const audited = new SelfHostedKms({
      rootKey,
      now: () => "2026-08-01T00:00:00.000Z",
      audit: {
        async record(event: KmsAuditEvent): Promise<void> {
          audit.push(event);
          if (failAudit) throw new Error("audit persistence failed");
        },
      },
    });

    failAudit = true;
    await expect(audited.encryptionProfile(scopeA)).rejects.toThrow("audit persistence failed");
    failAudit = false;
    const profile = await audited.encryptionProfile(scopeA);
    const dek = new Uint8Array(randomBytes(32));

    failAudit = true;
    await expect(audited.wrapDek(profile, dek)).rejects.toThrow("audit persistence failed");
    failAudit = false;
    const wrapped = await audited.wrapDek(profile, dek);
    const manifest = manifestFor("capsule-audit", profile.wrappingKeyId, wrapped);

    failAudit = true;
    await expect(audited.unwrapDek({ manifest, ...scopeA })).rejects.toThrow("audit persistence failed");
    await expect(audited.unwrapDek({ manifest, ...scopeA, tenantId: "tenant-b" })).rejects.toThrow("audit persistence failed");
    await expect(audited.assertPlaintextAccess({
      tenantId: scopeA.tenantId,
      caseId: scopeA.caseId,
      region: scopeA.region,
      purpose: scopeA.purpose,
      keyVersion: profile.wrappingKeyId,
      capsuleId: "capsule-audit",
      occurredAt: "2026-08-01T00:00:00.000Z",
    })).rejects.toThrow("audit persistence failed");

    expect(audit.map((event) => `${event.operation}:${event.decision}`)).toEqual(expect.arrayContaining([
      "profile:allowed",
      "wrap:allowed",
      "unwrap:allowed",
      "unwrap:denied",
    ]));
  });
});
