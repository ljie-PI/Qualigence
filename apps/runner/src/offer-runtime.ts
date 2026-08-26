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
import { ArtifactUploadPump } from "./artifact-upload-pump.js";
import { SpoolingArtifactObserver } from "./spooling-artifact-observer.js";
import { SpoolingTraceRecorder } from "./spooling-trace-recorder.js";
import { TraceUploadPump } from "./trace-upload-pump.js";
import { RunnerAppError } from "./errors.js";
import { TargetRuntimeFactory, type DesktopCompanionRuntimeClient, type TargetRuntimeResourceSet } from "./target-runtime-factory.js";

export interface RunnerOfferRuntimeOptions {
  readonly session: Pick<RunnerSession, "accept" | "renew" | "complete" | "submit" | "close" | "welcome" | "registerArtifactManifest" | "uploadArtifactChunk">;
  readonly spool: RunnerSpool;
  readonly config: RunnerConfig;
  readonly valueProvider?: ActionValueProvider;
  readonly tenantId?: string;
  readonly createTarget?: (options: ConstructorParameters<typeof PlaywrightWebTargetAdapter>[0]) => PlaywrightWebTargetAdapter;
  readonly companion?: DesktopCompanionRuntimeClient;
  /** True only after Runner startup has authenticated and probed the Desktop Companion. */
  readonly desktopReady?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly leaseLifecycle?: AcceptedLeaseLifecycleOptions;
}

/** The sole remote Runner composition for one untrusted offered Job. */
const unavailableVerifier = {
  async verify(): Promise<never> {
    throw new Error("verifier is not available before target runtime open completes");
  },
};

export class RunnerOfferRuntime {
  private readonly createTarget: NonNullable<RunnerOfferRuntimeOptions["createTarget"]>;

  constructor(private readonly options: RunnerOfferRuntimeOptions) {
    this.createTarget = options.createTarget ?? ((targetOptions) => new PlaywrightWebTargetAdapter(targetOptions));
  }

  async run(offer: ExecutionJobOffer, signal?: AbortSignal): Promise<void> {
    const currentCapabilities = runnerCapabilities(this.options.valueProvider, {
      desktopReady: this.options.desktopReady === true && this.options.companion !== undefined && (this.options.platform ?? process.platform) === "win32",
      ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
    });
    assertTargetObservationRequirements(offer);
    const liveObservationRequirements = offer.job.target.kind === "web"
      ? WEB_OBSERVATION_V1_CAPABILITY_TOKENS
      : DESKTOP_UIA_V1_CAPABILITY_TOKENS;
    const offerWithLiveObservationRequirements = {
      ...offer,
      requiredCapabilities: [
        ...new Set([
          ...offer.requiredCapabilities,
          ...liveObservationRequirements,
        ]),
      ],
    };
    assertOfferCapabilities(offerWithLiveObservationRequirements, currentCapabilities);
    const targetJob = structuredClone(offer.job);
    const admission = DeterministicRunnerPolicyGate.admitJob(offer.job);
    if (admission.status === "denied") {
      const lease = await this.options.session.accept(offer.offerId);
      await saveLease(this.options.spool, lease);
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

    const lease = await this.options.session.accept(offer.offerId);
    await saveLease(this.options.spool, lease);
    const lifecycle = new AcceptedLeaseLifecycle(
      offer,
      this.options.session as RunnerSession,
      lease,
      signal,
      this.options.leaseLifecycle,
    );
    let resources: TargetRuntimeResourceSet | undefined;
    let primaryError: unknown;
    try {
      try {
        resources = await lifecycle.duringLease((startupSignal) => new TargetRuntimeFactory({
          config: this.options.config,
          verifier: unavailableVerifier,
          ...(this.options.valueProvider === undefined ? {} : { valueProvider: this.options.valueProvider }),
          ...(this.options.companion === undefined ? {} : { companion: this.options.companion }),
          ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
          createWebTarget: this.createTarget,
        }).open(targetJob, startupSignal));
      } catch (error) {
        if (!isExecutionTargetErrorLike(error)) throw error;
        const targetError = error instanceof ExecutionTargetError
          ? error
          : new ExecutionTargetError(error.errorCode, error.completionStatus);
        const completion = completionForTargetError(lease, targetError);
        await lifecycle.duringLease(() => new SpoolingTraceRecorder(this.options.spool).append({
          runId: lease.runId,
          stage: "run_completed",
          payload: completion.status === "blocked"
            ? { status: "blocked", ...(completion.errorCode === undefined ? {} : { errorCode: completion.errorCode }) }
            : { status: "error", errorCode: targetError.errorCode },
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
      const verifier = new ModelBackedVerifier(gateway, this.options.config.model.modelName);
      const executor = new LeasedJobExecutor({
        observer: this.options.tenantId === undefined || offer.job.target.kind !== "web"
          ? resources.observer
          : new SpoolingArtifactObserver({
              observer: resources.observer,
              source: resources.observer as never,
              spool: this.options.spool,
              tenantId: this.options.tenantId,
            }),
        decisionProvider: new ModelBackedDecisionProvider(
          gateway,
          this.options.config.model.modelName,
        ),
        resolver: resources.resolver,
        policyGate: admission.gate,
        actionExecutor: resources.actionExecutor,
        verifier,
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
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await resources?.close();
      } catch (cleanupError) {
        if (primaryError === undefined) throw cleanupError;
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
    if (this.options.tenantId !== undefined) {
      await new ArtifactUploadPump(this.options.spool, artifactSubmitter(this.options.session), lifecycle.currentLease()).drain(completion.runId, signal);
    }
    await new TraceUploadPump(this.options.spool, this.options.session, completion.runId, {
      maximumEvents: this.options.session.welcome.traceBatchMaximumEvents,
      maximumBytes: this.options.session.welcome.traceBatchMaximumBytes,
    }).drain(signal);
    signal.throwIfAborted();
    await this.options.session.complete(lifecycle.currentLease(), completion);
  }
}

function assertTargetObservationRequirements(offer: ExecutionJobOffer): void {
  const required = new Set(offer.requiredCapabilities);
  const expected = offer.job.target.kind === "web" ? WEB_OBSERVATION_V1_CAPABILITY_TOKENS : DESKTOP_UIA_V1_CAPABILITY_TOKENS;
  const missing = expected.filter((token) => !required.has(token));
  if (missing.length === 0) return;
  throw new RunnerAppError("CapabilityMismatch", "target offers must require their negotiated Observation Graph capabilities", {
    details: { missingCapabilities: offer.job.target.kind === "desktop" ? expected : missing },
  });
}

function isExecutionTargetErrorLike(error: unknown): error is { readonly errorCode: string; readonly completionStatus: "blocked" | "error" } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { readonly errorCode?: unknown }).errorCode === "string" &&
    ((error as { readonly completionStatus?: unknown }).completionStatus === "blocked" ||
      (error as { readonly completionStatus?: unknown }).completionStatus === "error")
  );
}

function completionForTargetError(lease: import("@qualigence/runner-protocol").ExecutionJobLease, error: ExecutionTargetError): ExecutionCompletion {
  return error.completionStatus === "blocked"
    ? { jobId: lease.jobId, runId: lease.runId, status: "blocked", errorCode: error.errorCode }
    : { jobId: lease.jobId, runId: lease.runId, status: "error", errorCode: error.errorCode };
}

function artifactSubmitter(session: Pick<RunnerSession, "registerArtifactManifest" | "uploadArtifactChunk">) {
  if (session.registerArtifactManifest === undefined || session.uploadArtifactChunk === undefined) {
    throw new RunnerAppError("TransportError", "active session does not support artifact upload");
  }
  return {
    registerArtifactManifest: session.registerArtifactManifest.bind(session),
    uploadArtifactChunk: session.uploadArtifactChunk.bind(session),
  };
}

async function saveLease(spool: RunnerSpool, lease: import("@qualigence/runner-protocol").ExecutionJobLease): Promise<void> {
  if (spool.saveLease !== undefined) {
    await spool.saveLease(lease);
  }
}

export function runnerCapabilities(
  valueProvider?: ActionValueProvider,
  options: { readonly desktopReady?: boolean; readonly platform?: NodeJS.Platform } = {},
) {
  const actionKinds = valueProvider === undefined
    ? ["navigate", "click", "scroll"]
    : ["navigate", "click", "input", "select", "scroll"];
  const desktopReady = options.desktopReady === true;
  return capabilities({
    operatingSystem: mapOperatingSystem(options.platform ?? process.platform),
    targetAdapters: desktopReady ? ["web-playwright", "desktop-windows-uia"] : ["web-playwright"],
    observationExtensions: desktopReady
      ? ["observation-graph/v1", "web/v1", "uia/v1"]
      : ["observation-graph/v1", "web/v1"],
    actionKinds: desktopReady ? [...new Set([...actionKinds, "window"])] : actionKinds,
  });
}

function mapOperatingSystem(platform: NodeJS.Platform): "windows" | "macos" | "linux" {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}
