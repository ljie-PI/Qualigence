import type { ExecutionJobOffer, ExecutionCompletion } from "@qualigence/runner-protocol";
import { capabilities } from "@qualigence/runner-protocol";
import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import type { RunnerSpool } from "@qualigence/runner-spool";
import { DeterministicRunnerPolicyGate } from "@qualigence/runner-kernel";
import { PlaywrightWebTargetAdapter } from "@qualigence/web-playwright";
import { LeasedJobExecutor } from "./job-executor.js";
import type { RunnerConfig } from "./config.js";
import { TraceUploadPump } from "./trace-upload-pump.js";

export interface RunnerOfferRuntimeOptions {
  readonly session: Pick<RunnerSession, "accept" | "complete" | "submit" | "welcome">;
  readonly spool: RunnerSpool;
  readonly config: RunnerConfig;
  readonly createTarget?: (options: ConstructorParameters<typeof PlaywrightWebTargetAdapter>[0]) => PlaywrightWebTargetAdapter;
}

/** The sole remote Runner composition for one untrusted offered Job. */
export class RunnerOfferRuntime {
  private readonly createTarget: NonNullable<RunnerOfferRuntimeOptions["createTarget"]>;

  constructor(private readonly options: RunnerOfferRuntimeOptions) {
    this.createTarget = options.createTarget ?? ((targetOptions) => new PlaywrightWebTargetAdapter(targetOptions));
  }

  async run(offer: ExecutionJobOffer): Promise<void> {
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

    const adapter = this.createTarget({
      url: offer.job.target.url,
      headed: this.options.config.headed,
      navigationTimeoutMs: this.options.config.navigationTimeoutMs,
      actionTimeoutMs: this.options.config.actionTimeoutMs,
      allowedOrigins: offer.job.policy.allowedOrigins,
    });
    await adapter.start();
    try {
      const { ModelBackedDecisionProvider, ModelBackedVerifier } = await import("@qualigence/model-agent");
      const { ModelGateway } = await import("@qualigence/model-gateway");
      const { OpenAICompatibleModelProvider } = await import("@qualigence/openai-compatible-model-provider");
      const provider = new OpenAICompatibleModelProvider({
        baseUrl: this.options.config.model.baseUrl,
        apiKey: this.options.config.model.apiKey,
      });
      const gateway = new ModelGateway({ provider });
      const executor = new LeasedJobExecutor({
        observer: adapter,
        decisionProvider: new ModelBackedDecisionProvider(gateway, this.options.config.model.modelName),
        resolver: adapter,
        policyGate: admission.gate,
        actionExecutor: adapter,
        verifier: new ModelBackedVerifier(gateway, this.options.config.model.modelName),
        spool: this.options.spool,
        capabilities: capabilities({ targetAdapters: ["web-playwright"] }),
      });
      const result = await executor.execute(offer, this.options.session as RunnerSession);
      await new TraceUploadPump(this.options.spool, this.options.session, offer.job.runId, {
        maximumEvents: this.options.session.welcome.traceBatchMaximumEvents,
        maximumBytes: this.options.session.welcome.traceBatchMaximumBytes,
      }).drain();
      await this.options.session.complete(result.lease, result.completion);
    } finally {
      await adapter.close();
    }
  }
}
