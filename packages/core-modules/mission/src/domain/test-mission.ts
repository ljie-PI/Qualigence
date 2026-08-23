import type { IntentStep, TestCase } from "./test-plan-revision.js";
import type { ApprovedExecutionPolicy } from "../exploration-policy.js";

export interface MissionBudget {
  readonly maximumJobs: number;
  readonly maximumStepsPerJob: number;
  readonly maximumWallClockMs: number;
  readonly maximumModelTokens: number;
  readonly stopOnBlockedTestCase: boolean;
}

export type MissionStatus =
  | "draft"
  | "approved"
  | "running"
  | "completed"
  | "blocked";

/** A target's advertised capability surface, used to gate compilation. */
export interface TargetCapabilitySummary {
  readonly targetId: string;
  readonly targetVersion: number;
  readonly targetSnapshotHash: string;
  readonly supportedStepKinds: readonly IntentStep["kind"][];
  readonly capabilities: readonly string[];
}

export interface TestMission {
  readonly missionId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly targetId: string;
  readonly testCaseIds: readonly [string, ...string[]];
  readonly executionBudget: MissionBudget;
  readonly executionPolicy: ApprovedExecutionPolicy;
  readonly status: MissionStatus;
}

export type ExecutionJobStatus =
  | "queued"
  | "leased"
  | "completed"
  | "blocked"
  | "failed";

export interface ExecutionJob {
  readonly jobId: string;
  readonly missionId: string;
  readonly missionRevision: number;
  readonly testCaseId: string;
  readonly testCaseSnapshot: TestCase;
  readonly targetId: string;
  readonly requiredCapabilities: readonly string[];
  readonly budget: Pick<
    MissionBudget,
    "maximumStepsPerJob" | "maximumWallClockMs" | "maximumModelTokens"
  >;
  readonly status: ExecutionJobStatus;
  readonly idempotencyKey: string;
  readonly snapshotHash: string;
}

/**
 * The immutable, deterministic output of compiling an approved plan into an
 * executable Mission. `compiledHash` is derived only from stable content —
 * never from timestamps — so identical inputs yield a byte-identical snapshot.
 */
export interface CompiledMission {
  readonly missionId: string;
  readonly missionRevision: number;
  readonly projectId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly planSnapshotHash: string;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly targetSnapshotHash: string;
  readonly executionPolicy: ApprovedExecutionPolicy;
  readonly jobs: readonly [ExecutionJob, ...ExecutionJob[]];
  readonly compiledHash: string;
}

/** Map an intent step kind to the runner capability it requires. */
export function capabilityForStep(kind: IntentStep["kind"]): string {
  switch (kind) {
    case "navigate":
      return "target:web-playwright";
    case "click":
      return "action:click";
    case "input":
      return "action:input";
    case "verify":
      return "model:structured-output";
  }
}
