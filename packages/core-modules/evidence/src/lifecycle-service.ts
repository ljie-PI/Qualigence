import { randomUUID } from "node:crypto";
import type {
  EvidenceAuditEvent,
  EvidenceAuditSink,
  EvidencePurpose,
  KeyManagementProvider,
} from "./capsule/contracts.js";

export type EvidenceLifecycleState =
  | "active"
  | "revoking"
  | "revoked"
  | "deleting"
  | "deleted";

export interface EvidenceLifecycleRecord {
  readonly capsuleId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly region: string;
  readonly purpose: EvidencePurpose;
  readonly policyId: string;
  readonly keyVersion: string;
  readonly state: EvidenceLifecycleState;
  readonly ciphertextPresent: boolean;
  readonly expiresAt?: string;
}

export interface EvidenceLifecycleActor {
  readonly actorType: "user" | "service";
  readonly actorId: string;
  readonly correlationId: string;
}

export type EvidenceLifecycleTransitionResult =
  | "advanced"
  | "already_current"
  | "conflict"
  | "not_found";

export interface EvidenceLifecycleStore extends EvidenceAuditSink {
  load(capsuleId: string): Promise<EvidenceLifecycleRecord | undefined>;
  transition(input: {
    readonly capsuleId: string;
    readonly from: readonly EvidenceLifecycleState[];
    readonly to: EvidenceLifecycleState;
    readonly occurredAt: string;
    readonly reason?: string;
  }): Promise<EvidenceLifecycleTransitionResult>;
  deleteCiphertext(capsuleId: string): Promise<void>;
}

export type EvidenceLifecycleErrorCode =
  | "EvidenceCapsuleNotFound"
  | "EvidenceLifecycleConflict"
  | "EvidenceLifecycleTerminal"
  | "EvidenceAccessDenied"
  | "EvidenceAccessUnavailable"
  | "EvidenceAuditUnavailable"
  | "EvidenceRevocationFailed"
  | "EvidenceDeletionFailed";

export class EvidenceLifecycleError extends Error {
  constructor(
    readonly code: EvidenceLifecycleErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "EvidenceLifecycleError";
  }
}

export interface DeleteEvidenceInput {
  readonly capsuleId: string;
  readonly reason: string;
  readonly actor: EvidenceLifecycleActor;
  readonly occurredAt: string;
}

export interface DeleteEvidenceResult {
  readonly capsuleId: string;
  readonly state: EvidenceLifecycleState;
}

export interface EvidencePlaintextAccessCheck {
  readonly tenantId: string;
  readonly caseId: string;
  readonly region: string;
  readonly purpose: EvidencePurpose;
  readonly policyId: string;
  readonly keyVersion: string;
  readonly capsuleId: string;
  readonly occurredAt: string;
}

export interface EvidencePlaintextAccessKeyPolicy {
  assertPlaintextAccess(input: EvidencePlaintextAccessCheck): Promise<void>;
}

export interface EvidenceScopedRevoker {
  revokeForScope(input: EvidencePlaintextAccessCheck, reason: string): Promise<void>;
}

export interface AuthorizeEvidenceAccessInput {
  readonly capsuleId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly purpose: EvidencePurpose;
  readonly policyId: string;
  readonly actor: EvidenceLifecycleActor;
  readonly occurredAt: string;
}

export interface AuthorizeEvidenceAccessResult {
  readonly capsuleId: string;
  readonly state: EvidenceLifecycleState;
  readonly downloadAllowed: boolean;
}

/**
 * Authorizes Public Evidence metadata/byte reads at the durable audit boundary.
 * Metadata and plaintext-byte access both require a persisted audit row before
 * the route may return. Plaintext-byte access additionally requires the current
 * lifecycle to be active, unexpired, and KMS-approved; any lifecycle, KMS, or
 * audit persistence failure fails the operation closed.
 */
export class EvidenceAccessService {
  constructor(
    private readonly store: EvidenceLifecycleStore,
    private readonly keyPolicy: EvidencePlaintextAccessKeyPolicy,
  ) {}

  async authorizeMetadata(input: AuthorizeEvidenceAccessInput): Promise<AuthorizeEvidenceAccessResult> {
    const record = await this.loadAndValidateScope(input);
    await this.audit(record, input.actor, "profile", "allowed", "metadata_access", input.occurredAt);
    return {
      capsuleId: record.capsuleId,
      state: record.state,
      downloadAllowed: this.isPlaintextAllowed(record, input.occurredAt),
    };
  }

  async authorizePlaintext(input: AuthorizeEvidenceAccessInput): Promise<AuthorizeEvidenceAccessResult> {
    const record = await this.preparePlaintext(input);
    await this.audit(record, input.actor, "unwrap", "allowed", "plaintext_access", input.occurredAt);
    return { capsuleId: record.capsuleId, state: record.state, downloadAllowed: true };
  }

  /**
   * Validates lifecycle, policy and KMS authority before a caller attempts to
   * fetch bytes, but intentionally does not write the successful plaintext
   * audit yet. The caller must call `recordPlaintextAccessAllowed` only after
   * the bytes are actually available, so storage failures cannot create a false
   * `unwrap:allowed:plaintext_access` trail.
   */
  async preparePlaintext(input: AuthorizeEvidenceAccessInput): Promise<EvidenceLifecycleRecord> {
    const record = await this.loadAndValidateScope(input);
    if (!this.isPlaintextAllowed(record, input.occurredAt)) {
      await this.audit(record, input.actor, "unwrap", "denied", this.denialReason(record, input.occurredAt), input.occurredAt);
      throw new EvidenceLifecycleError(
        "EvidenceAccessDenied",
        `Evidence capsule ${input.capsuleId} is not available for plaintext access.`,
      );
    }
    try {
      await this.keyPolicy.assertPlaintextAccess({
        tenantId: record.tenantId,
        caseId: record.caseId,
        region: record.region,
        purpose: record.purpose,
        policyId: record.policyId,
        keyVersion: record.keyVersion,
        capsuleId: record.capsuleId,
        occurredAt: input.occurredAt,
      });
    } catch (cause) {
      await this.audit(record, input.actor, "unwrap", "failed", "EvidenceKmsUnavailable", input.occurredAt);
      throw new EvidenceLifecycleError(
        "EvidenceAccessUnavailable",
        `Evidence KMS access failed for capsule ${input.capsuleId}; refusing plaintext fallback.`,
        { cause },
      );
    }
    return record;
  }

  async recordPlaintextAccessAllowed(
    input: AuthorizeEvidenceAccessInput,
    preparedRecord: EvidenceLifecycleRecord,
  ): Promise<AuthorizeEvidenceAccessResult> {
    const record = await this.preparePlaintext(input);
    if (record.keyVersion !== preparedRecord.keyVersion) {
      await this.audit(record, input.actor, "unwrap", "denied", "EvidenceKeyChanged", input.occurredAt);
      throw new EvidenceLifecycleError(
        "EvidenceAccessDenied",
        `Evidence capsule ${input.capsuleId} changed before plaintext access could be audited.`,
      );
    }
    await this.audit(record, input.actor, "unwrap", "allowed", "plaintext_access", input.occurredAt);
    return { capsuleId: record.capsuleId, state: record.state, downloadAllowed: true };
  }

  private async loadAndValidateScope(input: AuthorizeEvidenceAccessInput): Promise<EvidenceLifecycleRecord> {
    let record: EvidenceLifecycleRecord | undefined;
    try {
      record = await this.store.load(input.capsuleId);
    } catch (cause) {
      throw new EvidenceLifecycleError(
        "EvidenceAccessUnavailable",
        `Evidence lifecycle state is unavailable for capsule ${input.capsuleId}.`,
        { cause },
      );
    }
    if (record === undefined) {
      throw new EvidenceLifecycleError(
        "EvidenceCapsuleNotFound",
        `Evidence capsule ${input.capsuleId} does not exist.`,
      );
    }
    if (
      record.tenantId !== input.tenantId ||
      record.caseId !== input.caseId ||
      record.purpose !== input.purpose ||
      record.policyId !== input.policyId
    ) {
      await this.audit(record, input.actor, "unwrap", "denied", "EvidenceScopeMismatch", input.occurredAt);
      throw new EvidenceLifecycleError(
        "EvidenceAccessDenied",
        `Evidence capsule ${input.capsuleId} is outside the caller scope.`,
      );
    }
    return record;
  }

  private isPlaintextAllowed(record: EvidenceLifecycleRecord, now: string): boolean {
    return record.state === "active" && record.ciphertextPresent && (record.expiresAt === undefined || now < record.expiresAt);
  }

  private denialReason(record: EvidenceLifecycleRecord, now: string): string {
    if (record.state !== "active") return "EvidenceLifecycleNotActive";
    if (!record.ciphertextPresent) return "EvidenceCiphertextMissing";
    if (record.expiresAt !== undefined && now >= record.expiresAt) return "EvidenceExpired";
    return "EvidenceAccessDenied";
  }

  private async audit(
    record: EvidenceLifecycleRecord,
    actor: EvidenceLifecycleActor,
    operation: EvidenceAuditEvent["operation"],
    decision: EvidenceAuditEvent["decision"],
    reasonCode: string,
    occurredAt: string,
  ): Promise<void> {
    try {
      await this.store.record({
        auditId: randomUUID(),
        actorType: actor.actorType,
        actorId: actor.actorId,
        tenantId: record.tenantId,
        caseId: record.caseId,
        capsuleId: record.capsuleId,
        keyVersion: record.keyVersion,
        purpose: record.purpose,
        operation,
        decision,
        reasonCode,
        correlationId: actor.correlationId,
        occurredAt,
      });
    } catch (cause) {
      throw new EvidenceLifecycleError(
        "EvidenceAuditUnavailable",
        `Evidence audit persistence failed for capsule ${record.capsuleId}; refusing access.`,
        { cause },
      );
    }
  }
}

/**
 * Orchestrates the fail-closed Evidence lifecycle.
 *
 * The service makes every irreversible side effect conditional on the preceding
 * durable boundary: first persist `revoking`, then revoke KMS unwrap authority,
 * then durably audit the successful revoke, then persist `revoked`, then enter
 * `deleting`, delete ciphertext, audit deletion, and finally persist `deleted`.
 * Any provider or audit failure throws before plaintext can be returned or a
 * later lifecycle phase can be claimed. Replays resume from the last durable
 * state and never move backwards.
 */
export class EvidenceLifecycleService {
  constructor(
    private readonly store: EvidenceLifecycleStore,
    private readonly kms: Pick<KeyManagementProvider, "revoke"> & Partial<EvidenceScopedRevoker>,
  ) {}

  async deleteEvidence(input: DeleteEvidenceInput): Promise<DeleteEvidenceResult> {
    let current = await this.requireRecord(input.capsuleId);

    if (current.state === "deleted") {
      return { capsuleId: input.capsuleId, state: "deleted" };
    }

    if (current.state === "active") {
      await this.advance(input.capsuleId, ["active"], "revoking", input.occurredAt, input.reason);
      current = await this.requireRecord(input.capsuleId);
    }

    if (current.state === "revoking") {
      try {
        if (typeof this.kms.revokeForScope === "function") {
          await this.kms.revokeForScope({
            tenantId: current.tenantId,
            caseId: current.caseId,
            region: current.region,
            purpose: current.purpose,
            policyId: current.policyId,
            keyVersion: current.keyVersion,
            capsuleId: current.capsuleId,
            occurredAt: input.occurredAt,
          }, input.reason);
        } else {
          await this.kms.revoke(input.capsuleId, input.reason);
        }
      } catch (cause) {
        await this.audit(current, input.actor, "revoke", "failed", "EvidenceRevocationFailed", input.occurredAt);
        throw new EvidenceLifecycleError(
          "EvidenceRevocationFailed",
          `KMS revoke failed for Evidence capsule ${input.capsuleId}; ciphertext is retained for retry.`,
          { cause },
        );
      }
      await this.audit(current, input.actor, "revoke", "allowed", "ok", input.occurredAt);
      await this.advance(input.capsuleId, ["revoking"], "revoked", input.occurredAt, input.reason);
      current = await this.requireRecord(input.capsuleId);
    }

    if (current.state === "revoked") {
      await this.advance(input.capsuleId, ["revoked"], "deleting", input.occurredAt, input.reason);
      current = await this.requireRecord(input.capsuleId);
    }

    if (current.state === "deleting") {
      try {
        await this.store.deleteCiphertext(input.capsuleId);
      } catch (cause) {
        await this.audit(current, input.actor, "delete", "failed", "EvidenceDeletionFailed", input.occurredAt);
        await this.advance(input.capsuleId, ["deleting"], "revoked", input.occurredAt, input.reason);
        throw new EvidenceLifecycleError(
          "EvidenceDeletionFailed",
          `Ciphertext delete failed for Evidence capsule ${input.capsuleId}; revoked record is retained for retry.`,
          { cause },
        );
      }
      await this.audit(current, input.actor, "delete", "allowed", "ok", input.occurredAt);
      await this.advance(input.capsuleId, ["deleting"], "deleted", input.occurredAt, input.reason);
      return { capsuleId: input.capsuleId, state: "deleted" };
    }

    throw new EvidenceLifecycleError(
      "EvidenceLifecycleTerminal",
      `Evidence capsule ${input.capsuleId} cannot advance from state ${current.state}.`,
    );
  }

  private async requireRecord(capsuleId: string): Promise<EvidenceLifecycleRecord> {
    const record = await this.store.load(capsuleId);
    if (record === undefined) {
      throw new EvidenceLifecycleError(
        "EvidenceCapsuleNotFound",
        `Evidence capsule ${capsuleId} does not exist.`,
      );
    }
    return record;
  }

  private async advance(
    capsuleId: string,
    from: readonly EvidenceLifecycleState[],
    to: EvidenceLifecycleState,
    occurredAt: string,
    reason: string,
  ): Promise<void> {
    const result = await this.store.transition({ capsuleId, from, to, occurredAt, reason });
    if (result === "advanced" || result === "already_current") return;
    if (result === "not_found") {
      throw new EvidenceLifecycleError(
        "EvidenceCapsuleNotFound",
        `Evidence capsule ${capsuleId} does not exist.`,
      );
    }
    throw new EvidenceLifecycleError(
      "EvidenceLifecycleConflict",
      `Evidence capsule ${capsuleId} lifecycle changed concurrently.`,
    );
  }

  private async audit(
    record: EvidenceLifecycleRecord,
    actor: EvidenceLifecycleActor,
    operation: EvidenceAuditEvent["operation"],
    decision: EvidenceAuditEvent["decision"],
    reasonCode: string,
    occurredAt: string,
  ): Promise<void> {
    await this.store.record({
      auditId: randomUUID(),
      actorType: actor.actorType,
      actorId: actor.actorId,
      tenantId: record.tenantId,
      caseId: record.caseId,
      capsuleId: record.capsuleId,
      keyVersion: record.keyVersion,
      purpose: record.purpose,
      operation,
      decision,
      reasonCode,
      correlationId: actor.correlationId,
      occurredAt,
    });
  }
}
