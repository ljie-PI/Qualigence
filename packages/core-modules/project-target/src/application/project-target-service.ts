import type { Clock } from "@qualigence/shared-kernel";
import { createTargetRevision, type TargetRevision } from "../domain/target-revision.js";
import type { ProjectTargetRepository } from "./project-target-repository.js";

export interface CreateTargetCommand {
  readonly targetId: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly runnerId: string;
  readonly expectedVersion: number;
  readonly configuration: unknown;
  readonly idempotencyKey: string;
}

export class ProjectTargetService {
  constructor(private readonly repository: ProjectTargetRepository, private readonly clock: Clock) {}

  async createRevision(command: CreateTargetCommand): Promise<TargetRevision> {
    const revision = createTargetRevision(command);
    return this.repository.saveRevision({
      revision,
      expectedVersion: command.expectedVersion,
      idempotencyKey: command.idempotencyKey,
      createdAt: this.clock.now(),
    });
  }
}
