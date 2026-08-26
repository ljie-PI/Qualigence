import type {
  EvidenceAuditEvent,
  EvidenceLifecycleRecord,
  EvidenceLifecycleState,
  EvidenceLifecycleStore,
  EvidenceLifecycleTransitionResult,
} from "@qualigence/evidence";
import type { Kysely, Transaction } from "kysely";
import type { PostgresDatabase } from "./postgres-database.js";

/**
 * Tenant-scoped PostgreSQL implementation of the Evidence lifecycle/audit port.
 *
 * It is intentionally constructed with an already RLS-bound transaction. The
 * tenant id is still included in every predicate so callers cannot accidentally
 * address another tenant's capsule when tests or admin connections bypass RLS.
 */
export class PostgresEvidenceLifecycleStore implements EvidenceLifecycleStore {
  constructor(
    private readonly db: Kysely<PostgresDatabase> | Transaction<PostgresDatabase>,
    private readonly tenantId: string,
  ) {}

  async load(capsuleId: string): Promise<EvidenceLifecycleRecord | undefined> {
    const row = await this.db
      .selectFrom("evidence_capsule_manifests")
      .select([
        "capsule_id",
        "tenant_id",
        "case_id",
        "purpose",
        "region",
        "wrapping_key_id",
        "lifecycle_state",
        "ciphertext",
        "expires_at",
      ])
      .where("tenant_id", "=", this.tenantId)
      .where("capsule_id", "=", capsuleId)
      .orderBy("revision", "desc")
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      capsuleId: row.capsule_id,
      tenantId: row.tenant_id,
      caseId: row.case_id,
      region: row.region,
      purpose: row.purpose as EvidenceLifecycleRecord["purpose"],
      keyVersion: row.wrapping_key_id,
      state: row.lifecycle_state as EvidenceLifecycleState,
      ciphertextPresent: row.ciphertext !== null,
      expiresAt: row.expires_at,
    };
  }

  async transition(input: {
    readonly capsuleId: string;
    readonly from: readonly EvidenceLifecycleState[];
    readonly to: EvidenceLifecycleState;
    readonly occurredAt: string;
    readonly reason?: string;
  }): Promise<EvidenceLifecycleTransitionResult> {
    const values = lifecycleUpdateValues(input.to, input.occurredAt, input.reason);
    const result = await this.db
      .updateTable("evidence_capsule_manifests")
      .set(values)
      .where("tenant_id", "=", this.tenantId)
      .where("capsule_id", "=", input.capsuleId)
      .where("lifecycle_state", "in", [...input.from])
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) > 0) return "advanced";

    const current = await this.db
      .selectFrom("evidence_capsule_manifests")
      .select("lifecycle_state")
      .where("tenant_id", "=", this.tenantId)
      .where("capsule_id", "=", input.capsuleId)
      .orderBy("revision", "desc")
      .executeTakeFirst();
    if (current === undefined) return "not_found";
    return current.lifecycle_state === input.to ? "already_current" : "conflict";
  }

  async deleteCiphertext(capsuleId: string): Promise<void> {
    const active = await this.db
      .selectFrom("evidence_capsule_manifests")
      .select("revision")
      .where("tenant_id", "=", this.tenantId)
      .where("capsule_id", "=", capsuleId)
      .where("lifecycle_state", "in", ["active", "revoking"])
      .executeTakeFirst();
    if (active !== undefined) {
      throw new Error(`Evidence capsule ${capsuleId} must be revoked before ciphertext deletion.`);
    }
    await this.db
      .updateTable("evidence_capsule_manifests")
      .set({ ciphertext: null })
      .where("tenant_id", "=", this.tenantId)
      .where("capsule_id", "=", capsuleId)
      .where("lifecycle_state", "=", "deleting")
      .execute();
  }

  async record(event: EvidenceAuditEvent): Promise<void> {
    if (event.tenantId !== this.tenantId) {
      throw new Error("Evidence audit tenant does not match the scoped store.");
    }
    await this.db
      .insertInto("evidence_audit_events")
      .values({
        tenant_id: this.tenantId,
        audit_id: event.auditId,
        actor_type: event.actorType,
        actor_id: event.actorId,
        case_id: event.caseId,
        capsule_id: event.capsuleId,
        key_version: event.keyVersion,
        purpose: event.purpose,
        operation: event.operation,
        decision: event.decision,
        reason_code: event.reasonCode,
        correlation_id: event.correlationId,
        occurred_at: event.occurredAt,
      })
      .onConflict((oc) => oc.columns(["tenant_id", "audit_id"]).doNothing())
      .execute();
  }
}

function lifecycleUpdateValues(
  to: EvidenceLifecycleState,
  occurredAt: string,
  reason: string | undefined,
) {
  const base = {
    lifecycle_state: to,
    lifecycle_updated_at: occurredAt,
    last_lifecycle_error: reason ?? null,
  };
  if (to === "revoked" || to === "deleting" || to === "deleted") {
    return {
      ...base,
      revocation_state: "revoked",
      revoked_at: occurredAt,
      revoked_reason: reason ?? null,
      ...(to === "deleted" ? { deleted_at: occurredAt } : {}),
    };
  }
  return base;
}
