export {
  approveTestPlan,
  createDraftTestPlan,
} from "./domain/test-plan-revision.js";

export type {
  ApproveTestPlanCommand,
  CreateTestPlanInput,
  ExpectedClaim,
  IntentStep,
  MissionError,
  MissionErrorCode,
  TestCase,
  TestPlanApproval,
  TestPlanRevision,
  TestPlanStatus,
} from "./domain/test-plan-revision.js";

export { capabilityForStep } from "./domain/test-mission.js";

export type {
  CompiledMission,
  ExecutionJob,
  ExecutionJobStatus,
  MissionBudget,
  MissionStatus,
  TargetCapabilitySummary,
  TestMission,
} from "./domain/test-mission.js";

export {
  canonicalJson,
  MissionCompiler,
} from "./application/mission-compiler.js";

export type {
  DispatchableJob,
  DispatchableMission,
  JobAttemptRecord,
  JobAttemptStatus,
  MissionDispatchDescriptor,
  MissionExecutionRecord,
  MissionJobExecution,
  PrdMissionRepository,
  SaveCompiledMissionInput,
} from "./application/prd-mission-repository.js";
