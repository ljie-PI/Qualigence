import { createHash } from "node:crypto";
import type { Clock } from "@qualigence/shared-kernel";
import type { ApprovedExecutionPolicy } from "../exploration-policy.js";
import type { IntentStep, TestCase } from "../domain/test-plan-revision.js";
import type { ExecutionJobStatus, MissionStatus } from "../domain/test-mission.js";
import type { MissionDispatchDescriptor } from "./prd-mission-repository.js";

export interface StartMissionCommand {
  readonly missionId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

/** Structural twin of the Runner Protocol AcceptedExecutionJob at this neutral seam. */
export interface AcceptedMissionExecutionJob {
  readonly jobId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly target: { readonly kind: "web"; readonly url: string };
  readonly objective: string;
  readonly policy: ApprovedExecutionPolicy;
  readonly plan: {
    readonly missionId: string;
    readonly missionRevision: number;
    readonly testCaseId: string;
    readonly steps: readonly [IntentStep, ...IntentStep[]];
    readonly expectedClaimIds: readonly [string, ...string[]];
    readonly budget: {
      readonly maximumStepsPerJob: number;
      readonly maximumWallClockMs: number;
      readonly maximumModelTokens: number;
    };
  };
}

export interface ScheduledRunIdentity {
  readonly logicalJobId: string;
  readonly attemptId: string;
  readonly runnerJobId: string;
  readonly runId: string;
}

export interface ScheduledMission {
  readonly missionId: string;
  readonly missionRevision: number;
  readonly missionVersion: number;
  readonly status: "running";
  readonly runs: readonly ScheduledRunIdentity[];
}

export interface ScheduleMissionJob {
  readonly logicalJobId: string;
  readonly attemptId: string;
  readonly runnerId: string;
  readonly requiredCapabilities: readonly string[];
  readonly testCaseSnapshot: TestCase;
  readonly testCaseSnapshotHash: string;
  readonly job: AcceptedMissionExecutionJob;
}

export interface SchedulingMissionJob {
  readonly jobId: string;
  readonly testCaseId: string;
  readonly objective: string;
  readonly requiredCapabilities: readonly string[];
  readonly status: ExecutionJobStatus;
  readonly snapshotHash: string;
  readonly snapshot: TestCase;
  readonly budget: {
    readonly maximumStepsPerJob: number;
    readonly maximumWallClockMs: number;
    readonly maximumModelTokens: number;
  };
}

export interface SchedulingMission {
  readonly missionId: string;
  readonly missionRevision: number;
  readonly missionVersion: number;
  readonly compiledHash: string;
  readonly projectId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly planSnapshotHash: string;
  readonly prdId: string;
  readonly prdRevision: number;
  readonly targetVersion: number;
  readonly targetSnapshotHash: string;
  readonly status: MissionStatus;
  readonly dispatch: MissionDispatchDescriptor;
  readonly executionPolicy: ApprovedExecutionPolicy;
  readonly jobs: readonly SchedulingMissionJob[];
}

export interface ScheduleMissionInput {
  readonly command: StartMissionCommand;
  readonly mission: SchedulingMission;
  readonly scheduledAt: string;
  createJobs(): readonly ScheduleMissionJob[];
}

export type MissionSchedulingErrorCode =
  | "MissionNotFound"
  | "IdempotencyConflict"
  | "MissionVersionConflict"
  | "MissionRevisionConflict"
  | "MissionHashConflict"
  | "MissionStatusConflict"
  | "PlanVersionConflict"
  | "PlanHashConflict"
  | "PlanStatusConflict"
  | "MissionTargetUnsupported";

export class MissionSchedulingError extends Error {
  constructor(
    readonly code: MissionSchedulingErrorCode,
    message: string,
    readonly actualVersion?: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "MissionSchedulingError";
  }
}

export interface MissionSchedulingRepository {
  replay(command: StartMissionCommand): Promise<ScheduledMission | undefined>;
  loadMission(missionId: string): Promise<SchedulingMission | undefined>;
  schedule(input: ScheduleMissionInput): Promise<ScheduledMission>;
}

export interface MissionSchedulingIds {
  allocateAttemptId(): string;
  allocateRunnerJobId(): string;
  allocateRunId(): string;
}

export function missionStartCommandHash(command: StartMissionCommand): string {
  return createHash("sha256")
    .update(`${command.missionId}\0${command.expectedVersion}\0${command.idempotencyKey}`)
    .digest("hex");
}

function expectedClaimIds(testCase: TestCase): readonly [string, ...string[]] {
  const [first, ...rest] = testCase.expectedClaims.map((claim) => claim.claimId);
  if (first === undefined) {
    throw new MissionSchedulingError("MissionHashConflict", "compiled Test Case has no Expected Claim");
  }
  return [first, ...rest];
}

export class MissionSchedulingService {
  constructor(
    private readonly repository: MissionSchedulingRepository,
    private readonly ids: MissionSchedulingIds,
    private readonly clock: Clock,
  ) {}

  async start(command: StartMissionCommand): Promise<ScheduledMission> {
    const replay = await this.repository.replay(command);
    if (replay !== undefined) return replay;

    const mission = await this.repository.loadMission(command.missionId);
    if (mission === undefined) {
      throw new MissionSchedulingError("MissionNotFound", "Mission was not found");
    }
    const binding = mission.dispatch.binding;
    if (binding === undefined) {
      throw new MissionSchedulingError("MissionHashConflict", "Mission provenance binding is missing");
    }
    if (binding.configuration.kind !== "web") {
      throw new MissionSchedulingError(
        "MissionTargetUnsupported",
        "Desktop Runner dispatch is not available in this protocol version",
      );
    }

    return this.repository.schedule({
      command,
      mission,
      scheduledAt: this.clock.now(),
      createJobs: () => mission.jobs.map((logicalJob): ScheduleMissionJob => {
        const attemptId = this.ids.allocateAttemptId();
        const runnerJobId = this.ids.allocateRunnerJobId();
        const runId = this.ids.allocateRunId();
        return {
          logicalJobId: logicalJob.jobId,
          attemptId,
          runnerId: binding.runnerId,
          requiredCapabilities: logicalJob.requiredCapabilities,
          testCaseSnapshot: logicalJob.snapshot,
          testCaseSnapshotHash: logicalJob.snapshotHash,
          job: {
            jobId: runnerJobId,
            runId,
            projectId: mission.projectId,
            target: { kind: "web", url: mission.dispatch.targetUrl },
            objective: logicalJob.objective,
            policy: mission.executionPolicy,
            plan: {
              missionId: mission.missionId,
              missionRevision: mission.missionRevision,
              testCaseId: logicalJob.testCaseId,
              steps: logicalJob.snapshot.steps,
              expectedClaimIds: expectedClaimIds(logicalJob.snapshot),
              budget: logicalJob.budget,
            },
          },
        };
      }),
    });
  }
}
