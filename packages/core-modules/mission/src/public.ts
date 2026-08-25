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
  testPlanSnapshotHash,
} from "./application/mission-compiler.js";

export {
  isWithinRiskCeiling,
  riskRank,
  validateExplorationPolicy,
  validateApprovedExecutionPolicy,
  narrowApprovedExecutionPolicy,
} from "./exploration-policy.js";

export type {
  ActionRiskLevel,
  ExplorationActionKind,
  ExplorationAttemptProgress,
  ExplorationBudgetSnapshot,
  ExplorationCheckpoint,
  ExplorationDecision,
  ExplorationInFlightAction,
  ExplorationPolicy,
  ExplorationProgressPhase,
  ExplorationRiskCeiling,
  ExplorationSeedCursor,
  ExplorationTerminalReason,
  ProposedExplorationAction,
  RegressionJobPlan,
  ApprovedExecutionPolicy,
} from "./exploration-policy.js";

export type {
  DispatchableJob,
  DispatchableMission,
  AcceptedMissionDispatch,
  BlockedMissionDispatch,
  JobAttemptRecord,
  JobAttemptStatus,
  MissionDispatchAcceptanceReceipt,
  MissionDispatchDescriptor,
  MissionExecutionRecord,
  MissionJobExecution,
  MissionSchedulingSnapshot,
  PendingMissionDispatch,
  PrdMissionRepository,
  SaveCompiledMissionInput,
} from "./application/prd-mission-repository.js";

export { missionStartCommandHash, MissionSchedulingError, MissionSchedulingService } from "./application/mission-scheduling-service.js";
export type {
  AcceptedMissionExecutionJob,
  MissionSchedulingErrorCode,
  MissionSchedulingIds,
  ScheduleMissionInput,
  ScheduleMissionJob,
  SchedulingMission,
  SchedulingMissionJob,
  ScheduledMission,
  ScheduledRunIdentity,
  StartMissionCommand,
} from "./application/mission-scheduling-service.js";

export type {
  AllocatePrdRevisionInput,
  ApproveStoredTestPlanInput,
  SaveDraftTestPlanInput,
  TestPlanRepository,
} from "./application/test-plan-repository.js";

export { TestPlanService, TestPlanServiceError } from "./application/test-plan-service.js";
export type { ApproveTestPlanInput, CreateTestPlanCommand, IngestPrdCommand, TestPlanServiceErrorCode } from "./application/test-plan-service.js";
export { MissionIntakeError, MissionIntakeService } from "./application/mission-intake-service.js";
export type { CreateMissionCommand, MissionIntakeResult } from "./application/mission-intake-service.js";
