import type { RecordedStep, RecordingSession } from "@qualigence/recording";
import type {
  CommitSkillLifecycleCommandInput,
  ProcedureSkillVersion,
  SaveSkillVersionInput,
  SignedSkillBundle,
  SkillBundleManifest,
  SkillEvaluation,
  SkillLifecycleAuditEvent,
  SkillLifecycleReplayResult,
  SkillRepository,
  SkillRevocation,
  SkillState,
} from "@qualigence/skill";
import { skillError } from "@qualigence/skill";
import { sql, type Kysely } from "kysely";
import type { PostgresDatabase } from "./postgres-database.js";

interface LifecycleFailureOptions {
  readonly failAfterLifecycleWrite?: number;
}

interface SkillLifecycleCommandRow {
  readonly command_hash: string;
  readonly result_json: string;
  readonly result_version: number;
}

export class PostgresSkillStore implements SkillRepository {
  private lifecycleWrites = 0;

  constructor(
    private readonly db: Kysely<PostgresDatabase>,
    private readonly tenantId: string,
    private readonly failureOptions: LifecycleFailureOptions = {},
  ) {}

  async saveRecording(recording: RecordingSession): Promise<void> {
    await this.db
      .insertInto("recordings")
      .values({
        tenant_id: this.tenantId,
        recording_id: recording.recordingId,
        project_id: recording.projectId,
        target_id: recording.targetId,
        target_version: recording.targetVersion,
        observation_schema_epoch: recording.observationSchemaEpoch,
        started_at: recording.startedAt,
        completed_at: recording.completedAt,
        source_trace_refs_json: JSON.stringify(recording.sourceTraceRefs),
      })
      .onConflict((oc) => oc.columns(["tenant_id", "recording_id"]).doNothing())
      .execute();

    for (const step of recording.steps) {
      await this.db
        .insertInto("recording_steps")
        .values({
          tenant_id: this.tenantId,
          recording_id: recording.recordingId,
          ordinal: step.ordinal,
          step_json: JSON.stringify(step),
        })
        .onConflict((oc) =>
          oc.columns(["tenant_id", "recording_id", "ordinal"]).doNothing(),
        )
        .execute();
    }
  }

  async loadRecording(recordingId: string): Promise<RecordingSession | undefined> {
    const head = await this.db
      .selectFrom("recordings")
      .selectAll()
      .where("tenant_id", "=", this.tenantId)
      .where("recording_id", "=", recordingId)
      .executeTakeFirst();
    if (head === undefined) return undefined;
    const stepRows = await this.db
      .selectFrom("recording_steps")
      .select("step_json")
      .where("tenant_id", "=", this.tenantId)
      .where("recording_id", "=", recordingId)
      .orderBy("ordinal", "asc")
      .execute();
    const steps = stepRows.map((row) => JSON.parse(row.step_json) as RecordedStep);
    const [firstStep, ...restSteps] = steps;
    if (firstStep === undefined) return undefined;
    return {
      recordingId: head.recording_id,
      projectId: head.project_id,
      targetId: head.target_id,
      targetVersion: head.target_version,
      observationSchemaEpoch: head.observation_schema_epoch as RecordingSession["observationSchemaEpoch"],
      startedAt: head.started_at,
      completedAt: head.completed_at,
      steps: [firstStep, ...restSteps],
      sourceTraceRefs: JSON.parse(head.source_trace_refs_json) as string[],
    };
  }

  async saveSkillVersion(input: SaveSkillVersionInput): Promise<void> {
    const { version, expectedVersion, sourceRecording } = input;
    const head = await this.db
      .selectFrom("skills")
      .select(["current_version"])
      .where("tenant_id", "=", this.tenantId)
      .where("skill_id", "=", version.skillId)
      .executeTakeFirst();
    const currentVersion = head?.current_version ?? 0;
    if (currentVersion !== expectedVersion) {
      throw skillError(
        "SkillVersionConflict",
        `Skill ${version.skillId} expected version ${String(expectedVersion)} but stored version is ${String(currentVersion)}.`,
        { actualVersion: currentVersion },
      );
    }

    const createdAt = new Date().toISOString();
    if (head === undefined) {
      await this.db
        .insertInto("skills")
        .values({
          tenant_id: this.tenantId,
          skill_id: version.skillId,
          project_id: version.projectId,
          target_id: version.targetScope.targetId,
          current_version: version.version,
          current_state: version.state,
          created_at: createdAt,
          updated_at: createdAt,
        })
        .execute();
    } else {
      await this.db
        .updateTable("skills")
        .set({ current_version: version.version, current_state: version.state, updated_at: createdAt })
        .where("tenant_id", "=", this.tenantId)
        .where("skill_id", "=", version.skillId)
        .execute();
    }

    await this.db
      .insertInto("skill_versions")
      .values({
        tenant_id: this.tenantId,
        skill_id: version.skillId,
        version: version.version,
        state: version.state,
        project_id: version.projectId,
        source_recording_id: sourceRecording.recordingId,
        content_sha256: version.contentSha256,
        content_json: JSON.stringify(version),
        created_at: createdAt,
      })
      .execute();
  }

  async version(skillId: string, version: number): Promise<ProcedureSkillVersion | undefined> {
    const row = await this.db
      .selectFrom("skill_versions")
      .select("content_json")
      .where("tenant_id", "=", this.tenantId)
      .where("skill_id", "=", skillId)
      .where("version", "=", version)
      .executeTakeFirst();
    return row === undefined ? undefined : JSON.parse(row.content_json) as ProcedureSkillVersion;
  }

  async latestVersion(skillId: string): Promise<ProcedureSkillVersion | undefined> {
    const head = await this.db
      .selectFrom("skills")
      .select("current_version")
      .where("tenant_id", "=", this.tenantId)
      .where("skill_id", "=", skillId)
      .executeTakeFirst();
    return head === undefined ? undefined : this.version(skillId, head.current_version);
  }

  async versionsInState(skillId: string, state: SkillState): Promise<readonly ProcedureSkillVersion[]> {
    const rows = await this.db
      .selectFrom("skill_versions")
      .select("content_json")
      .where("tenant_id", "=", this.tenantId)
      .where("skill_id", "=", skillId)
      .where("state", "=", state)
      .orderBy("version", "asc")
      .execute();
    return rows.map((row) => JSON.parse(row.content_json) as ProcedureSkillVersion);
  }

  async versions(skillId: string): Promise<readonly ProcedureSkillVersion[]> {
    const rows = await this.db
      .selectFrom("skill_versions")
      .select("content_json")
      .where("tenant_id", "=", this.tenantId)
      .where("skill_id", "=", skillId)
      .orderBy("version", "asc")
      .execute();
    return rows.map((row) => JSON.parse(row.content_json) as ProcedureSkillVersion);
  }

  async latestVersions(): Promise<readonly ProcedureSkillVersion[]> {
    const rows = await this.db
      .selectFrom("skills")
      .innerJoin("skill_versions", (join) =>
        join
          .onRef("skill_versions.tenant_id", "=", "skills.tenant_id")
          .onRef("skill_versions.skill_id", "=", "skills.skill_id")
          .onRef("skill_versions.version", "=", "skills.current_version"),
      )
      .select("skill_versions.content_json")
      .where("skills.tenant_id", "=", this.tenantId)
      .orderBy("skills.updated_at", "desc")
      .orderBy("skills.skill_id", "asc")
      .execute();
    return rows.map((row) => JSON.parse(row.content_json) as ProcedureSkillVersion);
  }

  async saveEvaluation(evaluation: SkillEvaluation): Promise<void> {
    await this.db
      .insertInto("skill_evaluations")
      .values({
        tenant_id: this.tenantId,
        evaluation_id: evaluation.evaluationId,
        skill_id: evaluation.skillId,
        skill_version: evaluation.skillVersion,
        outcome: evaluation.outcome,
        signature_valid: evaluation.signatureValid ? 1 : 0,
        oracles_json: JSON.stringify(evaluation.oracles),
        created_at: evaluation.createdAt,
      })
      .onConflict((oc) => oc.columns(["tenant_id", "evaluation_id"]).doNothing())
      .execute();
  }

  async evaluations(skillId: string, version: number): Promise<readonly SkillEvaluation[]> {
    const rows = await this.db
      .selectFrom("skill_evaluations")
      .selectAll()
      .where("tenant_id", "=", this.tenantId)
      .where("skill_id", "=", skillId)
      .where("skill_version", "=", version)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => ({
      evaluationId: row.evaluation_id,
      skillId: row.skill_id,
      skillVersion: row.skill_version,
      oracles: JSON.parse(row.oracles_json) as SkillEvaluation["oracles"],
      outcome: row.outcome as SkillEvaluation["outcome"],
      signatureValid: row.signature_valid === 1,
      createdAt: row.created_at,
    }));
  }

  async saveBundle(bundle: SignedSkillBundle): Promise<void> {
    await this.db
      .insertInto("skill_bundles")
      .values({
        tenant_id: this.tenantId,
        skill_id: bundle.manifest.skillId,
        skill_version: bundle.manifest.skillVersion,
        bundle_id: bundle.manifest.bundleId,
        signer_key_id: bundle.manifest.signerKeyId,
        signature_algorithm: bundle.manifest.signatureAlgorithm,
        content_sha256: bundle.manifest.contentSha256,
        manifest_json: JSON.stringify(bundle.manifest),
        payload_json: JSON.stringify(bundle.payload),
        issued_at: bundle.manifest.issuedAt,
      })
      .onConflict((oc) => oc.columns(["tenant_id", "skill_id", "skill_version"]).doNothing())
      .execute();
  }

  async bundle(skillId: string, version: number): Promise<SignedSkillBundle | undefined> {
    const row = await this.db
      .selectFrom("skill_bundles")
      .select(["manifest_json", "payload_json"])
      .where("tenant_id", "=", this.tenantId)
      .where("skill_id", "=", skillId)
      .where("skill_version", "=", version)
      .executeTakeFirst();
    return row === undefined ? undefined : {
      manifest: JSON.parse(row.manifest_json) as SkillBundleManifest,
      payload: JSON.parse(row.payload_json) as ProcedureSkillVersion,
    };
  }

  async revoke(revocation: SkillRevocation): Promise<void> {
    await this.db
      .insertInto("skill_revocations")
      .values({
        tenant_id: this.tenantId,
        revocation_id: revocation.revocationId,
        skill_id: revocation.skillId,
        skill_version: revocation.skillVersion,
        reason: revocation.reason,
        revoked_at: revocation.revokedAt,
      })
      .onConflict((oc) => oc.columns(["tenant_id", "revocation_id"]).doNothing())
      .execute();
  }

  async isRevoked(skillId: string, version: number): Promise<boolean> {
    const row = await this.db
      .selectFrom("skill_revocations")
      .select("revocation_id")
      .where("tenant_id", "=", this.tenantId)
      .where("skill_id", "=", skillId)
      .where("skill_version", "=", version)
      .executeTakeFirst();
    return row !== undefined;
  }

  async replayLifecycleCommand(idempotencyKey: string, commandHash: string): Promise<SkillLifecycleReplayResult> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${this.tenantId}:skill-lifecycle:${idempotencyKey}`}, 0))`.execute(this.db);
    const replay = await this.db
      .selectFrom("skill_lifecycle_commands")
      .select(["command_hash", "result_json", "result_version"])
      .where("tenant_id", "=", this.tenantId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst() as SkillLifecycleCommandRow | undefined;
    if (replay === undefined) return { status: "not_found" };
    if (replay.command_hash !== commandHash) return { status: "conflict", resultVersion: replay.result_version };
    return { status: "replayed", result: JSON.parse(replay.result_json) as ProcedureSkillVersion };
  }

  async commitLifecycleCommand(input: CommitSkillLifecycleCommandInput): Promise<ProcedureSkillVersion> {
    this.lifecycleWrites = 0;
    const replay = await this.replayLifecycleCommand(input.command.idempotencyKey, input.commandHash);
    if (replay.status === "replayed") return replay.result;
    if (replay.status === "conflict") {
      throw skillError("SkillIdempotencyConflict", "idempotency key is bound to another Skill lifecycle command", { actualVersion: replay.resultVersion });
    }
    await this.persistLifecycleResult(input);
    return input.result;
  }

  async lifecycleAuditEvents(skillId: string): Promise<readonly SkillLifecycleAuditEvent[]> {
    const rows = await this.db
      .selectFrom("skill_lifecycle_audit_events")
      .selectAll()
      .where("tenant_id", "=", this.tenantId)
      .where("skill_id", "=", skillId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => ({
      auditId: row.audit_id,
      skillId: row.skill_id,
      skillVersion: row.skill_version,
      operation: row.operation as SkillLifecycleAuditEvent["operation"],
      decision: row.decision as SkillLifecycleAuditEvent["decision"],
      actor: {
        actorId: row.actor_id,
        tenantId: row.actor_tenant_id,
        roles: JSON.parse(row.actor_roles_json) as readonly string[],
      },
      reason: row.reason,
      metadata: JSON.parse(row.metadata_json) as Readonly<Record<string, unknown>>,
      createdAt: row.created_at,
    }));
  }

  private async persistLifecycleResult(input: CommitSkillLifecycleCommandInput): Promise<void> {
    const { command, commandHash, previousVersion, result, audit, revocation } = input;
    const updated = await this.db
      .updateTable("skills")
      .set({ current_version: result.version, current_state: result.state, updated_at: command.occurredAt })
      .where("tenant_id", "=", this.tenantId)
      .where("skill_id", "=", command.skillId)
      .where("current_version", "=", command.expectedVersion)
      .executeTakeFirst();
    await this.afterLifecycleWrite();
    if (Number(updated.numUpdatedRows) !== 1) {
      const actual = await this.db.selectFrom("skills").select("current_version").where("tenant_id", "=", this.tenantId).where("skill_id", "=", command.skillId).executeTakeFirst();
      throw skillError("SkillVersionConflict", "Skill version changed during lifecycle command.", { actualVersion: actual?.current_version });
    }
    await this.db.insertInto("skill_versions").values({ tenant_id: this.tenantId, skill_id: result.skillId, version: result.version, state: result.state, project_id: result.projectId, source_recording_id: result.sourceRecordingIds[0], content_sha256: result.contentSha256, content_json: JSON.stringify(result), created_at: command.occurredAt }).execute();
    await this.afterLifecycleWrite();
    if (revocation !== undefined) {
      await this.db.insertInto("skill_revocations").values({ tenant_id: this.tenantId, revocation_id: revocation.revocationId, skill_id: revocation.skillId, skill_version: revocation.skillVersion, reason: revocation.reason, revoked_at: revocation.revokedAt }).execute();
      await this.afterLifecycleWrite();
    }
    await this.db.insertInto("skill_lifecycle_commands").values({ tenant_id: this.tenantId, idempotency_key: command.idempotencyKey, command_hash: commandHash, command_type: command.operation, skill_id: command.skillId, expected_version: command.expectedVersion, result_version: result.version, result_json: JSON.stringify(result), created_at: command.occurredAt }).execute();
    await this.afterLifecycleWrite();
    await this.db.insertInto("skill_lifecycle_audit_events").values({ tenant_id: this.tenantId, audit_id: audit.auditId, skill_id: audit.skillId, skill_version: audit.skillVersion, operation: audit.operation, decision: audit.decision, actor_id: audit.actor.actorId, actor_tenant_id: audit.actor.tenantId, actor_roles_json: JSON.stringify([...audit.actor.roles].sort()), reason: audit.reason, metadata_json: JSON.stringify({ fromVersion: previousVersion.version, fromState: previousVersion.state, ...audit.metadata }), created_at: audit.createdAt }).execute();
    await this.afterLifecycleWrite();
  }

  private async afterLifecycleWrite(): Promise<void> {
    this.lifecycleWrites += 1;
    if (this.lifecycleWrites === this.failureOptions.failAfterLifecycleWrite) {
      throw new Error(`InjectedSkillLifecycleFailureAfterWrite:${this.lifecycleWrites}`);
    }
  }
}
