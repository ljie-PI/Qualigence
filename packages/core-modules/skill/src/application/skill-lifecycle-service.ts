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
import type { SkillSigner, SkillSignatureVerification } from "../ports/skill-signer.js";
import { SkillPromotionPolicy } from "./skill-promotion-policy.js";

export interface SkillLifecycleServiceDependencies {
  readonly repository: SkillRepository;
  readonly signer?: SkillSigner | undefined;
}

export class SkillLifecycleService {
  private readonly repository: SkillRepository;
  private readonly signer: SkillSigner | undefined;

  constructor(deps: SkillLifecycleServiceDependencies) {
    this.repository = deps.repository;
    this.signer = deps.signer;
  }

  async promote(
    command: Extract<SkillLifecycleCommand, { operation: "promote" }>,
  ): Promise<ProcedureSkillVersion> {
    return this.apply(command);
  }

  async deprecate(command: DeprecateSkillLifecycleCommand): Promise<ProcedureSkillVersion> {
    return this.apply(command);
  }

  private async apply(command: SkillLifecycleCommand): Promise<ProcedureSkillVersion> {
    throwIfAborted(command.abortSignal);
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
      const signatureVerification = await this.signatureVerification(current, bundle, command.occurredAt);
      const decision = new SkillPromotionPolicy().evaluate({
        version: current,
        evaluation,
        signatureVerification,
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

    throwIfAborted(command.abortSignal);

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

  async versionView(version: ProcedureSkillVersion): Promise<SkillVersionView> {
    const signedVersion = await this.signedEvaluatedVersion(version);
    const latestEvaluation = signedVersion === undefined ? undefined : (await this.repository.evaluations(version.skillId, signedVersion.version)).at(-1);
    const bundle = signedVersion === undefined ? undefined : await this.repository.bundle(version.skillId, signedVersion.version);
    const revoked = await this.repository.isRevoked(version.skillId, version.version);
    return {
      skillId: version.skillId,
      version: version.version,
      state: version.state,
      contentSha256: version.contentSha256,
      signatureStatus: revoked ? "revoked" : signedVersion !== undefined && bundleMatchesVersion(bundle, signedVersion) && latestEvaluation?.signatureValid === true ? "valid" : "invalid",
      evaluationStatus: latestEvaluation === undefined ? "pending" : latestEvaluation.outcome,
    };
  }

  async latestViews(): Promise<readonly SkillVersionView[]> {
    return Promise.all((await this.repository.latestVersions()).map((version) => this.versionView(version)));
  }

  async versionViews(skillId: string): Promise<readonly SkillVersionView[]> {
    return Promise.all((await this.repository.versions(skillId)).map((version) => this.versionView(version)));
  }

  private async signedEvaluatedVersion(version: ProcedureSkillVersion): Promise<ProcedureSkillVersion | undefined> {
    const lineage = await this.repository.versions(version.skillId);
    for (const candidate of [...lineage].reverse()) {
      if (candidate.version > version.version || candidate.contentSha256 !== version.contentSha256) continue;
      const evaluation = (await this.repository.evaluations(candidate.skillId, candidate.version)).at(-1);
      const bundle = await this.repository.bundle(candidate.skillId, candidate.version);
      if (evaluation?.signatureValid === true && bundleMatchesVersion(bundle, candidate)) return candidate;
    }
    return undefined;
  }

  private async signatureVerification(
    version: ProcedureSkillVersion,
    bundle: NonNullable<Awaited<ReturnType<SkillRepository["bundle"]>>>,
    now: string,
  ): Promise<SkillSignatureVerification> {
    if (!version.targetScope.allowedOrigins.every((origin) => typeof origin === "string")) {
      return { status: "invalid", code: "SkillTargetMismatch", message: "Skill target scope is invalid." };
    }
    if (this.signer === undefined) {
      return { status: "invalid", code: "SkillSignatureInvalid", message: "No Skill signature verifier is configured." };
    }
    return this.signer.verify(bundle, {
      projectId: version.projectId,
      targetId: version.targetScope.targetId,
      now,
    });
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw skillError("SkillCommandAborted", "Skill lifecycle command was aborted before dispatch.");
  }
}

export interface SkillVersionView {
  readonly skillId: string;
  readonly version: number;
  readonly state: ProcedureSkillVersion["state"];
  readonly contentSha256: string;
  readonly signatureStatus: "valid" | "invalid" | "revoked";
  readonly evaluationStatus: "pending" | "passed" | "failed";
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
