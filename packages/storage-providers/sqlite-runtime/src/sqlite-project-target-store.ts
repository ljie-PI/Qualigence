import { ProjectTargetError, type ProjectTargetRepository, type SaveTargetRevisionInput, type TargetRevision } from "@qualigence/project-target";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

export class SqliteProjectTargetStore implements ProjectTargetRepository {
  constructor(private readonly runtime: SqliteRuntime) {}

  async saveRevision(input: SaveTargetRevisionInput): Promise<TargetRevision> {
    return runInImmediateTransaction(this.runtime, async () => {
      const replay = await this.runtime.db.selectFrom("target_revisions").selectAll()
        .where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
      if (replay !== undefined) {
        if (replay.snapshot_hash !== input.revision.snapshotHash) throw new ProjectTargetError("TargetIdempotencyConflict", "idempotency key is bound to another Target command", { currentVersion: replay.version });
        return fromRow(replay);
      }
      const head = await this.runtime.db.selectFrom("project_targets").selectAll()
        .where("target_id", "=", input.revision.targetId).executeTakeFirst();
      const currentVersion = head?.current_version ?? 0;
      if (currentVersion !== input.expectedVersion) throw new ProjectTargetError("TargetVersionConflict", "Target version conflict", { currentVersion });
      if (input.revision.version !== currentVersion + 1 || (head !== undefined && head.project_id !== input.revision.projectId)) {
        throw new ProjectTargetError("InvalidTargetConfiguration", "Target revision provenance is inconsistent");
      }
      if (head === undefined) {
        await this.runtime.db.insertInto("project_targets").values({ target_id: input.revision.targetId, project_id: input.revision.projectId, current_version: input.revision.version, created_at: input.createdAt, updated_at: input.createdAt }).execute();
      } else {
        await this.runtime.db.updateTable("project_targets").set({ current_version: input.revision.version, updated_at: input.createdAt }).where("target_id", "=", input.revision.targetId).where("current_version", "=", input.expectedVersion).executeTakeFirstOrThrow();
      }
      await this.runtime.db.insertInto("target_revisions").values(toRow(input)).execute();
      return input.revision;
    });
  }

  async getRevision(targetId: string, version?: number): Promise<TargetRevision | undefined> {
    let query = this.runtime.db.selectFrom("target_revisions").selectAll().where("target_id", "=", targetId);
    query = version === undefined ? query.orderBy("version", "desc").limit(1) : query.where("version", "=", version);
    const row = await query.executeTakeFirst();
    return row === undefined ? undefined : fromRow(row);
  }

  async listProjectTargets(projectId: string): Promise<readonly TargetRevision[]> {
    const heads = await this.runtime.db.selectFrom("project_targets").select(["target_id", "current_version"]).where("project_id", "=", projectId).orderBy("created_at").execute();
    return Promise.all(heads.map(async (head) => (await this.getRevision(head.target_id, head.current_version)) as TargetRevision));
  }
}

type TargetRow = { target_id: string; version: number; project_id: string; display_name: string; runner_id: string; kind: string; snapshot_hash: string; configuration_json: string; idempotency_key: string; created_at: string };
function toRow(input: SaveTargetRevisionInput): TargetRow { const revision = input.revision; return { target_id: revision.targetId, version: revision.version, project_id: revision.projectId, display_name: revision.displayName, runner_id: revision.runnerId, kind: revision.configuration.kind, snapshot_hash: revision.snapshotHash, configuration_json: JSON.stringify(revision.configuration), idempotency_key: input.idempotencyKey, created_at: input.createdAt }; }
function fromRow(row: TargetRow): TargetRevision { return Object.freeze({ targetId: row.target_id, version: row.version, projectId: row.project_id, displayName: row.display_name, runnerId: row.runner_id, snapshotHash: row.snapshot_hash, configuration: JSON.parse(row.configuration_json) as TargetRevision["configuration"] }); }
