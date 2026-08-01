import type { PrdDocument, PrdSourceRef } from "@qualigence/context-intake";
import type {
  CompiledMission,
  ExecutionJobStatus,
  MissionStatus,
} from "../domain/test-mission.js";
import type {
  TestCase,
  TestPlanRevision,
} from "../domain/test-plan-revision.js";

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
  readonly projectId: string;
  readonly planId: string;
  readonly prdId: string;
  readonly prdRevision: number;
  readonly status: MissionStatus;
  readonly dispatch: MissionDispatchDescriptor;
  readonly stopOnBlockedTestCase: boolean;
  readonly jobs: readonly DispatchableJob[];
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

/**
 * Persistence boundary for the PRD → Mission bridge. It never runs a model or a
 * browser; it only stores immutable PRD/plan/mission snapshots and records
 * execution attempts. Concrete implementations (SQLite locally, PostgreSQL for
 * LS-11) share this contract.
 */
export interface PrdMissionRepository {
  savePrdDocument(document: PrdDocument): Promise<void>;
  saveTestPlanRevision(plan: TestPlanRevision): Promise<void>;
  saveCompiledMission(input: SaveCompiledMissionInput): Promise<void>;
  loadMissionForDispatch(
    missionId: string,
  ): Promise<DispatchableMission | undefined>;
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
}
