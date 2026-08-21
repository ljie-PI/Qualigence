import type { TargetRevision } from "../domain/target-revision.js";

export interface SaveTargetRevisionInput {
  readonly revision: TargetRevision;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface ProjectTargetRepository {
  saveRevision(input: SaveTargetRevisionInput): Promise<TargetRevision>;
  getRevision(targetId: string, version?: number): Promise<TargetRevision | undefined>;
  listProjectTargets(projectId: string): Promise<readonly TargetRevision[]>;
}
