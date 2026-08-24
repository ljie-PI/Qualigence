import type { PrdDocument, PrdSourceRef } from "@qualigence/context-intake";
import type {
  CompiledMission,
  ExecutionJobStatus,
  MissionStatus,
} from "../domain/test-mission.js";
import type { ApprovedExecutionPolicy } from "../exploration-policy.js";
import type { TargetConfiguration } from "@qualigence/project-target";
import type {
  TestCase,
  TestPlanRevision,
} from "../domain/test-plan-revision.js";
import type {
  AcceptedMissionExecutionJob,
  ScheduleMissionInput,
  ScheduledMission,
  StartMissionCommand,
} from "./mission-scheduling-service.js";

/**
 * The concrete, provider-neutral instructions needed to turn a compiled Mission
 * job into an individual execution request. Target and execution profile are not
 * domain state of the plan; they are pinned when the Mission is scheduled so
 * {@link PrdMissionRepository.loadMissionForDispatch} can reconstruct a request
 * without re-reading the PRD.
 */
export interface MissionDispatchDescriptor {
  readonly targetUrl: string;
  readonly modelProfileId: string;
  readonly headed: boolean;
  readonly navigationTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly binding?: {
    readonly targetId: string;
    readonly targetVersion: number;
    readonly targetSnapshotHash: string;
    readonly runnerId: string;
    readonly planVersion: number;
    readonly planSnapshotHash: string;
    readonly configuration: TargetConfiguration;
  };
}

/** Everything needed to persist an approved, compiled Mission with provenance. */
export interface SaveCompiledMissionInput {
  readonly mission: CompiledMission;
  readonly projectId: string;
  readonly planId: string;
  readonly prdId: string;
  readonly prdRevision: number;
  readonly dispatch: MissionDispatchDescriptor;
  readonly stopOnBlockedTestCase: boolean;
}

/** A single Mission job resolved into a dispatchable unit of execution. */
export interface DispatchableJob {
  readonly jobId: string;
  readonly testCaseId: string;
  readonly objective: string;
  readonly requiredCapabilities: readonly string[];
  readonly status: ExecutionJobStatus;
  readonly sourceRefs: readonly PrdSourceRef[];
  readonly snapshot: TestCase;
}

/** A persisted Mission ready to be dispatched through the shared execution port. */
export interface DispatchableMission {
  readonly missionId: string;
  readonly missionRevision: number;
  readonly missionVersion?: number;
  readonly projectId: string;
  readonly planId: string;
  readonly prdId: string;
  readonly prdRevision: number;
  readonly status: MissionStatus;
  readonly dispatch: MissionDispatchDescriptor;
  readonly executionPolicy: ApprovedExecutionPolicy;
  readonly stopOnBlockedTestCase: boolean;
  readonly jobs: readonly DispatchableJob[];
}

export interface MissionSchedulingSnapshot extends DispatchableMission {
  readonly missionVersion: number;
  readonly compiledHash: string;
  readonly planVersion: number;
  readonly planSnapshotHash: string;
  readonly targetVersion: number;
  readonly targetSnapshotHash: string;
  readonly jobs: readonly (DispatchableJob & {
    readonly snapshotHash: string;
    readonly budget: {
      readonly maximumStepsPerJob: number;
      readonly maximumWallClockMs: number;
      readonly maximumModelTokens: number;
    };
  })[];
}

export type JobAttemptStatus = "passed" | "finding" | "blocked" | "error";

/** A durable record of one execution attempt of a Mission job. */
export interface JobAttemptRecord {
  readonly attemptId: string;
  readonly jobId: string;
  readonly missionId: string;
  readonly runId: string;
  readonly status: JobAttemptStatus;
  readonly errorCode?: string;
  readonly createdAt: string;
}

/** A job's execution history with its immutable provenance to PRD source ranges. */
export interface MissionJobExecution {
  readonly jobId: string;
  readonly testCaseId: string;
  readonly status: ExecutionJobStatus;
  readonly sourceRefs: readonly PrdSourceRef[];
  readonly attempts: readonly JobAttemptRecord[];
}

/**
 * The durable, re-readable Mission-level execution record. Every job retains a
 * traceable link back to the PRD revision it was grounded in and the exact
 * source ranges it cites.
 */
export interface MissionExecutionRecord {
  readonly missionId: string;
  readonly missionRevision: number;
  readonly projectId: string;
  readonly planId: string;
  readonly prdId: string;
  readonly prdRevision: number;
  readonly status: MissionStatus;
  readonly jobs: readonly MissionJobExecution[];
}

export interface PendingMissionDispatch {
  readonly attemptId: string;
  readonly missionId: string;
  readonly runnerId: string;
  readonly runnerJobId: string;
  readonly runId: string;
  readonly requiredCapabilities: readonly string[];
  readonly job: AcceptedMissionExecutionJob;
  readonly status: "pending";
  readonly version: number;
  readonly createdAt: string;
}

export interface MissionDispatchAcceptanceReceipt {
  readonly status: "accepted" | "already_active";
  readonly jobId: string;
  readonly runId: string;
  readonly acceptedAt: string;
}

export interface AcceptedMissionDispatch
  extends Omit<PendingMissionDispatch, "status"> {
  readonly status: "accepted";
  readonly version: number;
  readonly acceptedAt: string;
  readonly receipt: MissionDispatchAcceptanceReceipt;
}

export interface BlockedMissionDispatch
  extends Omit<PendingMissionDispatch, "status"> {
  readonly status: "blocked";
  readonly version: number;
}

/**
 * Persistence boundary for the PRD → Mission bridge. It never runs a model or a
 * browser; it only stores immutable PRD/plan/mission snapshots and records
 * execution attempts. Concrete implementations (SQLite locally, PostgreSQL for
 * LS-11) share this contract.
 */
export interface PrdMissionRepository {
  savePrdDocument(document: PrdDocument): Promise<void>;
  saveTestPlanRevision(plan: TestPlanRevision): Promise<void>;
  saveCompiledMission(input: SaveCompiledMissionInput): Promise<DispatchableMission | void>;
  loadMissionForDispatch(
    missionId: string,
  ): Promise<DispatchableMission | undefined>;
  listMissionIds?(): Promise<readonly string[]>;
  recordJobAttempt(attempt: JobAttemptRecord): Promise<void>;
  setJobStatus(jobId: string, status: ExecutionJobStatus): Promise<void>;
  setMissionStatus(
    missionId: string,
    missionRevision: number,
    status: MissionStatus,
  ): Promise<void>;
  loadMissionExecution(
    missionId: string,
  ): Promise<MissionExecutionRecord | undefined>;
  replayMissionSchedule(command: StartMissionCommand): Promise<ScheduledMission | undefined>;
  loadMissionForScheduling(missionId: string): Promise<MissionSchedulingSnapshot | undefined>;
  scheduleMission(input: ScheduleMissionInput): Promise<ScheduledMission>;
  pendingDispatches(limit: number): Promise<readonly PendingMissionDispatch[]>;
  markDispatchAccepted(
    attemptId: string,
    receipt: MissionDispatchAcceptanceReceipt,
    expectedVersion: number,
  ): Promise<AcceptedMissionDispatch>;
  markDispatchBlocked?(
    attemptId: string,
    expectedVersion: number,
  ): Promise<BlockedMissionDispatch>;
}
