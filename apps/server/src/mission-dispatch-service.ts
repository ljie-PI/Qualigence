import { randomUUID } from "node:crypto";
import type { Clock } from "@qualigence/shared-kernel";
import {
  MissionSchedulingService,
  type MissionSchedulingIds,
  type MissionSchedulingRepository,
  type ScheduledMission,
} from "@qualigence/mission";

export class MissionDispatchService {
  private readonly scheduling: MissionSchedulingService;

  constructor(
    repository: MissionSchedulingRepository,
    clock: Clock,
    ids: MissionSchedulingIds = {
      allocateAttemptId: randomUUID,
      allocateRunnerJobId: randomUUID,
      allocateRunId: randomUUID,
    },
  ) {
    this.scheduling = new MissionSchedulingService(repository, ids, clock);
  }

  start(missionId: string, expectedVersion: number, idempotencyKey: string): Promise<ScheduledMission> {
    return this.scheduling.start({ missionId, expectedVersion, idempotencyKey });
  }
}
