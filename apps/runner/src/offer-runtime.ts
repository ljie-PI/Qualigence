import type { ExecutionJobOffer, ExecutionCompletion } from "@qualigence/runner-protocol";
import {
  DESKTOP_UIA_V1_CAPABILITY_TOKENS,
  WEB_OBSERVATION_V1_CAPABILITY_TOKENS,
  capabilities,
} from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import type { RunnerSpool } from "@qualigence/runner-spool";
import {
  DeterministicRunnerPolicyGate,
  ExecutionTargetError,
} from "@qualigence/runner-kernel";
import { PlaywrightWebTargetAdapter } from "@qualigence/web-playwright";
import type { ActionValueProvider } from "./action-value-provider.js";
import {
  AcceptedLeaseLifecycle,
  assertOfferCapabilities,
  LeasedJobExecutor,
  type AcceptedLeaseLifecycleOptions,
} from "./job-executor.js";
import type { RunnerConfig } from "./config.js";
import { SpoolingTraceRecorder } from "./spooling-trace-recorder.js";
import { TraceUploadPump } from "./trace-upload-pump.js";
import { RunnerAppError } from "./errors.js";

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
    const currentCapabilities = runnerCapabilities(this.options.valueProvider);
    switch (offer.job.target.kind) {
      case "web":
        break;
      case "desktop":
        throw new RunnerAppError("CapabilityMismatch", "desktop target runtime support is deferred to Ticket 28", {
          details: { missingCapabilities: DESKTOP_UIA_V1_CAPABILITY_TOKENS },
        });
    }
    assertWebObservationV1Requirements(offer);
    const offerWithLiveObservationRequirements = {
      ...offer,
      requiredCapabilities: [
        ...new Set([
          ...offer.requiredCapabilities,
          ...WEB_OBSERVATION_V1_CAPABILITY_TOKENS,
        ]),
      ],
    };
    assertOfferCapabilities(offerWithLiveObservationRequirements, currentCapabilities);
    const admission = DeterministicRunnerPolicyGate.admitJob(offer.job);
    if (admission.status === "denied") {
      const lease = await this.options.session.accept(offer.offerId);
      const lifecycle = new AcceptedLeaseLifecycle(
        offer,
        this.options.session as RunnerSession,
        lease,
        signal,
        this.options.leaseLifecycle,
      );
      const completion: ExecutionCompletion = {
        jobId: lease.jobId,
        runId: lease.runId,
        status: "blocked",
        errorCode: admission.code,
      };
      try {
        await lifecycle.duringLease(() =>
          this.options.session.complete(lifecycle.currentLease(), completion));
        await lifecycle.finish(completion);
      } finally {
        await lifecycle.dispose();
      }
      return;
    }

    const targetUrl = offer.job.target.url;
    const expectedOrigin = new URL(targetUrl).origin;
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
        url: targetUrl,
        expectedOrigin,
        headed: this.options.config.headed,
        navigationTimeoutMs: this.options.config.navigationTimeoutMs,
        actionTimeoutMs: this.options.config.actionTimeoutMs,
        allowedOrigins: offer.job.policy.allowedOrigins,
        ...(this.options.valueProvider === undefined ? {} : { valueProvider: this.options.valueProvider }),
      });
      adapter = target;
      try {
        await lifecycle.duringLease((startupSignal) => target.start(startupSignal));
      } catch (error) {
        if (!(error instanceof ExecutionTargetError)) throw error;
        const completionStatus = error.completionStatus;
        const errorCode = error.errorCode;
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
        await lifecycle.duringLease(() => new SpoolingTraceRecorder(this.options.spool).append({
          runId: lease.runId,
          stage: "run_completed",
          payload: completion.status === "blocked"
            ? { status: "blocked", errorCode }
            : { status: "error", errorCode },
        }).then(() => undefined));
        await lifecycle.duringLease((finalizationSignal) =>
          this.finalize(lifecycle, completion, finalizationSignal));
        await lifecycle.finish(completion);
        return;
      }
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
      await executor.execute(
        offer,
        this.options.session as RunnerSession,
        signal,
        lifecycle,
        ({ completion, signal: finalizationSignal }) =>
          this.finalize(lifecycle, completion, finalizationSignal),
      );
    } finally {
      try {
        await adapter?.close();
      } finally {
        await lifecycle.dispose();
      }
    }
  }

  private async finalize(
    lifecycle: AcceptedLeaseLifecycle,
    completion: ExecutionCompletion,
    signal: AbortSignal,
  ): Promise<void> {
    await new TraceUploadPump(this.options.spool, this.options.session, completion.runId, {
      maximumEvents: this.options.session.welcome.traceBatchMaximumEvents,
      maximumBytes: this.options.session.welcome.traceBatchMaximumBytes,
    }).drain(signal);
    signal.throwIfAborted();
    await this.options.session.complete(lifecycle.currentLease(), completion);
  }
}

function assertWebObservationV1Requirements(offer: ExecutionJobOffer): void {
  if (offer.job.target.kind !== "web") return;
  const required = new Set(offer.requiredCapabilities);
  const missing = WEB_OBSERVATION_V1_CAPABILITY_TOKENS.filter((token) => !required.has(token));
  if (missing.length === 0) return;
  throw new RunnerAppError("CapabilityMismatch", "web offers must require Observation Graph v1 and web/v1 capabilities", {
    details: { missingCapabilities: missing },
  });
}

export function runnerCapabilities(valueProvider?: ActionValueProvider) {
  return capabilities({
    targetAdapters: ["web-playwright"],
    observationExtensions: ["observation-graph/v1", "web/v1"],
    actionKinds: valueProvider === undefined
      ? ["navigate", "click", "scroll"]
      : ["navigate", "click", "input", "select", "scroll"],
  });
}
