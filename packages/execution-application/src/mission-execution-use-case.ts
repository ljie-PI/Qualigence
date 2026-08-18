import { randomUUID } from "node:crypto";
import type { PrdSourceRef } from "@qualigence/context-intake";
import type {
  DispatchableJob,
  DispatchableMission,
  ExecutionJobStatus,
  JobAttemptStatus,
  MissionStatus,
  PrdMissionRepository,
} from "@qualigence/mission";
import type { Clock } from "@qualigence/shared-kernel";
import { SystemClock } from "@qualigence/shared-kernel";
import type {
  RunExecutionRequest,
  RunExecutionResult,
  RunExecutionUseCase,
} from "./contracts.js";
import { ExecutionApplicationError } from "./errors.js";

/** Full-chain provenance from a Mission execution back to its originating PRD. */
export interface MissionExecutionTrace {
  readonly prdRevision: number;
  readonly planId: string;
  readonly missionId: string;
  readonly runId: string;
}

/** The durable outcome of dispatching one Mission job through the shared port. */
export interface MissionJobResult {
  readonly jobId: string;
  readonly testCaseId: string;
  readonly runId: string;
  readonly status: RunExecutionResult["status"];
  readonly sourceRefs: readonly PrdSourceRef[];
}

/** The aggregated, re-readable result of executing a compiled Mission. */
export interface MissionExecutionResult {
  readonly missionId: string;
  readonly missionRevision: number;
  readonly status: MissionStatus;
  readonly jobResults: readonly MissionJobResult[];
  readonly trace: MissionExecutionTrace;
}

export interface MissionExecutionUseCaseOptions {
  readonly clock?: Clock;
  readonly generateAttemptId?: () => string;
}

function jobStatusFor(status: RunExecutionResult["status"]): ExecutionJobStatus {
  switch (status) {
    case "passed":
    case "finding":
      return "completed";
    case "blocked":
      return "blocked";
    case "error":
      return "failed";
  }
}

function attemptStatusFor(
  status: RunExecutionResult["status"],
): JobAttemptStatus {
  return status;
}

/**
 * Turns an approved, compiled Mission into one or more individual executions,
 * dispatched through the EXISTING {@link RunExecutionUseCase} — never a CLI child
 * process. It pins each job's target/profile from the persisted dispatch
 * descriptor, records every attempt with durable provenance back to the PRD
 * source ranges, and aggregates the per-job outcomes into a single Mission-level
 * status. It composes over — rather than reimplements — the shared execution
 * pipeline, so remote-Runner execution (LS-05) is transparently inherited.
 */
export class MissionExecutionUseCase {
  private readonly clock: Clock;
  private readonly generateAttemptId: () => string;

  constructor(
    private readonly repository: PrdMissionRepository,
    private readonly runExecution: RunExecutionUseCase,
    options: MissionExecutionUseCaseOptions = {},
  ) {
    this.clock = options.clock ?? new SystemClock();
    this.generateAttemptId = options.generateAttemptId ?? (() => randomUUID());
  }

  async execute(missionId: string): Promise<MissionExecutionResult> {
    const mission = await this.repository.loadMissionForDispatch(missionId);
    if (!mission) {
      throw new ExecutionApplicationError(
        "MissionNotFound",
        `No dispatchable Mission found for id ${missionId}.`,
      );
    }

    await this.repository.setMissionStatus(
      mission.missionId,
      mission.missionRevision,
      "running",
    );

    const jobResults: MissionJobResult[] = [];
    let stopped = false;

    for (const job of mission.jobs) {
      const runResult = await this.runExecution.execute(
        this.buildRequest(mission, job),
      );

      await this.repository.recordJobAttempt({
        attemptId: this.generateAttemptId(),
        jobId: job.jobId,
        missionId: mission.missionId,
        runId: runResult.runId,
        status: attemptStatusFor(runResult.status),
        ...(runResult.errorCode === undefined
          ? {}
          : { errorCode: runResult.errorCode }),
        createdAt: this.clock.now(),
      });

      const jobStatus = jobStatusFor(runResult.status);
      await this.repository.setJobStatus(job.jobId, jobStatus);

      jobResults.push({
        jobId: job.jobId,
        testCaseId: job.testCaseId,
        runId: runResult.runId,
        status: runResult.status,
        sourceRefs: job.sourceRefs,
      });

      if (
        (jobStatus === "blocked" || jobStatus === "failed") &&
        mission.stopOnBlockedTestCase
      ) {
        stopped = true;
        break;
      }
    }

    const missionStatus: MissionStatus =
      stopped || jobResults.some((result) => jobStatusFor(result.status) !== "completed")
        ? "blocked"
        : "completed";

    await this.repository.setMissionStatus(
      mission.missionId,
      mission.missionRevision,
      missionStatus,
    );

    return {
      missionId: mission.missionId,
      missionRevision: mission.missionRevision,
      status: missionStatus,
      jobResults,
      trace: {
        prdRevision: mission.prdRevision,
        planId: mission.planId,
        missionId: mission.missionId,
        runId: jobResults[0]?.runId ?? "",
      },
    };
  }

  private buildRequest(
    mission: DispatchableMission,
    job: DispatchableJob,
  ): RunExecutionRequest {
    const targetOrigin = new URL(mission.dispatch.targetUrl).origin;
    if (!mission.executionPolicy.allowedOrigins.includes(targetOrigin)) {
      throw new ExecutionApplicationError("InvalidConfiguration", "Mission target is outside its approved policy origins.");
    }
    return {
      target: { kind: "web", url: mission.dispatch.targetUrl },
      objective: job.objective,
      policy: mission.executionPolicy,
      executionProfile: {
        modelProfileId: mission.dispatch.modelProfileId,
        headed: mission.dispatch.headed,
        navigationTimeoutMs: mission.dispatch.navigationTimeoutMs,
        actionTimeoutMs: mission.dispatch.actionTimeoutMs,
      },
    };
  }
}
