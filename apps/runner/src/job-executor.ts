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
  type ActionExecutor,
  type ActionResolver,
  type ExecutionDecisionProvider,
  type ExecutionPermit,
  type Observer,
  type ResolvedAction,
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
}

export interface LeasedJobResult {
  readonly lease: ExecutionJobLease;
  readonly completion: ExecutionCompletion;
  readonly window: LeaseWindow;
}

function defaultClocks(): LeaseWindowClocks {
  return {
    monotonicNow: (): number => Math.trunc(performance.now()),
    wallNow: (): number => Date.now(),
  };
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
  ): Promise<LeasedJobResult> {
    const negotiation = negotiateCapabilities(this.deps.capabilities, offer.requiredCapabilities);
    if (negotiation.outcome === "rejected") {
      throw new RunnerAppError("CapabilityMismatch", "runner cannot satisfy the offer's requirements", {
        details: { missingCapabilities: negotiation.rejection.missingCapabilities },
      });
    }

    const initialLease = await session.accept(offer.offerId);
    const window = new LeaseWindow(initialLease, this.clocks, {
      leaseDurationMs: offer.leaseDurationMs,
      actionDeadlineSafetyMarginMs: this.safetyMarginMs,
    });
    this.currentWindow = window;

    const executionAbort = new AbortController();
    const guardedSignal = signal === undefined
      ? executionAbort.signal
      : AbortSignal.any([signal, executionAbort.signal]);
    const controllerDependencies = {
      session,
      initialLease,
      window,
      leaseDurationMs: offer.leaseDurationMs,
      executionAbort,
    };
    const controller = new LeaseRenewalController(
      this.deps.renewalDelay === undefined
        ? controllerDependencies
        : { ...controllerDependencies, delay: this.deps.renewalDelay },
    );
    let renewalError: unknown;
    const renewal = controller.run(signal ?? new AbortController().signal).catch((error: unknown) => {
      renewalError = error;
    });

    const guardedExecutor: ActionExecutor = {
      execute: async (action: ResolvedAction, permit: ExecutionPermit) => {
        if (guardedSignal.aborted || !window.mayStartAction()) {
          throw new ExecutionBlockedError("LeaseExpired");
        }
        return this.deps.actionExecutor.execute(action, permit);
      },
    };

    const runtime = new ExecutionRuntime({
      observer: this.deps.observer,
      decisionProvider: this.deps.decisionProvider,
      resolver: this.deps.resolver,
      policyGate: this.deps.policyGate,
      actionExecutor: guardedExecutor,
      verifier: this.deps.verifier,
      traceRecorder: new SpoolingTraceRecorder(this.deps.spool),
    });

    const runtimeResult = await runtime.run(offer.job).then(
      (completion) => ({ status: "fulfilled" as const, completion }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    controller.stop();
    await renewal;
    if (renewalError !== undefined) throw renewalError;
    if (runtimeResult.status === "rejected") throw runtimeResult.error;
    return { lease: controller.currentLease(), completion: runtimeResult.completion, window };
  }
}
