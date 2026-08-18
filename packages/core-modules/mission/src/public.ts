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
  ExplorationBudgetSnapshot,
  ExplorationCheckpoint,
  ExplorationDecision,
  ExplorationPolicy,
  ExplorationRiskCeiling,
  ExplorationTerminalReason,
  ProposedExplorationAction,
  RegressionJobPlan,
  ApprovedExecutionPolicy,
} from "./exploration-policy.js";

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
