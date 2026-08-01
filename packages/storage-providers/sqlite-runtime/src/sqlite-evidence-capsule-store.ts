import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type {
  EvidenceAuditEvent,
  EvidenceAuditSink,
  EvidenceCapsuleEntry,
  EvidenceCapsuleProtectedHeader,
  EvidenceEncryptionProfile,
  EncryptedCapsule,
  KeyManagementProvider,
  RemoteEvidenceCapsuleManifest,
} from "@qualigence/evidence";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

/** The actor/correlation context stamped onto a lifecycle audit event. */
export interface EvidenceLifecycleActor {
  readonly actorType: "user" | "service";
  readonly actorId: string;
  readonly correlationId: string;
}

/** Input for persisting a freshly built remote Capsule (revision 1 by default). */
export interface SaveRemoteCapsuleInput {
  readonly profile: EvidenceEncryptionProfile;
  readonly manifest: RemoteEvidenceCapsuleManifest;
  readonly ciphertext: Uint8Array;
  readonly entries: readonly EvidenceCapsuleEntry[];
  readonly revision?: number;
  readonly parentRevision?: number;
}

/** Input for appending an immutable key-rotation revision to a Capsule. */
export interface RotateKeyInput extends SaveRemoteCapsuleInput {
  readonly parentRevision: number;
  readonly newRevision: number;
  readonly actorId: string;
  readonly reason: string;
  readonly oldKeyId: string;
  readonly newKeyId: string;
  readonly occurredAt: string;
  readonly rotationId?: string;
}

/** A local-only evidence record (never uploadable, never carries ciphertext). */
export interface LocalOnlyEvidenceRecordInput {
  readonly localRecordId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly disposition: "local_only";
  readonly reason: string;
  readonly localContentRefs: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** A Capsule as reconstructed from durable storage. */
export interface StoredCapsule {
  readonly capsuleId: string;
  readonly revision: number;
  readonly revocationState: "active" | "revoked";
  readonly ciphertextPresent: boolean;
  readonly encrypted: EncryptedCapsule;
  readonly profileId: string;
}

export type EvidenceLifecycleErrorCode =
  | "EvidenceRevokeRequiredBeforeDelete"
  | "EvidenceCapsuleNotFound";

/**
 * A lifecycle-ordering violation raised by the store. The most important case is
 * an attempt to delete a Capsule's ciphertext before its unwrap permission has
 * been revoked — the store never allows delete-without-revoke.
 */
export class EvidenceLifecycleError extends Error {
  readonly code: EvidenceLifecycleErrorCode;

  constructor(code: EvidenceLifecycleErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "EvidenceLifecycleError";
    this.code = code;
  }
}

/**
 * SQLite-backed persistence for LS-10 Evidence Capsules on top of PR-16's
 * migration `005` tables. Remote encrypted manifests, their entry metadata, key
 * rotations, local-only records and crypto audit events each live in their own
 * table. This store adds NO schema — it only reads/writes the existing tables.
 *
 * It implements {@link EvidenceAuditSink} so it can be handed directly to the
 * {@link @qualigence/evidence!EvidenceEnvelopeEncryptor} — every `wrap`/`unwrap`
 * audit event is then durably recorded alongside the manifests it describes.
 *
 * Lifecycle ordering is enforced here: {@link revokeCapsule} first invalidates
 * the unwrap permission at the KMS and only then marks the manifest revoked; if
 * the KMS revoke fails the ciphertext is retained and a `failed` audit is
 * written. {@link deleteCiphertext} refuses to remove ciphertext while any
 * revision of the Capsule is still `active`, so a delete can never precede a
 * revoke. {@link expireCapsule} composes the two in the mandated order.
 */
export class SqliteEvidenceCapsuleStore implements EvidenceAuditSink {
  constructor(private readonly runtime: SqliteRuntime) {}

  /** Persist a scope-bound encryption profile (idempotent by profileId). */
  async saveProfile(profile: EvidenceEncryptionProfile): Promise<void> {
    await this.runtime.db
      .insertInto("evidence_encryption_profiles")
      .values({
        profile_id: profile.profileId,
        tenant_id: profile.tenantId,
        case_id: profile.caseId,
        recipient: profile.recipient,
        region: profile.region,
        purpose: profile.purpose,
        policy_id: profile.policyId,
        wrapping_key_id: profile.wrappingKeyId,
        wrapping_public_key_pem: profile.wrappingPublicKeyPem,
        content_encryption_algorithm: profile.contentEncryptionAlgorithm,
        key_wrapping_algorithm: profile.keyWrappingAlgorithm,
        aad_schema_version: profile.aadSchemaVersion,
        allowed_entry_kinds_json: JSON.stringify(profile.allowedEntryKinds),
        maximum_entry_bytes: profile.maximumEntryBytes,
        maximum_plaintext_bytes: profile.maximumPlaintextBytes,
        maximum_ciphertext_bytes: profile.maximumCiphertextBytes,
        expires_at: profile.expiresAt,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.column("profile_id").doNothing())
      .execute();
  }

  /** Persist a remote Capsule (profile + manifest revision + entry metadata). */
  async saveRemoteCapsule(input: SaveRemoteCapsuleInput): Promise<void> {
    const revision = input.revision ?? 1;
    await runInImmediateTransaction(this.runtime, async () => {
      await this.saveProfile(input.profile);
      await this.insertManifest(input.manifest, input.ciphertext, {
        revision,
        parentRevision: input.parentRevision ?? null,
      });
      await this.insertEntries(input.manifest.protectedHeader.capsuleId, revision, input.entries);
    });
  }

  /** Append an immutable rotation revision preserving the parent revision. */
  async rotateKey(input: RotateKeyInput): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.saveProfile(input.profile);
      await this.insertManifest(input.manifest, input.ciphertext, {
        revision: input.newRevision,
        parentRevision: input.parentRevision,
      });
      await this.insertEntries(
        input.manifest.protectedHeader.capsuleId,
        input.newRevision,
        input.entries,
      );
      await this.runtime.db
        .insertInto("evidence_key_rotations")
        .values({
          rotation_id: input.rotationId ?? randomUUID(),
          capsule_id: input.manifest.protectedHeader.capsuleId,
          parent_revision: input.parentRevision,
          new_revision: input.newRevision,
          actor_id: input.actorId,
          reason: input.reason,
          old_key_id: input.oldKeyId,
          new_key_id: input.newKeyId,
          occurred_at: input.occurredAt,
        })
        .execute();
    });
  }

  /** Persist a local-only record in its own table (never uploadable). */
  async saveLocalOnly(record: LocalOnlyEvidenceRecordInput): Promise<void> {
    await this.runtime.db
      .insertInto("evidence_local_only_records")
      .values({
        local_record_id: record.localRecordId,
        tenant_id: record.tenantId,
        case_id: record.caseId,
        run_id: record.runId,
        disposition: record.disposition,
        reason: record.reason,
        local_content_refs_json: JSON.stringify(record.localContentRefs),
        created_at: record.createdAt,
        expires_at: record.expiresAt,
      })
      .onConflict((oc) => oc.column("local_record_id").doNothing())
      .execute();
  }

  /**
   * Load a Capsule revision as an {@link EncryptedCapsule}. When `revision` is
   * omitted the latest revision is returned. Returns `undefined` when the
   * Capsule (or the requested revision) is absent.
   */
  async loadCapsule(
    capsuleId: string,
    revision?: number,
  ): Promise<StoredCapsule | undefined> {
    let query = this.runtime.db
      .selectFrom("evidence_capsule_manifests")
      .selectAll()
      .where("capsule_id", "=", capsuleId);
    query =
      revision === undefined
        ? query.orderBy("revision", "desc")
        : query.where("revision", "=", revision);
    const row = await query.executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }

    const manifest: RemoteEvidenceCapsuleManifest = {
      protectedHeader: JSON.parse(
        row.protected_header_json,
      ) as EvidenceCapsuleProtectedHeader,
      ciphertextSha256: row.ciphertext_sha256,
      ciphertextBytes: row.ciphertext_bytes,
      wrappedDekBase64: row.wrapped_dek_base64,
      nonceBase64: row.nonce_base64,
      authTagBase64: row.auth_tag_base64,
    };
    const ciphertext =
      row.ciphertext === null ? new Uint8Array() : new Uint8Array(row.ciphertext);
    return {
      capsuleId: row.capsule_id,
      revision: row.revision,
      revocationState: row.revocation_state === "revoked" ? "revoked" : "active",
      ciphertextPresent: row.ciphertext !== null,
      encrypted: { manifest, ciphertext },
      profileId: row.profile_id,
    };
  }

  /**
   * The remote upload query. It reads only capsule manifests, so a local-only
   * record can never appear here.
   */
  async listRemoteUploads(
    caseId: string,
  ): Promise<readonly { readonly capsuleId: string; readonly revision: number }[]> {
    const rows = await this.runtime.db
      .selectFrom("evidence_capsule_manifests")
      .select(["capsule_id", "revision"])
      .where("case_id", "=", caseId)
      .orderBy("capsule_id", "asc")
      .orderBy("revision", "asc")
      .execute();
    return rows.map((row) => ({ capsuleId: row.capsule_id, revision: row.revision }));
  }

  /** Read the immutable audit trail for a Capsule in occurrence order. */
  async auditEvents(capsuleId: string): Promise<readonly EvidenceAuditEvent[]> {
    const rows = await this.runtime.db
      .selectFrom("evidence_audit_events")
      .selectAll()
      .where("capsule_id", "=", capsuleId)
      .orderBy("occurred_at", "asc")
      .orderBy(sql`rowid`, "asc")
      .execute();
    return rows.map((row) => ({
      auditId: row.audit_id,
      actorType: row.actor_type as EvidenceAuditEvent["actorType"],
      actorId: row.actor_id,
      tenantId: row.tenant_id,
      caseId: row.case_id,
      capsuleId: row.capsule_id,
      keyVersion: row.key_version,
      purpose: row.purpose as EvidenceAuditEvent["purpose"],
      operation: row.operation as EvidenceAuditEvent["operation"],
      decision: row.decision as EvidenceAuditEvent["decision"],
      reasonCode: row.reason_code,
      correlationId: row.correlation_id,
      occurredAt: row.occurred_at,
    }));
  }

  /** {@link EvidenceAuditSink}: durably record a crypto/lifecycle audit event. */
  async record(event: EvidenceAuditEvent): Promise<void> {
    await this.runtime.db
      .insertInto("evidence_audit_events")
      .values({
        audit_id: event.auditId,
        actor_type: event.actorType,
        actor_id: event.actorId,
        tenant_id: event.tenantId,
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
      .onConflict((oc) => oc.column("audit_id").doNothing())
      .execute();
  }

  /**
   * Revoke a Capsule's unwrap permission. The KMS revoke is invoked FIRST; only
   * on success is the manifest marked revoked and a successful audit written. If
   * the KMS revoke fails the ciphertext and `active` state are retained and a
   * `failed` revoke audit is written, so the system never reaches a state where
   * the ciphertext is gone but the revoke status is unknown.
   */
  async revokeCapsule(input: {
    readonly capsuleId: string;
    readonly reason: string;
    readonly kms: Pick<KeyManagementProvider, "revoke">;
    readonly actor: EvidenceLifecycleActor;
    readonly occurredAt?: string;
  }): Promise<void> {
    const head = await this.loadCapsule(input.capsuleId);
    if (head === undefined) {
      throw new EvidenceLifecycleError(
        "EvidenceCapsuleNotFound",
        `Capsule ${input.capsuleId} does not exist.`,
      );
    }
    const header = head.encrypted.manifest.protectedHeader;
    const now = input.occurredAt ?? new Date().toISOString();

    try {
      await input.kms.revoke(input.capsuleId, input.reason);
    } catch (cause) {
      await this.auditLifecycle(header, input.actor, {
        operation: "revoke",
        decision: "failed",
        reasonCode: "EvidenceLimited",
        occurredAt: now,
      });
      throw cause;
    }

    await this.runtime.db
      .updateTable("evidence_capsule_manifests")
      .set({
        revocation_state: "revoked",
        revoked_at: now,
        revoked_reason: input.reason,
      })
      .where("capsule_id", "=", input.capsuleId)
      .execute();
    await this.auditLifecycle(header, input.actor, {
      operation: "revoke",
      decision: "allowed",
      reasonCode: "ok",
      occurredAt: now,
    });
  }

  /**
   * Delete a Capsule's ciphertext. Rejected with
   * {@link EvidenceLifecycleError} while any revision is still `active`: a
   * ciphertext can never be deleted before the Capsule is revoked.
   */
  async deleteCiphertext(input: {
    readonly capsuleId: string;
    readonly actor: EvidenceLifecycleActor;
    readonly occurredAt?: string;
  }): Promise<void> {
    const head = await this.loadCapsule(input.capsuleId);
    if (head === undefined) {
      throw new EvidenceLifecycleError(
        "EvidenceCapsuleNotFound",
        `Capsule ${input.capsuleId} does not exist.`,
      );
    }
    const active = await this.runtime.db
      .selectFrom("evidence_capsule_manifests")
      .select("revision")
      .where("capsule_id", "=", input.capsuleId)
      .where("revocation_state", "=", "active")
      .executeTakeFirst();
    if (active !== undefined) {
      throw new EvidenceLifecycleError(
        "EvidenceRevokeRequiredBeforeDelete",
        `Capsule ${input.capsuleId} must be revoked before its ciphertext can be deleted.`,
      );
    }
    const now = input.occurredAt ?? new Date().toISOString();
    await this.runtime.db
      .updateTable("evidence_capsule_manifests")
      .set({ ciphertext: null })
      .where("capsule_id", "=", input.capsuleId)
      .execute();
    await this.auditLifecycle(head.encrypted.manifest.protectedHeader, input.actor, {
      operation: "delete",
      decision: "allowed",
      reasonCode: "ok",
      occurredAt: now,
    });
  }

  /**
   * The TTL expiry orchestration: revoke first (persisting the successful revoke
   * audit), then delete the ciphertext. If the revoke step fails the ciphertext
   * is retained and the error propagates for a later retry.
   */
  async expireCapsule(input: {
    readonly capsuleId: string;
    readonly reason: string;
    readonly kms: Pick<KeyManagementProvider, "revoke">;
    readonly actor: EvidenceLifecycleActor;
    readonly occurredAt?: string;
  }): Promise<void> {
    await this.revokeCapsule(input);
    await this.deleteCiphertext({
      capsuleId: input.capsuleId,
      actor: input.actor,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    });
  }

  private async insertManifest(
    manifest: RemoteEvidenceCapsuleManifest,
    ciphertext: Uint8Array,
    revisions: { readonly revision: number; readonly parentRevision: number | null },
  ): Promise<void> {
    const header = manifest.protectedHeader;
    const now = new Date().toISOString();
    await this.runtime.db
      .insertInto("evidence_capsule_manifests")
      .values({
        capsule_id: header.capsuleId,
        revision: revisions.revision,
        parent_revision: revisions.parentRevision,
        profile_id: header.profileId,
        payload_schema_version: header.payloadSchemaVersion,
        aad_schema_version: header.schemaVersion,
        tenant_id: header.tenantId,
        case_id: header.caseId,
        recipient: header.recipient,
        region: header.region,
        purpose: header.purpose,
        policy_id: header.policyId,
        content_encryption_algorithm: header.contentEncryptionAlgorithm,
        key_wrapping_algorithm: header.keyWrappingAlgorithm,
        wrapping_key_id: header.wrappingKeyId,
        plaintext_sha256: header.plaintextSha256,
        plaintext_bytes: header.plaintextBytes,
        ciphertext_sha256: manifest.ciphertextSha256,
        ciphertext_bytes: manifest.ciphertextBytes,
        ciphertext: Buffer.from(ciphertext),
        wrapped_dek_base64: manifest.wrappedDekBase64,
        nonce_base64: manifest.nonceBase64,
        auth_tag_base64: manifest.authTagBase64,
        protected_header_json: JSON.stringify(header),
        revocation_state: "active",
        revoked_at: null,
        revoked_reason: null,
        created_at: now,
        expires_at: header.expiresAt,
      })
      .execute();
  }

  private async insertEntries(
    capsuleId: string,
    revision: number,
    entries: readonly EvidenceCapsuleEntry[],
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const entry of entries) {
      await this.runtime.db
        .insertInto("evidence_capsule_entries")
        .values({
          entry_id: entry.entryId,
          capsule_id: capsuleId,
          revision,
          kind: entry.kind,
          media_type: entry.mediaType,
          plaintext_sha256: entry.plaintextSha256,
          plaintext_bytes: entry.plaintextBytes,
          created_at: now,
        })
        .execute();
    }
  }

  private async auditLifecycle(
    header: EvidenceCapsuleProtectedHeader,
    actor: EvidenceLifecycleActor,
    outcome: {
      readonly operation: EvidenceAuditEvent["operation"];
      readonly decision: EvidenceAuditEvent["decision"];
      readonly reasonCode: string;
      readonly occurredAt: string;
    },
  ): Promise<void> {
    await this.record({
      auditId: randomUUID(),
      actorType: actor.actorType,
      actorId: actor.actorId,
      tenantId: header.tenantId,
      caseId: header.caseId,
      capsuleId: header.capsuleId,
      keyVersion: header.wrappingKeyId,
      purpose: header.purpose,
      operation: outcome.operation,
      decision: outcome.decision,
      reasonCode: outcome.reasonCode,
      correlationId: actor.correlationId,
      occurredAt: outcome.occurredAt,
    });
  }
}
