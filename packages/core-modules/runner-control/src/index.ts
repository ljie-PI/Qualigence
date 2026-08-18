export type {
  AuthenticatedRunnerContext,
  RunnerAuthorizationScope,
  RunnerProtocolApplication,
} from "./runner-protocol-application.js";

export type {
  HashedResumeTokenRecord,
  PersistedExecutionLease,
  PersistedLeaseOwner,
  PersistedRunnerSession,
  ResumePresentedIdentity,
  ResumeTokenBinding,
  RotateResumeTokenInput,
  RotateResumeTokenResult,
  RunnerControlIntegrityEvent,
  RunnerControlIntegrityEventSink,
  RunnerControlIntegrityKind,
  RunnerControlStore,
} from "./runner-control-store.js";

export {
  classifyCompletion,
  leaseBindingMatches,
} from "./runner-control-store.js";

export const RUNNER_CONTROL_PACKAGE = "@qualigence/runner-control";
