import type {
  ArtifactManifestStore,
  ArtifactStore,
  RunStore,
  TraceStore,
} from "@qualigence/evidence";
import type { ExecutionRuntime } from "@qualigence/runner-kernel";
import type { FindingEnvelope } from "@qualigence/runner-protocol";

/**
 * Stable request accepted by every entry point (CLI today, API/PRD planner
 * later). Only provider-neutral fields appear here.
 */
export interface RunExecutionRequest {
  readonly target: { readonly kind: "web"; readonly url: string };
  readonly objective: string;
  readonly executionProfile: {
    readonly modelProfileId: string;
    readonly headed: boolean;
    readonly navigationTimeoutMs: number;
    readonly actionTimeoutMs: number;
  };
}

/**
 * `cli-result/v1` stable JSON. Within one major only optional fields are added;
 * existing `status`/`errorCode`/`evidenceRefs` names never change.
 */
export interface RunExecutionResult {
  readonly runId: string;
  readonly status: "passed" | "finding" | "blocked" | "error";
  readonly finding?: FindingEnvelope;
  readonly errorCode?: string;
  readonly evidenceRefs: readonly string[];
}

export interface RunExecutionUseCase {
  execute(request: RunExecutionRequest): Promise<RunExecutionResult>;
}

/**
 * The per-run resource bundle. It exposes only public package types so that a
 * future implementation (LS-05) can back {@link RunResourceScope.runtime} with a
 * remote Runner connection without changing {@link RunExecutionUseCase} or any
 * of its callers.
 */
export interface RunResourceScope {
  readonly runtime: ExecutionRuntime;
  readonly artifacts: ArtifactStore;
  readonly manifests: ArtifactManifestStore;
  readonly runs: RunStore;
  readonly traces: TraceStore;
  close(): Promise<void>;
}

/**
 * The sole construction seam for a Run's resources. Component tests inject an
 * in-memory factory; LS-05 will inject a remote-Runner-backed factory. The use
 * case never imports transport-specific types.
 */
export interface RunResourceFactory {
  open(runId: string, request: RunExecutionRequest): Promise<RunResourceScope>;
}
