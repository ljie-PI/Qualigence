import type {
  ExecutionCompletion,
  ExecutionJobLease,
  ExecutionJobOffer,
  RunnerCapabilities,
} from "@qualigence/runner-protocol";
import { negotiateCapabilities } from "@qualigence/runner-protocol";
import {
  ExecutionBlockedError,
  ExecutionRuntime,
  TerminalTracePersistenceError,
  type ActionAuthorizationWindow,
  type ActionExecutor,
  type ActionResolver,
  type ExecutionDecisionProvider,
  type ExecutionBudget,
  type Observer,
  type RunnerPolicyGate,
  type Verifier,
} from "@qualigence/runner-kernel";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import type { RunnerSpool } from "@qualigence/runner-spool";
import { RunnerAppError } from "./errors.js";
import {
  LeaseRenewalController,
  type RenewalDelay,
} from "./lease-renewal-controller.js";
import { LeaseWindow, type LeaseWindowClocks } from "./lease-window.js";
import { SpoolingTraceRecorder } from "./spooling-trace-recorder.js";

const DEFAULT_ACTION_DEADLINE_SAFETY_MARGIN_MS = 2_000;

export interface LeasedJobExecutorDependencies {
  readonly observer: Observer;
  readonly decisionProvider: ExecutionDecisionProvider;
  readonly resolver: ActionResolver;
  readonly policyGate: RunnerPolicyGate;
  readonly actionExecutor: ActionExecutor;
  readonly verifier: Verifier;
  readonly spool: RunnerSpool;
  readonly capabilities: RunnerCapabilities;
  readonly clocks?: LeaseWindowClocks;
  readonly actionDeadlineSafetyMarginMs?: number;
  readonly renewalDelay?: RenewalDelay;
  readonly objectiveOnlyMaximumWallClockMs?: number;
  readonly objectiveOnlyMaximumModelTokens?: number;
  readonly budget?: ExecutionBudget;
}

export interface AcceptedLeaseLifecycleOptions {
  readonly clocks?: LeaseWindowClocks;
  readonly actionDeadlineSafetyMarginMs?: number;
  readonly renewalDelay?: RenewalDelay;
}

export interface LeasedJobResult {
  readonly lease: ExecutionJobLease;
  readonly completion: ExecutionCompletion;
  readonly window: LeaseWindow;
}

type RenewalResult =
  | { readonly status: "fulfilled" }
  | { readonly status: "rejected"; readonly error: unknown };

export function assertOfferCapabilities(
  offer: ExecutionJobOffer,
  runnerCapabilities: RunnerCapabilities,
): void {
  const negotiation = negotiateCapabilities(runnerCapabilities, offer.requiredCapabilities);
  if (negotiation.outcome === "rejected") {
    throw new RunnerAppError("CapabilityMismatch", "runner cannot satisfy the offer's requirements", {
      details: { missingCapabilities: negotiation.rejection.missingCapabilities },
    });
  }
}

function defaultClocks(): LeaseWindowClocks {
  return {
    monotonicNow: (): number => Math.trunc(performance.now()),
    wallNow: (): number => Date.now(),
  };
}

/** One authoritative lease window spanning accepted-Job startup and execution. */
export class AcceptedLeaseLifecycle implements ActionAuthorizationWindow {
  readonly window: LeaseWindow;
  readonly signal: AbortSignal;
  private readonly controller: LeaseRenewalController;
  private readonly executionAbort: AbortController;
  private readonly renewal: Promise<RenewalResult>;

  constructor(
    offer: ExecutionJobOffer,
    session: RunnerSession,
    initialLease: ExecutionJobLease,
    callerSignal?: AbortSignal,
    options: AcceptedLeaseLifecycleOptions = {},
  ) {
    const clocks = options.clocks ?? defaultClocks();
    this.window = new LeaseWindow(initialLease, clocks, {
      leaseDurationMs: offer.leaseDurationMs,
      actionDeadlineSafetyMarginMs:
        options.actionDeadlineSafetyMarginMs ?? DEFAULT_ACTION_DEADLINE_SAFETY_MARGIN_MS,
    });
    const executionAbort = new AbortController();
    this.executionAbort = executionAbort;
    this.signal = callerSignal === undefined
      ? executionAbort.signal
      : AbortSignal.any([callerSignal, executionAbort.signal]);
    const controllerDependencies = {
      session,
      initialLease,
      window: this.window,
      leaseDurationMs: offer.leaseDurationMs,
      executionAbort,
    };
    this.controller = new LeaseRenewalController(
      options.renewalDelay === undefined
        ? controllerDependencies
        : { ...controllerDependencies, delay: options.renewalDelay },
    );
    this.renewal = this.controller.run(callerSignal ?? new AbortController().signal).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
  }

  currentLease(): ExecutionJobLease {
    return this.controller.currentLease();
  }

  mayStartAction(): boolean {
    return !this.signal.aborted && this.window.mayStartAction();
  }

  assertActionAuthorized(): void {
    this.assertActive();
  }

  async duringLease<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertActive();
    const operationResult = Promise.resolve().then(() => operation(this.signal));
    const renewalFailure = this.renewal.then((result) => {
      if (result.status === "rejected") throw result.error;
      return new Promise<never>(() => undefined);
    });
    let rejectAborted: ((reason: unknown) => void) | undefined;
    const abortOperation = (): void => rejectAborted?.(this.signal.reason);
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
      this.signal.addEventListener("abort", abortOperation, { once: true });
    });
    let value: T;
    try {
      value = await Promise.race([operationResult, renewalFailure, aborted]);
    } finally {
      this.signal.removeEventListener("abort", abortOperation);
    }
    this.assertActive();
    return value;
  }

  async finish(completion?: ExecutionCompletion): Promise<ExecutionJobLease> {
    this.controller.stop();
    const renewal = await this.renewal;
    if (
      renewal.status === "rejected" &&
      !(completion?.status === "error" && completion.errorCode === "ActionOutcomeUnknown") &&
      !(
        completion?.status === "blocked" &&
        completion.errorCode === "LeaseExpired" &&
        renewal.error instanceof RunnerAppError &&
        renewal.error.code === "LeaseExpired"
      )
    ) {
      throw renewal.error;
    }
    return this.currentLease();
  }

  async dispose(): Promise<void> {
    this.controller.stop();
    await this.renewal;
  }

  private assertActive(): void {
    if (this.signal.aborted) throw this.signal.reason;
    if (!this.window.mayStartAction()) {
      const error = new ExecutionBlockedError("LeaseExpired");
      this.window.close();
      this.executionAbort.abort(error);
      throw error;
    }
  }
}

/**
 * Executes one leased Job on the Runner (LS-05 design §5). It accepts an Offer
 * only after capability negotiation succeeds, derives a conservative monotonic
 * action window from the Lease, and drives the fixed
 * {@link ExecutionRuntime} pipeline while writing every Trace event to the Spool
 * first. Its action executor is wrapped so a new action is refused — locally,
 * as defense in depth — once the Lease window closes, even if Core has not yet
 * revoked it.
 */
export class LeasedJobExecutor {
  private readonly clocks: LeaseWindowClocks;
  private readonly safetyMarginMs: number;
  private currentWindow: LeaseWindow | undefined;

  constructor(private readonly deps: LeasedJobExecutorDependencies) {
    this.clocks = deps.clocks ?? defaultClocks();
    this.safetyMarginMs = deps.actionDeadlineSafetyMarginMs ?? DEFAULT_ACTION_DEADLINE_SAFETY_MARGIN_MS;
  }

  /** True only while the current lease window still permits a new action. */
  mayStartNextAction(): boolean {
    return this.currentWindow?.mayStartAction() ?? false;
  }

  /**
   * Negotiate capabilities, accept the Offer and run the leased Job, spooling all
   * Trace. Throws {@link RunnerAppError} `CapabilityMismatch` before accepting
   * when a required capability is unmet, so no Job payload is executed under a
   * silent downgrade.
   */
  async execute(
    offer: ExecutionJobOffer,
    session: RunnerSession,
    signal?: AbortSignal,
    acceptedLifecycle?: AcceptedLeaseLifecycle,
  ): Promise<LeasedJobResult> {
    assertOfferCapabilities(offer, this.deps.capabilities);
    const lifecycle = acceptedLifecycle ?? new AcceptedLeaseLifecycle(
      offer,
      session,
      await session.accept(offer.offerId),
      signal,
      {
        clocks: this.clocks,
        actionDeadlineSafetyMarginMs: this.safetyMarginMs,
        ...(this.deps.renewalDelay === undefined ? {} : { renewalDelay: this.deps.renewalDelay }),
      },
    );
    const window = lifecycle.window;
    this.currentWindow = window;
    const guardedSignal = lifecycle.signal;

    const runtime = new ExecutionRuntime({
      observer: this.deps.observer,
      decisionProvider: this.deps.decisionProvider,
      resolver: this.deps.resolver,
      policyGate: this.deps.policyGate,
      actionExecutor: this.deps.actionExecutor,
      actionAuthorizationWindow: lifecycle,
      verifier: this.deps.verifier,
      traceRecorder: new SpoolingTraceRecorder(this.deps.spool),
      ...(this.deps.budget === undefined ? {} : { budget: this.deps.budget }),
      ...(this.deps.objectiveOnlyMaximumWallClockMs === undefined
        ? {}
        : { objectiveOnlyMaximumWallClockMs: this.deps.objectiveOnlyMaximumWallClockMs }),
      ...(this.deps.objectiveOnlyMaximumModelTokens === undefined
        ? {}
        : { objectiveOnlyMaximumModelTokens: this.deps.objectiveOnlyMaximumModelTokens }),
    });

    const runtimeResult = await runtime.run(offer.job, guardedSignal).then(
      (completion) => ({ status: "fulfilled" as const, completion }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    let lease: ExecutionJobLease;
    try {
      lease = await lifecycle.finish(
        runtimeResult.status === "fulfilled" ? runtimeResult.completion : undefined,
      );
    } catch (renewalError) {
      if (
        runtimeResult.status === "rejected" &&
        runtimeResult.error instanceof TerminalTracePersistenceError
      ) {
        throw runtimeResult.error;
      }
      throw renewalError;
    }
    if (runtimeResult.status === "rejected") throw runtimeResult.error;
    return { lease, completion: runtimeResult.completion, window };
  }
}
