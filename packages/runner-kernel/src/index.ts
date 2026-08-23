export {
  ActionOutcomeUnknownError,
  ExecutionBlockedError,
  ExecutionPermit,
  ExecutionRuntime,
  ExecutionTargetError,
  TerminalTracePersistenceError,
  classifyDesktopActionRisk,
  isDesktopAction,
  isWebAction,
  resolvedActionNodeId,
  toDecisionTracePayload,
  toResolvedActionTracePayload,
} from "./execution-runtime.js";

export type {
  ActionExecutor,
  ActionAuthorizationWindow,
  ActionOutcome,
  ActionResolver,
  AgentContext,
  AnyProposedAction,
  AnyResolvedAction,
  AnyResolvedWebAction,
  ExecutionDecisionProvider,
  ExecutionPermitDescriptor,
  ExecutionRisk,
  ExecutionRuntimeDependencies,
  ExecutionTargetErrorStatus,
  PolicyDecision,
  ProposedAction,
  ProposedActionKind,
  Observer,
  ResolvedAction,
  ResolvedDesktopAction,
  ResolvedWebAction,
  ResolvedWebActionKind,
  RunnerPolicyContext,
  RunnerPolicyGate,
  TraceEventInput,
  TraceRecorder,
  VerificationContext,
  VerificationResult,
  Verifier,
} from "./execution-runtime.js";

export { DeterministicExecutionBudget, ExecutionBudgetError } from "./execution-budget.js";
export type {
  DeterministicExecutionBudgetOptions,
  ExecutionBudget,
  ExecutionBudgetErrorCode,
  ModelUsage,
  MonotonicClock,
} from "./execution-budget.js";

export { DeterministicRunnerPolicyGate } from "./deterministic-policy-gate.js";
export type { DeterministicRunnerPolicyGateOptions, TargetAdmission } from "./deterministic-policy-gate.js";
