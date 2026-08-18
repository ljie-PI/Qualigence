export {
  ExecutionBlockedError,
  ExecutionPermit,
  ExecutionRuntime,
  classifyDesktopActionRisk,
  isDesktopAction,
  isWebAction,
  resolvedActionNodeId,
} from "./execution-runtime.js";

export type {
  ActionExecutor,
  ActionOutcome,
  ActionResolver,
  AgentContext,
  ExecutionDecisionProvider,
  ExecutionPermitDescriptor,
  ExecutionRisk,
  ExecutionRuntimeDependencies,
  PolicyDecision,
  ProposedAction,
  Observer,
  ResolvedAction,
  ResolvedDesktopAction,
  ResolvedWebAction,
  RunnerPolicyContext,
  RunnerPolicyGate,
  TraceEventInput,
  TraceRecorder,
  VerificationContext,
  VerificationResult,
  Verifier,
} from "./execution-runtime.js";

export { DeterministicRunnerPolicyGate } from "./deterministic-policy-gate.js";
export type { DeterministicRunnerPolicyGateOptions, TargetAdmission } from "./deterministic-policy-gate.js";
