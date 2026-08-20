import type { AcceptedExecutionJob } from "@qualigence/runner-protocol";

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export type ExecutionBudgetErrorCode =
  | "ExecutionBudgetInvalid"
  | "ExecutionBudgetAlreadyActive"
  | "ExecutionBudgetNotActive"
  | "StepBudgetExceeded"
  | "WallClockBudgetExceeded"
  | "ModelBudgetExceeded"
  | "ModelUsageUnavailable";

export class ExecutionBudgetError extends Error {
  constructor(
    readonly code: ExecutionBudgetErrorCode,
    readonly consumedModelTokens?: number,
  ) {
    super(`Execution budget failed: ${code}`);
    this.name = "ExecutionBudgetError";
  }
}

export interface ExecutionBudget {
  begin(job: AcceptedExecutionJob): void;
  beforeStep(runId: string, stepIndex: number): void;
  maximumOutputTokens(runId: string): number;
  consumeModelUsage(runId: string, usage: ModelUsage | undefined): void;
  finish(runId: string): void;
}

export interface MonotonicClock {
  now(): number;
}

export interface DeterministicExecutionBudgetOptions {
  readonly clock?: MonotonicClock;
  readonly objectiveOnlyMaximumWallClockMs?: number;
  readonly objectiveOnlyMaximumModelTokens?: number;
}

interface RunBudgetState {
  readonly maximumSteps: number;
  readonly maximumWallClockMs: number;
  readonly maximumModelTokens: number;
  readonly startedAtMs: number;
  consumedSteps: number;
  consumedModelTokens: number;
}

const DEFAULT_ONE_CALL_CEILING = 4_096;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;

export class DeterministicExecutionBudget implements ExecutionBudget {
  private readonly runs = new Map<string, RunBudgetState>();
  private readonly clock: MonotonicClock;
  private readonly objectiveOnlyMaximumWallClockMs: number;
  private readonly objectiveOnlyMaximumModelTokens: number;

  constructor(options: DeterministicExecutionBudgetOptions = {}) {
    this.clock = options.clock ?? { now: () => performance.now() };
    this.objectiveOnlyMaximumWallClockMs =
      options.objectiveOnlyMaximumWallClockMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.objectiveOnlyMaximumModelTokens =
      options.objectiveOnlyMaximumModelTokens ?? DEFAULT_ONE_CALL_CEILING;
    validateLimit(this.objectiveOnlyMaximumWallClockMs);
    validateLimit(this.objectiveOnlyMaximumModelTokens);
  }

  begin(job: AcceptedExecutionJob): void {
    if (this.runs.has(job.runId)) {
      throw new ExecutionBudgetError("ExecutionBudgetAlreadyActive");
    }
    const source = job.plan?.budget ?? {
      maximumStepsPerJob: 1,
      maximumWallClockMs: this.objectiveOnlyMaximumWallClockMs,
      maximumModelTokens: this.objectiveOnlyMaximumModelTokens,
    };
    validateLimit(source.maximumStepsPerJob);
    validateLimit(source.maximumWallClockMs);
    validateLimit(source.maximumModelTokens);
    this.runs.set(job.runId, {
      maximumSteps: source.maximumStepsPerJob,
      maximumWallClockMs: source.maximumWallClockMs,
      maximumModelTokens: source.maximumModelTokens,
      startedAtMs: this.clock.now(),
      consumedSteps: 0,
      consumedModelTokens: 0,
    });
  }

  beforeStep(runId: string, stepIndex: number): void {
    const state = this.active(runId);
    this.assertWallClock(state);
    if (!Number.isSafeInteger(stepIndex) || stepIndex < 0 || state.consumedSteps >= state.maximumSteps) {
      throw new ExecutionBudgetError("StepBudgetExceeded");
    }
    state.consumedSteps += 1;
  }

  maximumOutputTokens(runId: string): number {
    const state = this.active(runId);
    this.assertWallClock(state);
    const remaining = state.maximumModelTokens - state.consumedModelTokens;
    if (remaining <= 0) {
      throw new ExecutionBudgetError("ModelBudgetExceeded", state.consumedModelTokens);
    }
    return remaining;
  }

  consumeModelUsage(runId: string, usage: ModelUsage | undefined): void {
    const state = this.active(runId);
    const consumed = totalTokens(usage);
    if (consumed === undefined) {
      throw new ExecutionBudgetError("ModelUsageUnavailable");
    }
    state.consumedModelTokens += consumed;
    if (state.consumedModelTokens > state.maximumModelTokens) {
      throw new ExecutionBudgetError("ModelBudgetExceeded", state.consumedModelTokens);
    }
    this.assertWallClock(state);
  }

  finish(runId: string): void {
    this.runs.delete(runId);
  }

  private active(runId: string): RunBudgetState {
    const state = this.runs.get(runId);
    if (state === undefined) {
      throw new ExecutionBudgetError("ExecutionBudgetNotActive");
    }
    return state;
  }

  private assertWallClock(state: RunBudgetState): void {
    const elapsed = this.clock.now() - state.startedAtMs;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= state.maximumWallClockMs) {
      throw new ExecutionBudgetError("WallClockBudgetExceeded");
    }
  }
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ExecutionBudgetError("ExecutionBudgetInvalid");
  }
}

function totalTokens(usage: ModelUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  if (isNonNegativeSafeInteger(usage.totalTokens)) return usage.totalTokens;
  if (
    isNonNegativeSafeInteger(usage.inputTokens) &&
    isNonNegativeSafeInteger(usage.outputTokens)
  ) {
    const total = usage.inputTokens + usage.outputTokens;
    return Number.isSafeInteger(total) ? total : undefined;
  }
  return undefined;
}

function isNonNegativeSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}
