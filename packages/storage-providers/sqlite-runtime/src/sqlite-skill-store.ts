import type { RecordedStep, RecordingSession } from "@qualigence/recording";
import type {
  ProcedureSkillVersion,
  SaveSkillVersionInput,
  SignedSkillBundle,
  SkillBundleManifest,
  SkillEvaluation,
  SkillRepository,
  SkillRevocation,
  SkillState,
} from "@qualigence/skill";
import { skillError } from "@qualigence/skill";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

/**
 * SQLite-backed implementation of the LS-08 {@link SkillRepository}. It persists
 * immutable Recordings, versioned Skill snapshots, replay evaluations and signed
 * Bundles into the migration-003 tables. Skill versions are written under
 * optimistic concurrency (a stale `expectedVersion` raises `SkillVersionConflict`);
 * revocations are append-only. Only the public signature bytes of a Bundle are
 * stored — a signing private key never touches the database.
 */
export class SqliteSkillStore implements SkillRepository {
  constructor(private readonly runtime: SqliteRuntime) {}

  async saveRecording(recording: RecordingSession): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      const db = this.runtime.db;
      await db
        .insertInto("recordings")
        .values({
          recording_id: recording.recordingId,
          project_id: recording.projectId,
          target_id: recording.targetId,
          target_version: recording.targetVersion,
          observation_schema_epoch: recording.observationSchemaEpoch,
          started_at: recording.startedAt,
          completed_at: recording.completedAt,
          source_trace_refs_json: JSON.stringify(recording.sourceTraceRefs),
        })
        .onConflict((oc) => oc.column("recording_id").doNothing())
        .execute();

      for (const step of recording.steps) {
        await db
          .insertInto("recording_steps")
          .values({
            recording_id: recording.recordingId,
            ordinal: step.ordinal,
            step_json: JSON.stringify(step),
          })
          .onConflict((oc) =>
            oc.columns(["recording_id", "ordinal"]).doNothing(),
          )
          .execute();
      }
    });
  }

  async loadRecording(
    recordingId: string,
  ): Promise<RecordingSession | undefined> {
    const db = this.runtime.db;
    const head = await db
      .selectFrom("recordings")
      .selectAll()
      .where("recording_id", "=", recordingId)
      .executeTakeFirst();
    if (head === undefined) {
      return undefined;
    }
    const stepRows = await db
      .selectFrom("recording_steps")
      .select("step_json")
      .where("recording_id", "=", recordingId)
      .orderBy("ordinal", "asc")
      .execute();
    const steps = stepRows.map(
      (row) => JSON.parse(row.step_json) as RecordedStep,
    );
    const [firstStep, ...restSteps] = steps;
    if (firstStep === undefined) {
      return undefined;
    }
    return {
      recordingId: head.recording_id,
      projectId: head.project_id,
      targetId: head.target_id,
      targetVersion: head.target_version,
      observationSchemaEpoch:
        head.observation_schema_epoch as RecordingSession["observationSchemaEpoch"],
      startedAt: head.started_at,
      completedAt: head.completed_at,
      steps: [firstStep, ...restSteps],
      sourceTraceRefs: JSON.parse(head.source_trace_refs_json) as string[],
    };
  }

  async saveSkillVersion(input: SaveSkillVersionInput): Promise<void> {
    const { version, expectedVersion, sourceRecording } = input;
    await runInImmediateTransaction(this.runtime, async () => {
      const db = this.runtime.db;
      const head = await db
        .selectFrom("skills")
        .select(["current_version"])
        .where("skill_id", "=", version.skillId)
        .executeTakeFirst();
      const currentVersion = head?.current_version ?? 0;
      if (currentVersion !== expectedVersion) {
        throw skillError(
          "SkillVersionConflict",
          `Skill ${version.skillId} expected version ${String(expectedVersion)} but stored version is ${String(currentVersion)}.`,
        );
      }

      const createdAt = new Date().toISOString();

      if (head === undefined) {
        await db
          .insertInto("skills")
          .values({
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
        await db
          .updateTable("skills")
          .set({
            current_version: version.version,
            current_state: version.state,
            updated_at: createdAt,
          })
          .where("skill_id", "=", version.skillId)
          .execute();
      }

      await db
        .insertInto("skill_versions")
        .values({
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
    });
  }

  async version(
    skillId: string,
    version: number,
  ): Promise<ProcedureSkillVersion | undefined> {
    const row = await this.runtime.db
      .selectFrom("skill_versions")
      .select("content_json")
      .where("skill_id", "=", skillId)
      .where("version", "=", version)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : (JSON.parse(row.content_json) as ProcedureSkillVersion);
  }

  async latestVersion(
    skillId: string,
  ): Promise<ProcedureSkillVersion | undefined> {
    const head = await this.runtime.db
      .selectFrom("skills")
      .select("current_version")
      .where("skill_id", "=", skillId)
      .executeTakeFirst();
    if (head === undefined) {
      return undefined;
    }
    return this.version(skillId, head.current_version);
  }

  async versionsInState(
    skillId: string,
    state: SkillState,
  ): Promise<readonly ProcedureSkillVersion[]> {
    const rows = await this.runtime.db
      .selectFrom("skill_versions")
      .select("content_json")
      .where("skill_id", "=", skillId)
      .where("state", "=", state)
      .orderBy("version", "asc")
      .execute();
    return rows.map(
      (row) => JSON.parse(row.content_json) as ProcedureSkillVersion,
    );
  }

  async saveEvaluation(evaluation: SkillEvaluation): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .insertInto("skill_evaluations")
        .values({
          evaluation_id: evaluation.evaluationId,
          skill_id: evaluation.skillId,
          skill_version: evaluation.skillVersion,
          outcome: evaluation.outcome,
          signature_valid: evaluation.signatureValid ? 1 : 0,
          oracles_json: JSON.stringify(evaluation.oracles),
          created_at: evaluation.createdAt,
        })
        .onConflict((oc) => oc.column("evaluation_id").doNothing())
        .execute();
    });
  }

  async evaluations(
    skillId: string,
    version: number,
  ): Promise<readonly SkillEvaluation[]> {
    const rows = await this.runtime.db
      .selectFrom("skill_evaluations")
      .selectAll()
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
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .insertInto("skill_bundles")
        .values({
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
        .onConflict((oc) =>
          oc.columns(["skill_id", "skill_version"]).doNothing(),
        )
        .execute();
    });
  }

  async bundle(
    skillId: string,
    version: number,
  ): Promise<SignedSkillBundle | undefined> {
    const row = await this.runtime.db
      .selectFrom("skill_bundles")
      .select(["manifest_json", "payload_json"])
      .where("skill_id", "=", skillId)
      .where("skill_version", "=", version)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    return {
      manifest: JSON.parse(row.manifest_json) as SkillBundleManifest,
      payload: JSON.parse(row.payload_json) as ProcedureSkillVersion,
    };
  }

  async revoke(revocation: SkillRevocation): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db
        .insertInto("skill_revocations")
        .values({
          revocation_id: revocation.revocationId,
          skill_id: revocation.skillId,
          skill_version: revocation.skillVersion,
          reason: revocation.reason,
          revoked_at: revocation.revokedAt,
        })
        .onConflict((oc) => oc.column("revocation_id").doNothing())
        .execute();
    });
  }

  async isRevoked(skillId: string, version: number): Promise<boolean> {
    const row = await this.runtime.db
      .selectFrom("skill_revocations")
      .select("revocation_id")
      .where("skill_id", "=", skillId)
      .where("skill_version", "=", version)
      .executeTakeFirst();
    return row !== undefined;
  }
}
