import { beforeEach, describe, expect, it } from "vitest";
import type {
  DispatchableMission,
  JobAttemptRecord,
  MissionStatus,
  PrdMissionRepository,
  SaveCompiledMissionInput,
} from "@qualigence/mission";
import type { PrdDocument } from "@qualigence/context-intake";
import type { TestPlanRevision } from "@qualigence/mission";
import {
  MissionExecutionUseCase,
  type RunExecutionRequest,
  type RunExecutionResult,
  type RunExecutionUseCase,
} from "@qualigence/execution-application";

const sourceRef = {
  prdId: "prd-1",
  revision: 1,
  quotedTextSha256: "a".repeat(64),
  startOffset: 10,
  endOffset: 42,
} as const;

function dispatchableMission(
  overrides: Partial<DispatchableMission> = {},
): DispatchableMission {
  return {
    missionId: "mission-1",
    missionRevision: 1,
    projectId: "project-1",
    planId: "plan-1",
    prdId: "prd-1",
    prdRevision: 1,
    status: "approved",
    dispatch: {
      targetUrl: "http://127.0.0.1:4599/cart",
      modelProfileId: "profile-a",
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 5_000,
    },
    executionPolicy: { policyId: "policy-mission", environment: "isolated_test", allowedOrigins: ["http://127.0.0.1:4599"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
    stopOnBlockedTestCase: true,
    jobs: [
      {
        jobId: "job-1",
        testCaseId: "tc-1",
        objective: "Add a product to the cart",
        requiredCapabilities: ["navigate", "click"],
        status: "queued",
        sourceRefs: [sourceRef],
        snapshot: { id: "tc-1" } as never,
      },
    ],
    ...overrides,
  };
}

class FakeRepository implements PrdMissionRepository {
  mission: DispatchableMission | undefined;
  readonly attempts: JobAttemptRecord[] = [];
  readonly jobStatuses: Array<{ jobId: string; status: string }> = [];
  readonly missionStatuses: MissionStatus[] = [];

  async savePrdDocument(_document: PrdDocument): Promise<void> {}
  async saveTestPlanRevision(_plan: TestPlanRevision): Promise<void> {}
  async saveCompiledMission(_input: SaveCompiledMissionInput): Promise<void> {}
  async loadMissionForDispatch(
    missionId: string,
  ): Promise<DispatchableMission | undefined> {
    return this.mission && this.mission.missionId === missionId
      ? this.mission
      : undefined;
  }
  async recordJobAttempt(attempt: JobAttemptRecord): Promise<void> {
    this.attempts.push(attempt);
  }
  async setJobStatus(jobId: string, status: string): Promise<void> {
    this.jobStatuses.push({ jobId, status });
  }
  async setMissionStatus(
    _missionId: string,
    _missionRevision: number,
    status: MissionStatus,
  ): Promise<void> {
    this.missionStatuses.push(status);
  }
  async loadMissionExecution(): Promise<undefined> {
    return undefined;
  }
}

class ScriptedRunExecution implements RunExecutionUseCase {
  readonly requests: RunExecutionRequest[] = [];
  constructor(private readonly results: RunExecutionResult[]) {}
  async execute(request: RunExecutionRequest): Promise<RunExecutionResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (!result) {
      throw new Error("no scripted result");
    }
    return result;
  }
}

describe("MissionExecutionUseCase", () => {
  let repository: FakeRepository;

  beforeEach(() => {
    repository = new FakeRepository();
  });

  it("dispatches each job through the shared RunExecutionUseCase", async () => {
    repository.mission = dispatchableMission();
    const runExecution = new ScriptedRunExecution([
      { runId: "run-1", status: "passed", evidenceRefs: [] },
    ]);
    const useCase = new MissionExecutionUseCase(repository, runExecution, {
      generateAttemptId: () => "attempt-1",
      clock: { now: () => "2026-08-01T00:00:00.000Z" },
    });

    const result = await useCase.execute("mission-1");

    expect(runExecution.requests).toEqual([
      {
        projectId: "project-1",
        target: { kind: "web", url: "http://127.0.0.1:4599/cart" },
        objective: "Add a product to the cart",
        policy: repository.mission.executionPolicy,
        executionProfile: {
          modelProfileId: "profile-a",
          headed: false,
          navigationTimeoutMs: 15_000,
          actionTimeoutMs: 5_000,
        },
      },
    ]);
    expect(result.status).toBe("completed");
    expect(result.trace).toMatchObject({
      prdRevision: 1,
      planId: "plan-1",
      missionId: "mission-1",
      runId: "run-1",
    });
    expect(result.jobResults[0]?.sourceRefs).toEqual([sourceRef]);
    expect(repository.missionStatuses).toEqual(["running", "completed"]);
    expect(repository.jobStatuses).toEqual([
      { jobId: "job-1", status: "completed" },
    ]);
    expect(repository.attempts[0]).toMatchObject({
      jobId: "job-1",
      runId: "run-1",
      status: "passed",
    });
  });

  it("stops dispatching after a blocked job when the Mission policy requires it", async () => {
    repository.mission = dispatchableMission({
      stopOnBlockedTestCase: true,
      jobs: [
        {
          jobId: "job-1",
          testCaseId: "tc-1",
          objective: "first",
          requiredCapabilities: ["navigate"],
          status: "queued",
          sourceRefs: [sourceRef],
          snapshot: { id: "tc-1" } as never,
        },
        {
          jobId: "job-2",
          testCaseId: "tc-2",
          objective: "second",
          requiredCapabilities: ["navigate"],
          status: "queued",
          sourceRefs: [sourceRef],
          snapshot: { id: "tc-2" } as never,
        },
      ],
    });
    const runExecution = new ScriptedRunExecution([
      { runId: "run-1", status: "blocked", evidenceRefs: [] },
    ]);
    const useCase = new MissionExecutionUseCase(repository, runExecution);

    const result = await useCase.execute("mission-1");

    expect(runExecution.requests).toHaveLength(1);
    expect(result.status).toBe("blocked");
    expect(result.jobResults).toHaveLength(1);
    expect(repository.jobStatuses).toEqual([
      { jobId: "job-1", status: "blocked" },
    ]);
  });

  it("throws when the Mission cannot be found", async () => {
    const runExecution = new ScriptedRunExecution([]);
    const useCase = new MissionExecutionUseCase(repository, runExecution);
    await expect(useCase.execute("missing")).rejects.toThrow();
  });

  it("records a failed attempt and blocks the Mission when a persisted dispatch URL is malformed", async () => {
    repository.mission = dispatchableMission({
      dispatch: { ...dispatchableMission().dispatch, targetUrl: "not-a-url" },
    });
    const runExecution = new ScriptedRunExecution([]);
    const useCase = new MissionExecutionUseCase(repository, runExecution, {
      generateAttemptId: () => "attempt-invalid-target",
      clock: { now: () => "2026-08-18T00:00:00.000Z" },
    });

    await expect(useCase.execute("mission-1")).resolves.toMatchObject({
      status: "blocked",
      jobResults: [{ jobId: "job-1", runId: "", status: "error" }],
    });
    expect(runExecution.requests).toEqual([]);
    expect(repository.attempts).toEqual([
      expect.objectContaining({
        attemptId: "attempt-invalid-target",
        jobId: "job-1",
        runId: "",
        status: "error",
        errorCode: "InvalidTargetUrl",
      }),
    ]);
    expect(repository.jobStatuses).toEqual([{ jobId: "job-1", status: "failed" }]);
    expect(repository.missionStatuses).toEqual(["running", "blocked"]);
  });

  it.each([
    "ftp://example.test/path",
    "file:///tmp/target.html",
    "data:text/html,hello",
    "https://user:secret@example.test/",
  ])("records InvalidTargetUrl for unsafe persisted dispatch URL %s", async (targetUrl) => {
    repository.mission = dispatchableMission({ dispatch: { ...dispatchableMission().dispatch, targetUrl } });
    const useCase = new MissionExecutionUseCase(repository, new ScriptedRunExecution([]), {
      generateAttemptId: () => "attempt-unsafe-target",
      clock: { now: () => "2026-08-18T00:00:00.000Z" },
    });

    await expect(useCase.execute("mission-1")).resolves.toMatchObject({ status: "blocked" });
    expect(repository.attempts[0]).toMatchObject({ status: "error", errorCode: "InvalidTargetUrl" });
    expect(repository.missionStatuses).toEqual(["running", "blocked"]);
  });
});
