import { randomBytes } from "node:crypto";
import type {
  ArtifactManifestStore,
  ArtifactStore,
  RunStore,
  TraceStore,
} from "@qualigence/evidence";
import { TraceIngestor } from "@qualigence/evidence";
import type {
  RunExecutionRequest,
  RunResourceFactory,
  RunResourceScope,
} from "@qualigence/execution-application";
import type { RunnerConnectionPort } from "@qualigence/grpc-runner-protocol";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import type { AcceptedExecutionJob, ExecutionJobLease } from "@qualigence/runner-protocol";
import { ExecutionRuntime } from "@qualigence/runner-kernel";
import type { RunnerPolicyGate } from "@qualigence/runner-kernel";
import type { RemoteRunnerTarget } from "./remote-runner-target.js";

/** Persistence ports for one Run, opened together and closed together. */
export interface RunnerBackedRunResources {
  readonly runs: RunStore;
  readonly traces: TraceStore;
  readonly artifacts: ArtifactStore;
  readonly manifests: ArtifactManifestStore;
  close(): Promise<void>;
}

export interface RunnerBackedRunResourceFactoryOptions {
  /**
   * Core-facing seam to a connected Runner. The factory calls
   * {@link RunnerConnectionPort.offer} to acquire a single-owner Lease before any
   * action is dispatched, and {@link RunnerConnectionPort.cancel} when the scope
   * closes.
   */
  readonly connection: RunnerConnectionPort;
  /** Opens the per-call execution channel to the leased Runner. */
  readonly openTarget: (
    runId: string,
    request: RunExecutionRequest,
    lease: ExecutionJobLease,
  ) => Promise<RemoteRunnerTarget>;
  /** Opens the Core-side persistence ports (SQLite in production, in-memory in tests). */
  readonly openStores: (runId: string, request: RunExecutionRequest) => Promise<RunnerBackedRunResources>;
  /** Core-side policy gate; authorization stays on the Core, never the Runner. */
  readonly policyGate: RunnerPolicyGate;
  readonly requiredCapabilities?: readonly string[];
  readonly generateJobId?: () => string;
}

/**
 * The Core Daemon's remote-Runner-backed {@link RunResourceFactory} (LS-05 design
 * §4.1). It preserves — never replaces — the LS-03 resource seam: it wraps a
 * {@link RunnerConnectionPort} and returns a {@link RunResourceScope} whose
 * `runtime` is a real {@link ExecutionRuntime} whose Observer, Resolver and
 * ActionExecutor dispatch to a leased Runner instead of an in-process Playwright
 * adapter. Because the switch happens entirely behind the scope, the public
 * `RunExecutionUseCase.execute(request)` interface is unchanged and never imports
 * a transport type. Trace is recorded on the Core side through the
 * {@link TraceIngestor} into the Run's own {@link TraceStore}.
 */
export class RunnerBackedRunResourceFactory implements RunResourceFactory {
  private readonly connection: RunnerConnectionPort;
  private readonly openTarget: RunnerBackedRunResourceFactoryOptions["openTarget"];
  private readonly openStores: RunnerBackedRunResourceFactoryOptions["openStores"];
  private readonly policyGate: RunnerPolicyGate;
  private readonly requiredCapabilities: readonly string[];
  private readonly generateJobId: () => string;

  constructor(options: RunnerBackedRunResourceFactoryOptions) {
    this.connection = options.connection;
    this.openTarget = options.openTarget;
    this.openStores = options.openStores;
    this.policyGate = options.policyGate;
    this.requiredCapabilities = options.requiredCapabilities ?? ["target:web-playwright"];
    this.generateJobId = options.generateJobId ?? ((): string => randomBytes(16).toString("hex"));
  }

  async open(runId: string, request: RunExecutionRequest): Promise<RunResourceScope> {
    const stores = await this.openStores(runId, request);

    const job: AcceptedExecutionJob = {
      jobId: this.generateJobId(),
      runId,
      target: { kind: "web", url: request.target.url },
      objective: request.objective,
    };

    let lease: ExecutionJobLease;
    let target: RemoteRunnerTarget;
    try {
      lease = await this.connection.offer(job, this.requiredCapabilities);
      target = await this.openTarget(runId, request, lease);
    } catch (cause) {
      await stores.close().catch(() => undefined);
      throw cause;
    }

    const runtime = new ExecutionRuntime({
      observer: target,
      decisionProvider: target,
      resolver: target,
      policyGate: this.policyGate,
      actionExecutor: target,
      verifier: target,
      traceRecorder: new InMemoryProtocolTraceRecorder(new TraceIngestor(stores.traces)),
    });

    const connection = this.connection;
    return {
      runtime,
      artifacts: stores.artifacts,
      manifests: stores.manifests,
      runs: stores.runs,
      traces: stores.traces,
      close: async (): Promise<void> => {
        let firstError: unknown;
        try {
          await connection.cancel(job.jobId, "run scope closed");
        } catch (cause) {
          firstError = cause;
        }
        try {
          await target.close();
        } catch (cause) {
          firstError ??= cause;
        }
        try {
          await stores.close();
        } catch (cause) {
          firstError ??= cause;
        }
        if (firstError !== undefined) {
          throw firstError;
        }
      },
    };
  }
}
