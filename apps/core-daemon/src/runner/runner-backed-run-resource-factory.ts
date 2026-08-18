import { randomBytes } from "node:crypto";
import type {
  ArtifactManifestStore,
  ArtifactStore,
  RunStore,
  TraceStore,
} from "@qualigence/evidence";
import type {
  RunExecutionRequest,
  RunResourceFactory,
  RunResourceScope,
} from "@qualigence/execution-application";
import type { RunnerConnectionPort } from "@qualigence/grpc-runner-protocol";
import { ExecutionPolicySnapshotError, parseExecutionPolicySnapshot } from "@qualigence/runner-protocol";
import type { AcceptedExecutionJob, ExecutionJobLease } from "@qualigence/runner-protocol";
import { CoreApplicationError } from "@qualigence/core-application";

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
  /** Opens the Core-side persistence ports (SQLite in production, in-memory in tests). */
  readonly openStores: (runId: string, request: RunExecutionRequest) => Promise<RunnerBackedRunResources>;
  /** Waits for the Runner's authoritative completion without the raw lease token. */
  readonly awaitCompletion: (lease: ExecutionJobLease) => Promise<import("@qualigence/runner-protocol").ExecutionCompletion>;
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
  private readonly openStores: RunnerBackedRunResourceFactoryOptions["openStores"];
  private readonly awaitCompletion: RunnerBackedRunResourceFactoryOptions["awaitCompletion"];
  private readonly requiredCapabilities: readonly string[];
  private readonly generateJobId: () => string;

  constructor(options: RunnerBackedRunResourceFactoryOptions) {
    this.connection = options.connection;
    this.openStores = options.openStores;
    if ("policyGate" in (options as object)) {
      throw new Error("RunnerBackedRunResourceFactory does not accept policyGate; Runner owns policy admission.");
    }
    this.awaitCompletion = options.awaitCompletion;
    this.requiredCapabilities = options.requiredCapabilities ?? ["target:web-playwright"];
    this.generateJobId = options.generateJobId ?? ((): string => randomBytes(16).toString("hex"));
  }

  async open(runId: string, request: RunExecutionRequest): Promise<RunResourceScope> {
    if (typeof request.projectId !== "string" || request.projectId.trim().length === 0) {
      throw new CoreApplicationError("PolicyMissing", "execution request project provenance is missing");
    }
    try {
      parseExecutionPolicySnapshot(request.policy);
    } catch (error) {
      if (error instanceof ExecutionPolicySnapshotError) {
        throw new CoreApplicationError("PolicyMissing", "execution request policy is missing or malformed");
      }
      throw error;
    }
    const stores = await this.openStores(runId, request);

    let offeredJob: AcceptedExecutionJob | undefined;
    try {
      return {
        execute: async (acceptedJob: AcceptedExecutionJob) => {
          if (acceptedJob.policy !== request.policy) {
            throw new Error("Execution Job policy must be the exact request snapshot.");
          }
          if (acceptedJob.runId !== runId || acceptedJob.target.url !== request.target.url) {
            throw new Error("Execution Job must match its opened run request.");
          }
          offeredJob = acceptedJob;
          const lease = await this.connection.offer(acceptedJob, this.requiredCapabilities);
          return this.awaitCompletion(lease);
        },
        artifacts: stores.artifacts,
        manifests: stores.manifests,
        runs: stores.runs,
        traces: stores.traces,
        close: async (): Promise<void> => {
          let firstError: unknown;
          try {
            if (offeredJob !== undefined) {
              await this.connection.cancel(offeredJob.jobId, "run scope closed");
            }
          } catch (cause) {
            firstError = cause;
          }
          try {
            await stores.close();
          } catch (cause) {
            firstError ??= cause;
          }
          if (firstError !== undefined) throw firstError;
        },
      };
    } catch (cause) {
      await stores.close().catch(() => undefined);
      throw cause;
    }
  }
}
