import type {
  ActionExecutor,
  ActionResolver,
  ExecutionDecisionProvider,
  Observer,
  Verifier,
} from "@qualigence/runner-kernel";

/**
 * The per-call execution channel a Core-side {@link RunResourceScope} uses to
 * drive the fixed {@link import("@qualigence/runner-kernel").ExecutionRuntime}
 * pipeline against a remote Runner instead of an in-process Playwright adapter.
 *
 * It is the union of the runner-kernel dependency seams that are hosted on the
 * Runner (observe, decide, resolve, execute, verify). The Core Daemon supplies a
 * concrete implementation that dispatches each call over a leased Runner
 * connection; the policy gate and Trace recorder stay Core-side, so the Core
 * remains the sole authority over authorization and durable Trace. Neither this
 * interface nor {@link import("@qualigence/execution-application").RunExecutionUseCase}
 * imports any Protobuf/gRPC type.
 */
export interface RemoteRunnerTarget
  extends Observer,
    ExecutionDecisionProvider,
    ActionResolver,
    ActionExecutor,
    Verifier {
  close(): Promise<void>;
}
