import { randomBytes } from "node:crypto";
import type { RunStatus } from "@qualigence/evidence";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
} from "@qualigence/runner-protocol";
import { ModelGatewayError } from "@qualigence/model-gateway";
import type { Clock } from "@qualigence/shared-kernel";
import { SystemClock } from "@qualigence/shared-kernel";
import type {
  RunExecutionRequest,
  RunExecutionResult,
  RunExecutionUseCase,
  RunResourceFactory,
  RunResourceScope,
} from "./contracts.js";
import {
  ExecutionApplicationError,
  type ExecutionApplicationErrorCode,
} from "./errors.js";
import { TerminalTraceEnsurer } from "./terminal-trace-ensurer.js";

export interface RunExecutionUseCaseOptions {
  readonly clock?: Clock;
  readonly logger?: (message: string, detail?: unknown) => void;
}

/**
 * The single orchestration use case shared by every entry point (CLI today,
 * API/PRD planner later). It validates the request, opens a per-run resource
 * scope through the {@link RunResourceFactory} seam, drives the fixed
 * {@link import("@qualigence/runner-kernel").ExecutionRuntime} pipeline, persists
 * the terminal Run and maps outcomes onto the stable four terminal states.
 *
 * It never imports a concrete Provider or transport type, so LS-05 can swap the
 * factory for a remote-Runner-backed implementation without touching callers.
 */
export class RunExecutionUseCaseImpl implements RunExecutionUseCase {
  private readonly clock: Clock;
  private readonly logger: (message: string, detail?: unknown) => void;

  constructor(
    private readonly resources: RunResourceFactory,
    options: RunExecutionUseCaseOptions = {},
  ) {
    this.clock = options.clock ?? new SystemClock();
    this.logger = options.logger ?? (() => undefined);
  }

  async execute(request: RunExecutionRequest): Promise<RunExecutionResult> {
    const validationError = validateRequest(request);
    if (validationError !== undefined) {
      // Configuration failures happen before any Run is created: no Trace, no
      // Run, no resource scope.
      return {
        runId: "",
        status: "error",
        errorCode: validationError,
        evidenceRefs: [],
      };
    }

    const runId = uuidv7();
    const jobId = uuidv7();

    let scope: RunResourceScope;
    try {
      scope = await this.resources.open(runId, request);
    } catch (cause) {
      // The scope never opened, so there is nothing to close and no Run to
      // terminalize.
      return {
        runId,
        status: "error",
        errorCode: mapInfrastructureError(cause),
        evidenceRefs: [],
      };
    }

    const ensurer = new TerminalTraceEnsurer(scope.traces, this.clock);
    try {
      await scope.runs.create({
        runId,
        jobId,
        targetKind: "web",
        objective: request.objective,
        status: "running",
        nextSequenceNumber: 1,
        createdAt: this.clock.now(),
      });

      const job: AcceptedExecutionJob = {
        jobId,
        runId,
        target: { kind: "web", url: request.target.url },
        objective: request.objective,
        policy: request.policy,
      };

      const completion = await scope.execute(job);
      return await this.finalizeCompletion(scope, runId, completion);
    } catch (cause) {
      const errorCode = mapInfrastructureError(cause);
      await this.ensureErrorTerminal(ensurer, runId, errorCode);
      await this.completeRun(scope, runId, "error", errorCode);
      return { runId, status: "error", errorCode, evidenceRefs: [] };
    } finally {
      try {
        await scope.close();
      } catch (cleanup) {
        // A cleanup failure must never overwrite an already-returned business
        // terminal; it is only logged.
        this.logger("CleanupFailed", cleanup);
      }
    }
  }

  private async finalizeCompletion(
    scope: RunResourceScope,
    runId: string,
    completion: ExecutionCompletion,
  ): Promise<RunExecutionResult> {
    const manifests = await scope.manifests.listForRun(runId);
    const artifactRefs = manifests.map((manifest) => manifest.artifactId);

    if (completion.status === "passed") {
      await this.completeRun(scope, runId, "passed");
      return { runId, status: "passed", evidenceRefs: artifactRefs };
    }

    if (completion.status === "finding") {
      await this.completeRun(scope, runId, "finding");
      const evidenceRefs = [
        ...new Set([...completion.finding.evidenceRefs, ...artifactRefs]),
      ];
      return {
        runId,
        status: "finding",
        finding: completion.finding,
        evidenceRefs,
      };
    }

    // Runtime "blocked" completion: policy denial, invalid model structure,
    // stale node, or action failure. No Finding is produced.
    const errorCode = completion.errorCode;
    await this.completeRun(scope, runId, "blocked", errorCode);
    return {
      runId,
      status: "blocked",
      ...(errorCode === undefined ? {} : { errorCode }),
      evidenceRefs: artifactRefs,
    };
  }

  private async completeRun(
    scope: RunResourceScope,
    runId: string,
    status: Exclude<RunStatus, "running">,
    errorCode?: string,
  ): Promise<void> {
    try {
      await scope.runs.complete(runId, {
        status,
        completedAt: this.clock.now(),
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    } catch (cause) {
      this.logger("RunCompletionFailed", cause);
    }
  }

  private async ensureErrorTerminal(
    ensurer: TerminalTraceEnsurer,
    runId: string,
    errorCode: string,
  ): Promise<void> {
    try {
      await ensurer.ensureError(runId, errorCode);
    } catch (cause) {
      this.logger("TerminalTraceFailed", cause);
    }
  }
}

function validateRequest(
  request: RunExecutionRequest,
): ExecutionApplicationErrorCode | undefined {
  if (request.target.kind !== "web") {
    return "InvalidConfiguration";
  }
  if (!isValidHttpUrl(request.target.url)) {
    return "InvalidTargetUrl";
  }
  if (request.objective.trim().length === 0) {
    return "InvalidConfiguration";
  }

  const profile = request.executionProfile;
  if (profile.modelProfileId.trim().length === 0) {
    return "InvalidConfiguration";
  }
  if (!isPositiveInteger(profile.navigationTimeoutMs)) {
    return "InvalidConfiguration";
  }
  if (!isPositiveInteger(profile.actionTimeoutMs)) {
    return "InvalidConfiguration";
  }
  return undefined;
}

function isValidHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Maps a thrown dependency error onto a stable, user-safe application error
 * code. Only known dependency failures are recognized; anything else defaults
 * to `BrowserUnavailable` because in M1 the runtime pipeline is driven entirely
 * by the browser target.
 */
function mapInfrastructureError(error: unknown): ExecutionApplicationErrorCode {
  if (error instanceof ExecutionApplicationError) {
    return error.code;
  }
  if (error instanceof ModelGatewayError) {
    return error.code === "AuthenticationFailed"
      ? "ModelAuthenticationFailed"
      : "ModelUnavailable";
  }

  const name = errorName(error);
  if (name === "SqliteRuntimeError") {
    return "PersistenceUnavailable";
  }
  if (name === "ArtifactStoreError") {
    return "ArtifactUnavailable";
  }
  if (name === "WebTargetError") {
    return "BrowserUnavailable";
  }
  return "BrowserUnavailable";
}

function errorName(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const candidate = (error as { readonly name?: unknown }).name;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Generates a UUIDv7 (time-ordered) identifier for a Run/Job.
 */
function uuidv7(): string {
  const bytes = randomBytes(16);
  const timestamp = Date.now();
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
