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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function requiredCapabilities(testCase: TestCase): readonly string[] {
  const capabilities = new Set<string>();
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
        requiredCapabilities: requiredCapabilities(testCase),
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
        targetId: mission.targetId,
        jobs: jobs.map((job) => ({
          jobId: job.jobId,
          testCaseId: job.testCaseId,
          idempotencyKey: job.idempotencyKey,
          requiredCapabilities: job.requiredCapabilities,
          budget: job.budget,
          snapshotHash: job.snapshotHash,
        })),
      }),
    );

    return {
      ok: true,
      value: deepFreeze<CompiledMission>({
        missionId: mission.missionId,
        missionRevision: mission.revision,
        targetId: mission.targetId,
        jobs: [firstJob, ...restJobs],
        compiledHash,
      }),
    };
  }
}
