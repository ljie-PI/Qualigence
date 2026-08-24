import { canonicalJson, sha256Hex } from "../domain/skill-bundle.js";
import { skillError } from "../domain/skill-types.js";
import type { ProcedureSkillVersion } from "../domain/skill-types.js";
import { TestSkill } from "../domain/test-skill.js";
import type {
  DeprecateSkillLifecycleCommand,
  SkillLifecycleCommand,
  SkillLifecycleOperation,
  SkillRepository,
} from "../ports/skill-repository.js";
import { SkillPromotionPolicy } from "./skill-promotion-policy.js";

export class SkillLifecycleService {
  constructor(private readonly repository: SkillRepository) {}

  async promote(
    command: Extract<SkillLifecycleCommand, { operation: "promote" }>,
  ): Promise<ProcedureSkillVersion> {
    return this.apply(command);
  }

  async deprecate(command: DeprecateSkillLifecycleCommand): Promise<ProcedureSkillVersion> {
    return this.apply(command);
  }

  private async apply(command: SkillLifecycleCommand): Promise<ProcedureSkillVersion> {
    const commandHash = skillLifecycleCommandHash(command);
    const replay = await this.repository.replayLifecycleCommand(command.idempotencyKey, commandHash);
    if (replay.status === "replayed") return replay.result;
    if (replay.status === "conflict") {
      throw skillError("SkillIdempotencyConflict", "idempotency key is bound to another Skill lifecycle command", { actualVersion: replay.resultVersion });
    }

    const current = await this.repository.latestVersion(command.skillId);
    if (current === undefined) throw skillError("SkillNotFound", `Skill ${command.skillId} was not found.`);
    if (current.version !== command.expectedVersion) {
      throw skillError("SkillVersionConflict", `Skill ${command.skillId} expected version ${String(command.expectedVersion)} but stored version is ${String(current.version)}.`, { actualVersion: current.version });
    }

    const aggregate = TestSkill.fromVersion(current);
    let result: ProcedureSkillVersion;
    let reason: string;

    if (command.operation === "promote") {
      const evaluation = (await this.repository.evaluations(current.skillId, current.version)).at(-1);
      const bundle = await this.repository.bundle(current.skillId, current.version);
      if (evaluation === undefined) throw skillError("SkillVerificationFailed", "A Skill cannot be promoted without a completed evaluation.");
      if (bundle === undefined || !bundleMatchesVersion(bundle, current)) throw skillError("SkillBundleMissing", "A Skill cannot be promoted without its signed Bundle.");
      const decision = new SkillPromotionPolicy().evaluate({
        version: current,
        evaluation,
        signatureVerification: evaluation.signatureValid ? { status: "valid" } : { status: "invalid", code: "SkillSignatureInvalid", message: "The latest evaluation did not confirm a valid signature." },
        requiredOracles: command.requiredOracles,
      });
      if (decision.status === "rejected") throw skillError(decision.code, decision.message);
      aggregate.promote({ expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey });
      result = aggregate.snapshot();
      reason = "promotion policy approved";
    } else {
      aggregate.deprecate({ expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, reason: command.reason });
      result = aggregate.snapshot();
      reason = command.reason;
    }

    return this.repository.commitLifecycleCommand({
      command,
      commandHash,
      previousVersion: current,
      result,
      audit: {
        auditId: `${command.idempotencyKey}:audit`,
        skillId: result.skillId,
        skillVersion: result.version,
        operation: command.operation,
        decision: "allowed",
        actor: command.actor,
        reason,
        metadata: { fromVersion: current.version, fromState: current.state, toState: result.state },
        createdAt: command.occurredAt,
      },
      ...(command.operation === "deprecate"
        ? { revocation: { revocationId: `${command.idempotencyKey}:revocation`, skillId: result.skillId, skillVersion: result.version, reason, revokedAt: command.occurredAt } }
        : {}),
    });
  }
}

export function skillLifecycleCommandHash(command: SkillLifecycleCommand): string {
  return sha256Hex(canonicalJson({
    operation: command.operation,
    skillId: command.skillId,
    expectedVersion: command.expectedVersion,
    ...(command.operation === "promote" ? { requiredOracles: [...command.requiredOracles].sort() } : { reason: command.reason }),
    actor: { actorId: command.actor.actorId, tenantId: command.actor.tenantId, roles: [...command.actor.roles].sort() },
  }));
}

function bundleMatchesVersion(bundle: Awaited<ReturnType<SkillRepository["bundle"]>>, version: ProcedureSkillVersion): boolean {
  return bundle !== undefined &&
    bundle.manifest.skillId === version.skillId &&
    bundle.manifest.skillVersion === version.version &&
    bundle.manifest.contentSha256 === version.contentSha256 &&
    bundle.payload.skillId === version.skillId &&
    bundle.payload.version === version.version &&
    bundle.payload.contentSha256 === version.contentSha256;
}

export type { SkillLifecycleOperation };
