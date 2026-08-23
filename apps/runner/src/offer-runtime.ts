import type { ExecutionJobOffer, ExecutionCompletion } from "@qualigence/runner-protocol";
import { capabilities } from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import type { RunnerSpool } from "@qualigence/runner-spool";
import {
  DeterministicRunnerPolicyGate,
  ExecutionBlockedError,
  ExecutionTargetError,
} from "@qualigence/runner-kernel";
import { PlaywrightWebTargetAdapter } from "@qualigence/web-playwright";
import type { ActionValueProvider } from "./action-value-provider.js";
import { isRunnerAppError } from "./errors.js";
import {
  AcceptedLeaseLifecycle,
  assertOfferCapabilities,
  LeasedJobExecutor,
  type AcceptedLeaseLifecycleOptions,
} from "./job-executor.js";
import type { RunnerConfig } from "./config.js";
import { SpoolingTraceRecorder } from "./spooling-trace-recorder.js";
import { TraceUploadPump } from "./trace-upload-pump.js";

export interface RunnerOfferRuntimeOptions {
  readonly session: Pick<RunnerSession, "accept" | "renew" | "complete" | "submit" | "close" | "welcome">;
  readonly spool: RunnerSpool;
  readonly config: RunnerConfig;
  readonly valueProvider?: ActionValueProvider;
  readonly createTarget?: (options: ConstructorParameters<typeof PlaywrightWebTargetAdapter>[0]) => PlaywrightWebTargetAdapter;
  readonly leaseLifecycle?: AcceptedLeaseLifecycleOptions;
}

/** The sole remote Runner composition for one untrusted offered Job. */
export class RunnerOfferRuntime {
  private readonly createTarget: NonNullable<RunnerOfferRuntimeOptions["createTarget"]>;

  constructor(private readonly options: RunnerOfferRuntimeOptions) {
    this.createTarget = options.createTarget ?? ((targetOptions) => new PlaywrightWebTargetAdapter(targetOptions));
  }

  async run(offer: ExecutionJobOffer, signal?: AbortSignal): Promise<void> {
    const admission = DeterministicRunnerPolicyGate.admitJob(offer.job);
    if (admission.status === "denied") {
      const lease = await this.options.session.accept(offer.offerId);
      const completion: ExecutionCompletion = {
        jobId: lease.jobId,
        runId: lease.runId,
        status: "blocked",
        errorCode: admission.code,
      };
      await this.options.session.complete(lease, completion);
      return;
    }

    const needsValueProvider = offer.job.plan?.steps.some((step) =>
      step.kind === "input" || step.kind === "select") ?? false;
    if (needsValueProvider && this.options.valueProvider === undefined) {
      const lease = await this.options.session.accept(offer.offerId);
      await this.options.session.complete(lease, {
        jobId: lease.jobId,
        runId: lease.runId,
        status: "blocked",
        errorCode: "ActionValueProviderUnavailable",
      });
      return;
    }

    const currentCapabilities = runnerCapabilities(this.options.valueProvider);
    assertOfferCapabilities(offer, currentCapabilities);
    const lease = await this.options.session.accept(offer.offerId);
    const lifecycle = new AcceptedLeaseLifecycle(
      offer,
      this.options.session as RunnerSession,
      lease,
      signal,
      this.options.leaseLifecycle,
    );
    let adapter: PlaywrightWebTargetAdapter | undefined;
    try {
      const target = this.createTarget({
        url: offer.job.target.url,
        headed: this.options.config.headed,
        navigationTimeoutMs: this.options.config.navigationTimeoutMs,
        actionTimeoutMs: this.options.config.actionTimeoutMs,
        allowedOrigins: offer.job.policy.allowedOrigins,
        ...(this.options.valueProvider === undefined ? {} : { valueProvider: this.options.valueProvider }),
      });
      adapter = target;
      let result: {
        readonly lease: typeof lease;
        readonly completion: ExecutionCompletion;
      } | undefined;
      try {
        await lifecycle.duringLease((startupSignal) => target.start(startupSignal));
      } catch (error) {
        if (
          !(error instanceof ExecutionTargetError) &&
          !(error instanceof ExecutionBlockedError && error.errorCode === "LeaseExpired") &&
          !(isRunnerAppError(error) && error.code === "LeaseExpired")
        ) throw error;
        const completionStatus = error instanceof ExecutionTargetError
          ? error.completionStatus
          : "blocked";
        const errorCode = error instanceof ExecutionTargetError
          ? error.errorCode
          : error instanceof ExecutionBlockedError
            ? error.errorCode
            : error.code;
        const completion: ExecutionCompletion = completionStatus === "blocked"
          ? {
              jobId: lease.jobId,
              runId: lease.runId,
              status: "blocked",
              errorCode,
            }
          : {
              jobId: lease.jobId,
              runId: lease.runId,
              status: "error",
              errorCode,
            };
        const completionLease = await lifecycle.finish(completion);
        await new SpoolingTraceRecorder(this.options.spool).append({
          runId: lease.runId,
          stage: "run_completed",
          payload: completion.status === "blocked"
            ? { status: "blocked", errorCode }
            : { status: "error", errorCode },
        });
        result = { lease: completionLease, completion };
      }
      if (result === undefined) {
        const { ModelBackedDecisionProvider, ModelBackedVerifier } = await import("@qualigence/model-agent");
        const { ModelGateway } = await import("@qualigence/model-gateway");
        const { OpenAICompatibleModelProvider } = await import("@qualigence/openai-compatible-model-provider");
        const provider = new OpenAICompatibleModelProvider({
          baseUrl: this.options.config.model.baseUrl,
          apiKey: this.options.config.model.apiKey,
        });
        const gateway = new ModelGateway({ provider });
        const executor = new LeasedJobExecutor({
          observer: target,
          decisionProvider: new ModelBackedDecisionProvider(
            gateway,
            this.options.config.model.modelName,
          ),
          resolver: target,
          policyGate: admission.gate,
          actionExecutor: target,
          verifier: new ModelBackedVerifier(gateway, this.options.config.model.modelName),
          spool: this.options.spool,
          capabilities: currentCapabilities,
          objectiveOnlyMaximumWallClockMs: this.options.config.actionTimeoutMs,
          objectiveOnlyMaximumModelTokens: this.options.config.model.maximumTokensPerCall,
        });
        result = await executor.execute(
          offer,
          this.options.session as RunnerSession,
          signal,
          lifecycle,
        );
      }
      await new TraceUploadPump(this.options.spool, this.options.session, result.lease.runId, {
        maximumEvents: this.options.session.welcome.traceBatchMaximumEvents,
        maximumBytes: this.options.session.welcome.traceBatchMaximumBytes,
      }).drain();
      await this.options.session.complete(result.lease, result.completion);
    } finally {
      try {
        await adapter?.close();
      } finally {
        await lifecycle.dispose();
      }
    }
  }
}

export function runnerCapabilities(valueProvider?: ActionValueProvider) {
  return capabilities({
    targetAdapters: ["web-playwright"],
    actionKinds: valueProvider === undefined
      ? ["navigate", "click", "scroll"]
      : ["navigate", "click", "input", "select", "scroll"],
  });
}
