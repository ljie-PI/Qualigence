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
  readonly purpose: EvidencePurpose;
  readonly keyVersion: string;
  readonly state: EvidenceLifecycleState;
  readonly ciphertextPresent: boolean;
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
    private readonly kms: Pick<KeyManagementProvider, "revoke">,
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
        await this.kms.revoke(input.capsuleId, input.reason);
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
