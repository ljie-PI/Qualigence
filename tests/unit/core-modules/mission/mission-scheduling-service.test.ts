import { describe, expect, it, vi } from "vitest";
import {
  MissionSchedulingService,
  type PrdMissionRepository,
  type SchedulingMission,
  type ScheduledMission,
} from "@qualigence/mission";
import {
  DESKTOP_UIA_V1_CAPABILITY_TOKENS,
  WEB_OBSERVATION_V1_CAPABILITY_TOKENS,
  type AcceptedExecutionJob,
} from "@qualigence/runner-protocol";
import { offerFromWire, offerToWire } from "@qualigence/grpc-runner-protocol";
import { PrdMissionRepositoryTestStub } from "../../../helpers/prd-mission-repository.js";

const WEB_JOB_CAPABILITIES = ["action:click", "model:structured-output", ...WEB_OBSERVATION_V1_CAPABILITY_TOKENS, "target:web-playwright"] as const;
const DESKTOP_COMPILED_CAPABILITIES = ["action:click", "model:structured-output", "target:desktop-windows-uia"] as const;
const DESKTOP_SCHEDULED_CAPABILITIES = [
  "action:click",
  "model:structured-output",
  ...DESKTOP_UIA_V1_CAPABILITY_TOKENS,
] as const;

const desktopAppTarget = {
  targetId: "wpf-reference",
  platform: "windows",
  launch: {
    executable: "C:\\Apps\\Reference\\Reference.exe",
    args: ["--fixture", "default", "ref:credentials/test-user"],
    workingDirectory: "C:\\Apps\\Reference",
  },
  process: {
    expectedImageName: "Reference.exe",
    allowedChildImageNames: ["ReferenceHelper.exe"],
  },
  window: { titlePattern: "Reference App", automationId: "MainWindow" },
  reset: { command: "C:\\Apps\\Reference\\Reset.exe", args: ["--clean"], timeoutMs: 5000 },
  shutdown: { gracefulTimeoutMs: 3000, forceAfterTimeout: true },
} as const;

const scheduled: ScheduledMission = {
  missionId: "mission-1",
  missionRevision: 1,
  missionVersion: 2,
  status: "running",
  runs: [{
    logicalJobId: "logical-job-1",
    attemptId: "attempt-1",
    runnerJobId: "runner-job-1",
    runId: "run-1",
  }],
};

const mission: SchedulingMission = {
  missionId: "mission-1",
  missionRevision: 1,
  missionVersion: 1,
  compiledHash: "compiled-hash",
  projectId: "project-1",
  planId: "plan-1",
  planVersion: 2,
  planSnapshotHash: "plan-hash",
  prdId: "prd-1",
  prdRevision: 1,
  targetVersion: 3,
  targetSnapshotHash: "target-hash",
  status: "approved",
  dispatch: {
    targetUrl: "https://example.test/",
    modelProfileId: "default",
    headed: false,
    navigationTimeoutMs: 30_000,
    actionTimeoutMs: 10_000,
    binding: {
      targetId: "target-1",
      targetVersion: 3,
      targetSnapshotHash: "target-hash",
      runnerId: "runner-1",
      planVersion: 2,
      planSnapshotHash: "plan-hash",
      configuration: {
        kind: "web",
        startUrl: "https://example.test/",
        allowedOrigins: ["https://example.test"],
        browser: "chromium",
      },
    },
  },
  executionPolicy: {
    policyId: "policy-1",
    environment: "isolated_test",
    allowedOrigins: ["https://example.test"],
    allowedActionKinds: ["click"],
    maximumRisk: "Normal",
    explorationAllowed: false,
    issuedAt: "2026-08-22T00:00:00.000Z",
    expiresAt: "2026-08-22T00:01:00.000Z",
  },
  jobs: [{
    jobId: "logical-job-1",
    testCaseId: "case-1",
    objective: "verify checkout",
    requiredCapabilities: WEB_JOB_CAPABILITIES,
    status: "queued",
    snapshotHash: "case-hash",
    snapshot: {
      id: "case-1",
      title: "Checkout",
      objective: "verify checkout",
      preconditions: [],
      steps: [{ kind: "click", target: { role: "button", name: "Pay", purpose: "submit checkout" } }],
      expectedClaims: [{ claimId: "claim-1", semanticKey: "checkout", statement: "checkout works", sourceRefs: [{ prdId: "prd-1", revision: 1, startOffset: 0, endOffset: 8, quotedTextSha256: "quote-hash" }], confidence: 1 }],
      sourceRefs: [{ prdId: "prd-1", revision: 1, startOffset: 0, endOffset: 8, quotedTextSha256: "quote-hash" }],
      priority: "high",
    },
    budget: { maximumStepsPerJob: 10, maximumWallClockMs: 60_000, maximumModelTokens: 1_000 },
  }],
};

describe("MissionSchedulingService", () => {
  it("returns a semantic replay without invoking any identity allocator", async () => {
    const repository = Object.assign(new PrdMissionRepositoryTestStub(), {
      replayMissionSchedule: vi.fn(async () => scheduled),
    });
    const allocateAttemptId = vi.fn(() => "unused-attempt");
    const allocateRunnerJobId = vi.fn(() => "unused-job");
    const allocateRunId = vi.fn(() => "unused-run");
    const service = new MissionSchedulingService(repository, {
      allocateAttemptId,
      allocateRunnerJobId,
      allocateRunId,
    }, { now: () => "2026-08-22T00:00:00.000Z" });

    await expect(service.start({ missionId: "mission-1", expectedVersion: 1, idempotencyKey: "start-1" })).resolves.toEqual(scheduled);
    expect(allocateAttemptId).not.toHaveBeenCalled();
    expect(allocateRunnerJobId).not.toHaveBeenCalled();
    expect(allocateRunId).not.toHaveBeenCalled();
  });

  it("constructs the immutable Runner Job at the application seam", async () => {
    type ScheduleMission = PrdMissionRepository["scheduleMission"];
    let scheduledInput: Parameters<ScheduleMission>[0] | undefined;
    const scheduleMission = vi.fn(async (input: Parameters<ScheduleMission>[0]) => {
      scheduledInput = input;
      return scheduled;
    });
    const repository = Object.assign(new PrdMissionRepositoryTestStub(), {
      replayMissionSchedule: vi.fn(async () => undefined),
      loadMissionForScheduling: vi.fn(async () => mission),
      scheduleMission,
    });
    const service = new MissionSchedulingService(repository, {
      allocateAttemptId: () => "attempt-1",
      allocateRunnerJobId: () => "runner-job-1",
      allocateRunId: () => "run-1",
    }, { now: () => "2026-08-22T00:00:00.000Z" });

    await service.start({ missionId: "mission-1", expectedVersion: 1, idempotencyKey: "start-1" });

    expect(scheduledInput).toEqual(expect.objectContaining({
      command: { missionId: "mission-1", expectedVersion: 1, idempotencyKey: "start-1" },
      mission: expect.objectContaining({ compiledHash: "compiled-hash", dispatch: expect.objectContaining({ binding: expect.objectContaining({ planVersion: 2, targetVersion: 3 }) }) }),
      scheduledAt: "2026-08-22T00:00:00.000Z",
    }));
    expect(scheduledInput?.createJobs()).toEqual([expect.objectContaining({
        logicalJobId: "logical-job-1",
        attemptId: "attempt-1",
        runnerId: "runner-1",
        requiredCapabilities: WEB_JOB_CAPABILITIES,
        job: expect.objectContaining({
          jobId: "runner-job-1",
          runId: "run-1",
          projectId: "project-1",
          target: { kind: "web", url: "https://example.test/" },
          policy: mission.executionPolicy,
          plan: expect.objectContaining({ missionId: "mission-1", missionRevision: 1, testCaseId: "case-1" }),
        }),
      })]);
  });

  it("constructs an authorized Desktop Runner Job without dropping AppTarget fields", async () => {
    type ScheduleMission = PrdMissionRepository["scheduleMission"];
    let scheduledInput: Parameters<ScheduleMission>[0] | undefined;
    const scheduleMission = vi.fn(async (input: Parameters<ScheduleMission>[0]) => {
      scheduledInput = input;
      return scheduled;
    });
    const desktopMission: SchedulingMission = {
      ...mission,
      dispatch: {
        ...mission.dispatch,
        binding: {
          targetId: "wpf-reference",
          targetVersion: 4,
          targetSnapshotHash: "desktop-target-hash",
          runnerId: "runner-windows",
          planVersion: 2,
          planSnapshotHash: "plan-hash",
          configuration: { kind: "desktop", app: desktopAppTarget },
        },
      },
      targetVersion: 4,
      targetSnapshotHash: "desktop-target-hash",
      jobs: mission.jobs.map((job) => ({ ...job, requiredCapabilities: DESKTOP_COMPILED_CAPABILITIES })),
    };
    const repository = Object.assign(new PrdMissionRepositoryTestStub(), {
      replayMissionSchedule: vi.fn(async () => undefined),
      loadMissionForScheduling: vi.fn(async () => desktopMission),
      scheduleMission,
    });
    const service = new MissionSchedulingService(repository, {
      allocateAttemptId: () => "attempt-1",
      allocateRunnerJobId: () => "runner-job-1",
      allocateRunId: () => "run-1",
    }, { now: () => "2026-08-22T00:00:00.000Z" });

    await service.start({ missionId: "mission-1", expectedVersion: 1, idempotencyKey: "start-1" });

    const [created] = scheduledInput?.createJobs() ?? [];
    expect(created).toEqual(expect.objectContaining({
      logicalJobId: "logical-job-1",
      attemptId: "attempt-1",
      runnerId: "runner-windows",
      requiredCapabilities: DESKTOP_SCHEDULED_CAPABILITIES,
    }));
    expect(created?.job).toEqual(expect.objectContaining({
      jobId: "runner-job-1",
      runId: "run-1",
      projectId: "project-1",
      target: { kind: "desktop", app: desktopAppTarget },
      policy: mission.executionPolicy,
      plan: expect.objectContaining({ missionId: "mission-1", missionRevision: 1, testCaseId: "case-1" }),
    }));
    expect(created?.job.target).toEqual({ kind: "desktop", app: desktopAppTarget });
    expect(offerFromWire(offerToWire({
      offerId: "offer-desktop",
      job: created?.job as AcceptedExecutionJob,
      requiredCapabilities: created?.requiredCapabilities ?? [],
      leaseDurationMs: 30_000,
    })).requiredCapabilities).toEqual(DESKTOP_SCHEDULED_CAPABILITIES);
  });
});
