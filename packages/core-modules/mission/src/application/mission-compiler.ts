import { sha256Hex } from "@qualigence/context-intake";
import type { Result } from "@qualigence/shared-kernel";
import type {
  MissionError,
  TestCase,
  TestPlanRevision,
} from "../domain/test-plan-revision.js";
import {
  capabilityForStep,
  type CompiledMission,
  type ExecutionJob,
  type TargetCapabilitySummary,
  type TestMission,
} from "../domain/test-mission.js";
import { validateApprovedExecutionPolicy } from "../exploration-policy.js";

/** Recursively sort object keys so equal content always serializes identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function testPlanSnapshotHash(plan: TestPlanRevision): string {
  return sha256Hex(JSON.stringify(plan));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function requiredCapabilities(testCase: TestCase, target: TargetCapabilitySummary): readonly string[] {
  const targetCapabilities = target.capabilities.filter((capability) => capability.startsWith("target:"));
  if (targetCapabilities.length !== 1) {
    throw new Error("Target must declare exactly one Runner target capability.");
  }
  const capabilities = new Set<string>([
    ...targetCapabilities,
    "model:structured-output",
  ]);
  for (const step of testCase.steps) {
    capabilities.add(capabilityForStep(step.kind));
  }
  return [...capabilities].sort();
}

/**
 * Deterministically compiles an approved {@link TestPlanRevision} into an
 * immutable {@link CompiledMission}. No IDs are randomized, no timestamps enter
 * the snapshot: identical inputs always produce a byte-identical result.
 */
export class MissionCompiler {
  compile(
    plan: TestPlanRevision,
    mission: TestMission,
    target: TargetCapabilitySummary,
  ): Result<CompiledMission, MissionError> {
    if (plan.status !== "approved") {
      return {
        ok: false,
        error: {
          code: "PlanNotApproved",
          message: `Plan ${plan.planId} must be approved before compilation.`,
        },
      };
    }

    if (mission.projectId.trim().length === 0 || plan.projectId !== mission.projectId) {
      return {
        ok: false,
        error: {
          code: "MissionProjectMismatch",
          message: "Mission project provenance must match the approved Plan.",
        },
      };
    }

    if (plan.testCases.length > mission.executionBudget.maximumJobs) {
      return {
        ok: false,
        error: {
          code: "MissionBudgetExceeded",
          message: `Plan has ${plan.testCases.length} test cases but the budget allows ${mission.executionBudget.maximumJobs}.`,
        },
      };
    }

    const supported = new Set(target.supportedStepKinds);
    try {
      validateApprovedExecutionPolicy(mission.executionPolicy, mission.executionBudget.maximumWallClockMs);
    } catch (error) {
      return {
        ok: false,
        error: { code: "MissionBudgetExceeded", message: error instanceof Error ? error.message : "Invalid execution policy." },
      };
    }
    const jobs: ExecutionJob[] = [];

    for (const testCase of plan.testCases) {
      if (testCase.steps.length > mission.executionBudget.maximumStepsPerJob) {
        return {
          ok: false,
          error: {
            code: "MissionBudgetExceeded",
            message: `Test case ${testCase.id} exceeds the per-job step budget.`,
          },
        };
      }

      for (const step of testCase.steps) {
        if (!supported.has(step.kind)) {
          return {
            ok: false,
            error: {
              code: "TargetCapabilityMismatch",
              message: `Target ${target.targetId} does not support step kind "${step.kind}".`,
            },
          };
        }
      }

      let capabilities: readonly string[];
      try {
        capabilities = requiredCapabilities(testCase, target);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "TargetCapabilityMismatch",
            message: error instanceof Error ? error.message : "Target Runner capability is invalid.",
          },
        };
      }
      const snapshot = deepFreeze(structuredClone(testCase));
      const snapshotHash = sha256Hex(canonicalJson(snapshot));
      const idempotencyKey = `${mission.missionId}:${mission.revision}:${testCase.id}`;
      const jobId = sha256Hex(idempotencyKey).slice(0, 32);

      const job: ExecutionJob = {
        jobId,
        missionId: mission.missionId,
        missionRevision: mission.revision,
        testCaseId: testCase.id,
        testCaseSnapshot: snapshot,
        targetId: mission.targetId,
        requiredCapabilities: capabilities,
        budget: {
          maximumStepsPerJob: mission.executionBudget.maximumStepsPerJob,
          maximumWallClockMs: mission.executionBudget.maximumWallClockMs,
          maximumModelTokens: mission.executionBudget.maximumModelTokens,
        },
        status: "queued",
        idempotencyKey,
        snapshotHash,
      };
      jobs.push(deepFreeze(job));
    }

    const [firstJob, ...restJobs] = jobs;
    if (firstJob === undefined) {
      return {
        ok: false,
        error: {
          code: "PlanNotApproved",
          message: `Plan ${plan.planId} produced no executable jobs.`,
        },
      };
    }

    const compiledHash = sha256Hex(
      canonicalJson({
        missionId: mission.missionId,
        missionRevision: mission.revision,
        projectId: mission.projectId,
        planId: plan.planId,
        planVersion: plan.version,
        planSnapshotHash: testPlanSnapshotHash(plan),
        targetId: mission.targetId,
        targetVersion: target.targetVersion,
        targetSnapshotHash: target.targetSnapshotHash,
        jobs: jobs.map((job) => ({
          jobId: job.jobId,
          testCaseId: job.testCaseId,
          idempotencyKey: job.idempotencyKey,
          requiredCapabilities: job.requiredCapabilities,
          budget: job.budget,
          executionPolicy: mission.executionPolicy,
          snapshotHash: job.snapshotHash,
        })),
      }),
    );

    return {
      ok: true,
      value: deepFreeze<CompiledMission>({
        missionId: mission.missionId,
        missionRevision: mission.revision,
        projectId: mission.projectId,
        planId: plan.planId,
        planVersion: plan.version,
        planSnapshotHash: testPlanSnapshotHash(plan),
        targetId: mission.targetId,
        targetVersion: target.targetVersion,
        targetSnapshotHash: target.targetSnapshotHash,
        executionPolicy: deepFreeze(structuredClone(mission.executionPolicy)),
        jobs: [firstJob, ...restJobs],
        compiledHash,
      }),
    };
  }
}
