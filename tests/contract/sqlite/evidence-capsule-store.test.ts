import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqliteRuntime,
  SqliteEvidenceCapsuleStore,
  EvidenceLifecycleError,
} from "@qualigence/sqlite-runtime";
import {
  encodeCapsuleEntry,
  decodeCapsuleEntry,
  EvidenceEnvelopeEncryptor,
  type EvidenceCapsuleEntry,
  type EvidenceCapsulePayload,
  type EvidenceDecryptionContext,
  type EvidenceEncryptionProfile,
  type EvidenceKeyScope,
  type EncryptedCapsule,
  type KeyManagementProvider,
} from "@qualigence/evidence";
import { InMemoryTestKms } from "@qualigence/kms-self-hosted";

const SCOPE: EvidenceKeyScope = {
  tenantId: "tenant-a",
  caseId: "case-1",
  region: "eu-local",
  purpose: "investigation",
};

const FROZEN = "2026-08-01T00:00:00.000Z";

const SCREENSHOT_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x1a, 0x0b]);
const TRACE_BYTES = Buffer.from('{"steps":[1,2,3]}', "utf8");

function samplePayload(): {
  payload: EvidenceCapsulePayload;
  entries: EvidenceCapsuleEntry[];
} {
  const entries = [
    encodeCapsuleEntry({
      kind: "trace",
      mediaType: "application/json",
      bytes: TRACE_BYTES,
      entryId: "entry-trace",
    }),
    encodeCapsuleEntry({
      kind: "screenshot",
      mediaType: "image/png",
      bytes: SCREENSHOT_BYTES,
      entryId: "entry-shot",
    }),
  ];
  return {
    payload: { schemaVersion: "evidence-capsule/v1", runId: "run-1", entries },
    entries,
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
    now: FROZEN,
  };
}

describe("SqliteEvidenceCapsuleStore", () => {
  let dir: string;
  let runtime: SqliteRuntime;
  let kms: InMemoryTestKms;
  let store: SqliteEvidenceCapsuleStore;
  let encryptor: EvidenceEnvelopeEncryptor;
  let profile: EvidenceEncryptionProfile;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), ".tmp-capsule-store-"));
    runtime = await SqliteRuntime.open({
      filename: join(dir, "qualigence.db"),
      busyTimeoutMs: 5_000,
    });
    kms = new InMemoryTestKms({ ttlMs: 60 * 60 * 1000, now: () => FROZEN });
    store = new SqliteEvidenceCapsuleStore(runtime);
    encryptor = new EvidenceEnvelopeEncryptor({
      kms,
      audit: store,
      clock: { now: () => FROZEN },
    });
    profile = await kms.encryptionProfile(SCOPE);
  });

  afterEach(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function persistCapsule(capsuleId: string): Promise<EncryptedCapsule> {
    const { payload, entries } = samplePayload();
    const encrypted = await encryptor.encrypt(payload, profile, {
      actorType: "service",
      actorId: "runner-1",
      correlationId: "corr-1",
      capsuleId,
    });
    await store.saveRemoteCapsule({ profile, manifest: encrypted.manifest, ciphertext: encrypted.ciphertext, entries });
    return encrypted;
  }

  it("round-trips a persisted capsule byte-for-byte through a reopened database", async () => {
    await persistCapsule("capsule-1");
    await runtime.close();

    const reopened = await SqliteRuntime.open({
      filename: join(dir, "qualigence.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      const reloadStore = new SqliteEvidenceCapsuleStore(reopened);
      const stored = await reloadStore.loadCapsule("capsule-1");
      expect(stored?.revocationState).toBe("active");
      expect(stored?.ciphertextPresent).toBe(true);

      const decryptor = new EvidenceEnvelopeEncryptor({
        kms,
        audit: reloadStore,
        clock: { now: () => FROZEN },
      });
      const recovered = await decryptor.decrypt(stored!.encrypted, authorizedContext(profile));
      const shot = recovered.entries.find((e) => e.kind === "screenshot");
      expect(decodeCapsuleEntry(shot!)).toEqual(SCREENSHOT_BYTES);
    } finally {
      await reopened.close();
      // Restore runtime for afterEach cleanup.
      runtime = await SqliteRuntime.open({
        filename: join(dir, "qualigence.db"),
        busyTimeoutMs: 5_000,
      });
    }
  });

  it("persists entry metadata and the wrap audit event", async () => {
    await persistCapsule("capsule-1");
    const entryRows = await runtime.db
      .selectFrom("evidence_capsule_entries")
      .selectAll()
      .where("capsule_id", "=", "capsule-1")
      .execute();
    expect(entryRows.map((r) => r.kind).sort()).toEqual(["screenshot", "trace"]);

    const audit = await store.auditEvents("capsule-1");
    expect(audit.some((e) => e.operation === "wrap" && e.decision === "allowed")).toBe(true);
  });

  it("rejects deleting a capsule that has not been revoked", async () => {
    await persistCapsule("capsule-1");
    await expect(
      store.deleteCiphertext({ capsuleId: "capsule-1", actor: actor() }),
    ).rejects.toBeInstanceOf(EvidenceLifecycleError);

    const stored = await store.loadCapsule("capsule-1");
    expect(stored?.ciphertextPresent).toBe(true);
  });

  it("revokes before delete, then removes the ciphertext", async () => {
    await persistCapsule("capsule-1");
    await store.expireCapsule({ capsuleId: "capsule-1", reason: "ttl_expired", kms, actor: actor() });

    const stored = await store.loadCapsule("capsule-1");
    expect(stored?.revocationState).toBe("revoked");
    expect(stored?.ciphertextPresent).toBe(false);

    const audit = await store.auditEvents("capsule-1");
    const revokeIdx = audit.findIndex((e) => e.operation === "revoke" && e.decision === "allowed");
    const deleteIdx = audit.findIndex((e) => e.operation === "delete" && e.decision === "allowed");
    expect(revokeIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(revokeIdx);
  });

  it("retains the ciphertext when revoke fails during expiry", async () => {
    await persistCapsule("capsule-1");
    const failingKms: KeyManagementProvider = {
      ...kms,
      encryptionProfile: kms.encryptionProfile.bind(kms),
      wrapDek: kms.wrapDek.bind(kms),
      unwrapDek: kms.unwrapDek.bind(kms),
      async revoke() {
        throw new Error("KMS revoke unavailable");
      },
    };
    await expect(
      store.expireCapsule({ capsuleId: "capsule-1", reason: "ttl_expired", kms: failingKms, actor: actor() }),
    ).rejects.toThrow();

    const stored = await store.loadCapsule("capsule-1");
    expect(stored?.revocationState).toBe("active");
    expect(stored?.ciphertextPresent).toBe(true);

    const audit = await store.auditEvents("capsule-1");
    expect(audit.some((e) => e.operation === "revoke" && e.decision === "failed")).toBe(true);
    expect(audit.some((e) => e.operation === "delete")).toBe(false);
  });

  it("records a key rotation as an immutable new manifest revision", async () => {
    const first = await persistCapsule("capsule-1");
    const { payload, entries } = samplePayload();
    const rotated = await encryptor.encrypt(payload, profile, {
      actorType: "service",
      actorId: "runner-1",
      correlationId: "corr-2",
      capsuleId: "capsule-1",
    });
    await store.rotateKey({
      profile,
      manifest: rotated.manifest,
      ciphertext: rotated.ciphertext,
      entries,
      parentRevision: 1,
      newRevision: 2,
      actorId: "operator-1",
      reason: "scheduled_rotation",
      oldKeyId: first.manifest.protectedHeader.wrappingKeyId,
      newKeyId: rotated.manifest.protectedHeader.wrappingKeyId,
      occurredAt: FROZEN,
    });

    const latest = await store.loadCapsule("capsule-1");
    expect(latest?.revision).toBe(2);

    const rotations = await runtime.db
      .selectFrom("evidence_key_rotations")
      .selectAll()
      .where("capsule_id", "=", "capsule-1")
      .execute();
    expect(rotations).toHaveLength(1);
    expect(rotations[0]).toMatchObject({ parent_revision: 1, new_revision: 2 });
    // The original revision is preserved unchanged.
    const original = await store.loadCapsule("capsule-1", 1);
    expect(original?.revision).toBe(1);
  });

  it("keeps local-only records out of the remote upload query", async () => {
    await persistCapsule("capsule-1");
    await store.saveLocalOnly({
      localRecordId: "local-1",
      tenantId: "tenant-a",
      caseId: "case-2",
      runId: "run-2",
      disposition: "local_only",
      reason: "kms_unavailable",
      localContentRefs: ["artifact-1"],
      createdAt: FROZEN,
      expiresAt: "2026-09-01T00:00:00.000Z",
    });

    const uploads1 = await store.listRemoteUploads("case-1");
    expect(uploads1.map((u) => u.capsuleId)).toEqual(["capsule-1"]);
    const uploads2 = await store.listRemoteUploads("case-2");
    expect(uploads2).toEqual([]);
  });
});

function actor(): {
  actorType: "user" | "service";
  actorId: string;
  correlationId: string;
} {
  return { actorType: "service", actorId: "expiry-worker", correlationId: "corr-expiry" };
}
