import { describe, expect, it } from "vitest";
import {
  EvidenceLifecycleError,
  EvidenceLifecycleService,
  type EvidenceAuditEvent,
  type EvidenceLifecycleRecord,
  type EvidenceLifecycleState,
  type EvidenceLifecycleStore,
  type EvidenceLifecycleTransitionResult,
  type KeyManagementProvider,
} from "@qualigence/evidence";

const baseRecord: EvidenceLifecycleRecord = {
  capsuleId: "capsule-1",
  tenantId: "tenant-a",
  caseId: "case-1",
  purpose: "investigation",
  keyVersion: "key-1",
  state: "active",
  ciphertextPresent: true,
};

class MemoryLifecycleStore implements EvidenceLifecycleStore {
  recordValue: EvidenceLifecycleRecord | undefined = { ...baseRecord };
  readonly audits: EvidenceAuditEvent[] = [];
  readonly transitions: EvidenceLifecycleState[] = [];
  failAudit = false;
  failDelete = false;

  async load(capsuleId: string): Promise<EvidenceLifecycleRecord | undefined> {
    return this.recordValue?.capsuleId === capsuleId ? this.recordValue : undefined;
  }

  async transition(input: {
    readonly capsuleId: string;
    readonly from: readonly EvidenceLifecycleState[];
    readonly to: EvidenceLifecycleState;
  }): Promise<EvidenceLifecycleTransitionResult> {
    if (this.recordValue === undefined || this.recordValue.capsuleId !== input.capsuleId) return "not_found";
    if (this.recordValue.state === input.to) return "already_current";
    if (!input.from.includes(this.recordValue.state)) return "conflict";
    this.recordValue = {
      ...this.recordValue,
      state: input.to,
      ciphertextPresent: input.to === "deleted" ? false : this.recordValue.ciphertextPresent,
    };
    this.transitions.push(input.to);
    return "advanced";
  }

  async deleteCiphertext(): Promise<void> {
    if (this.failDelete) throw new Error("delete unavailable");
    if (this.recordValue !== undefined) {
      this.recordValue = { ...this.recordValue, ciphertextPresent: false };
    }
  }

  async record(event: EvidenceAuditEvent): Promise<void> {
    if (this.failAudit) throw new Error("audit unavailable");
    this.audits.push(event);
  }
}

class RevokeKms implements Pick<KeyManagementProvider, "revoke"> {
  calls = 0;
  fail = false;
  async revoke(): Promise<void> {
    this.calls += 1;
    if (this.fail) throw new Error("kms unavailable");
  }
}

function service(store = new MemoryLifecycleStore(), kms = new RevokeKms()) {
  return {
    store,
    kms,
    service: new EvidenceLifecycleService(store, kms),
  };
}

const request = {
  capsuleId: "capsule-1",
  reason: "ttl_expired",
  actor: { actorType: "service", actorId: "retention-worker", correlationId: "corr-1" } as const,
  occurredAt: "2026-08-01T00:00:00.000Z",
};

describe("EvidenceLifecycleService", () => {
  it("orders active -> revoking -> revoked -> deleting -> deleted with audit before deletion", async () => {
    const h = service();
    await expect(h.service.deleteEvidence(request)).resolves.toEqual({ capsuleId: "capsule-1", state: "deleted" });
    expect(h.store.transitions).toEqual(["revoking", "revoked", "deleting", "deleted"]);
    expect(h.kms.calls).toBe(1);
    expect(h.store.recordValue).toMatchObject({ state: "deleted", ciphertextPresent: false });
    expect(h.store.audits.map((event) => `${event.operation}:${event.decision}`)).toEqual([
      "revoke:allowed",
      "delete:allowed",
    ]);
  });

  it("retains ciphertext and stays retryable when KMS revoke fails", async () => {
    const h = service();
    h.kms.fail = true;
    await expect(h.service.deleteEvidence(request)).rejects.toMatchObject({ code: "EvidenceRevocationFailed" });
    expect(h.store.recordValue).toMatchObject({ state: "revoking", ciphertextPresent: true });
    expect(h.store.transitions).toEqual(["revoking"]);
    expect(h.store.audits).toHaveLength(1);
    expect(h.store.audits[0]).toMatchObject({ operation: "revoke", decision: "failed" });
  });

  it("does not start deletion when successful revoke audit cannot be persisted", async () => {
    const h = service();
    h.store.failAudit = true;
    await expect(h.service.deleteEvidence(request)).rejects.toThrow("audit unavailable");
    expect(h.store.recordValue).toMatchObject({ state: "revoking", ciphertextPresent: true });
    expect(h.store.transitions).toEqual(["revoking"]);
  });

  it("restores revoked retry state when ciphertext deletion fails", async () => {
    const h = service();
    h.store.failDelete = true;
    await expect(h.service.deleteEvidence(request)).rejects.toMatchObject({ code: "EvidenceDeletionFailed" });
    expect(h.store.recordValue).toMatchObject({ state: "revoked", ciphertextPresent: true });
    expect(h.store.transitions).toEqual(["revoking", "revoked", "deleting", "revoked"]);
    expect(h.store.audits.map((event) => `${event.operation}:${event.decision}`)).toEqual([
      "revoke:allowed",
      "delete:failed",
    ]);
  });

  it("replays from a durable revoked state without restoring unwrap authority", async () => {
    const store = new MemoryLifecycleStore();
    store.recordValue = { ...baseRecord, state: "revoked", ciphertextPresent: true };
    const kms = new RevokeKms();
    const lifecycle = new EvidenceLifecycleService(store, kms);
    await expect(lifecycle.deleteEvidence(request)).resolves.toEqual({ capsuleId: "capsule-1", state: "deleted" });
    expect(kms.calls).toBe(0);
    expect(store.transitions).toEqual(["deleting", "deleted"]);
  });

  it("reports missing capsules without side effects", async () => {
    const h = service();
    h.store.recordValue = undefined;
    await expect(h.service.deleteEvidence(request)).rejects.toBeInstanceOf(EvidenceLifecycleError);
    expect(h.kms.calls).toBe(0);
    expect(h.store.audits).toEqual([]);
  });
});
