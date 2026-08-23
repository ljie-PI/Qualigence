import type {
  JobAttemptRecord,
  MissionDispatchAcceptanceReceipt,
  MissionStatus,
  PrdMissionRepository,
  SaveCompiledMissionInput,
  ScheduleMissionInput,
  StartMissionCommand,
  TestPlanRevision,
} from "@qualigence/mission";
import type { PrdDocument } from "@qualigence/context-intake";

export class UnexpectedPrdMissionRepositoryCall extends Error {
  readonly code = "UnexpectedPrdMissionRepositoryCall";

  constructor(method: keyof PrdMissionRepository) {
    super(`Unexpected PrdMissionRepository.${method} call in test fake.`);
    this.name = "UnexpectedPrdMissionRepositoryCall";
  }
}

/** Explicit test-only implementation for repository operations irrelevant to a test. */
export class PrdMissionRepositoryTestStub implements PrdMissionRepository {
  savePrdDocument(_document: PrdDocument): ReturnType<PrdMissionRepository["savePrdDocument"]> { return rejected("savePrdDocument"); }
  saveTestPlanRevision(_plan: TestPlanRevision): ReturnType<PrdMissionRepository["saveTestPlanRevision"]> { return rejected("saveTestPlanRevision"); }
  saveCompiledMission(_input: SaveCompiledMissionInput): ReturnType<PrdMissionRepository["saveCompiledMission"]> { return rejected("saveCompiledMission"); }
  loadMissionForDispatch(_missionId: string): ReturnType<PrdMissionRepository["loadMissionForDispatch"]> { return rejected("loadMissionForDispatch"); }
  listMissionIds(): ReturnType<NonNullable<PrdMissionRepository["listMissionIds"]>> { return rejected("listMissionIds"); }
  recordJobAttempt(_attempt: JobAttemptRecord): ReturnType<PrdMissionRepository["recordJobAttempt"]> { return rejected("recordJobAttempt"); }
  setJobStatus(_jobId: string, _status: Parameters<PrdMissionRepository["setJobStatus"]>[1]): ReturnType<PrdMissionRepository["setJobStatus"]> { return rejected("setJobStatus"); }
  setMissionStatus(_missionId: string, _missionRevision: number, _status: MissionStatus): ReturnType<PrdMissionRepository["setMissionStatus"]> { return rejected("setMissionStatus"); }
  loadMissionExecution(_missionId: string): ReturnType<PrdMissionRepository["loadMissionExecution"]> { return rejected("loadMissionExecution"); }
  replayMissionSchedule(_command: StartMissionCommand): ReturnType<PrdMissionRepository["replayMissionSchedule"]> { return rejected("replayMissionSchedule"); }
  loadMissionForScheduling(_missionId: string): ReturnType<PrdMissionRepository["loadMissionForScheduling"]> { return rejected("loadMissionForScheduling"); }
  scheduleMission(_input: ScheduleMissionInput): ReturnType<PrdMissionRepository["scheduleMission"]> { return rejected("scheduleMission"); }
  pendingDispatches(_limit: number): ReturnType<PrdMissionRepository["pendingDispatches"]> { return rejected("pendingDispatches"); }
  markDispatchAccepted(_attemptId: string, _receipt: MissionDispatchAcceptanceReceipt, _expectedVersion: number): ReturnType<PrdMissionRepository["markDispatchAccepted"]> { return rejected("markDispatchAccepted"); }
}

function unexpected(method: keyof PrdMissionRepository): UnexpectedPrdMissionRepositoryCall {
  return new UnexpectedPrdMissionRepositoryCall(method);
}

function rejected<T>(method: keyof PrdMissionRepository): Promise<T> {
  return Promise.reject(unexpected(method));
}
