export {
  InvestigationBudgetLedger,
  outcomeConsumesReproductionAttempt,
} from "./domain/investigation-budget.js";

export type {
  BudgetConsumeResult,
  BudgetDimension,
  InvestigationBudget,
  InvestigationBudgetUsage,
} from "./domain/investigation-budget.js";

export type {
  ReproductionAttempt,
  ReproductionAttemptDraft,
  ReproductionOutcome,
} from "./domain/reproduction-attempt.js";

export {
  InvestigationCase,
  InvestigationError,
  investigationError,
} from "./domain/investigation-case.js";

export type {
  AppendAttemptCommand,
  BugEpisode,
  BugEpisodeDraft,
  ConfirmBugCommand,
  EscalateToHumanCommand,
  HumanHandoff,
  HumanHandoffDraft,
  InvestigationCommandBase,
  InvestigationErrorCode,
  InvestigationOpenInput,
  InvestigationStatus,
  InvestigationTransition,
  MarkFlakyCommand,
  RefuteCommand,
  ResolveCommand,
  StartInvestigationCommand,
  StartReproductionCommand,
  VerifyRegressionCommand,
} from "./domain/investigation-case.js";

export {
  bugEpisodeDraftFromResult,
  buildBugAnalysisJob,
  buildReproductionPlanningJob,
  reproducedAttemptIds,
  ReproductionPlanError,
  reproductionPlanFromResult,
} from "./application/reproduction-planner.js";

export type {
  BuildIntelligenceJobInput,
  ReproductionPlan,
} from "./application/reproduction-planner.js";

export { InvestigationCoordinator } from "./application/investigation-coordinator.js";

export type {
  BugAnalysisContext,
  InvestigateInput,
  InvestigationCoordinatorConfig,
  InvestigationModelAgentPort,
  InvestigationOutcome,
  ReproductionPlanningContext,
  ReproductionRunnerPort,
} from "./application/investigation-coordinator.js";
