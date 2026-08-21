import { describe, expect, it } from "vitest";
import { approveTestPlan, createDraftTestPlan, MissionIntakeService, type PrdMissionRepository, type TestPlanRepository } from "@qualigence/mission";
import { createTargetRevision, type ProjectTargetRepository } from "@qualigence/project-target";
import { DeterministicRunnerPolicyGate } from "@qualigence/runner-kernel";
import { sequentialIds, validatedProposal } from "./fixtures.js";

describe("MissionIntakeService policy issuance", () => {
  it("rejects a persisted Web Target whose startUrl origin is outside allowedOrigins", async () => {
    const target = { ...createTargetRevision({ targetId: "target-1", projectId: "project-1", displayName: "Web", runnerId: "runner-1", expectedVersion: 0, configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } }), configuration: { kind: "web" as const, startUrl: "https://example.test/", allowedOrigins: ["https://other.test"], browser: "chromium" as const } };
    const draft = createDraftTestPlan({ projectId: "project-1", prdId: "prd-1", prdRevision: 1, proposal: validatedProposal() }, sequentialIds("mission-origin"));
    if (!draft.ok) throw new Error(draft.error.code);
    const approved = approveTestPlan(draft.value, { expectedVersion: 1, reviewerId: "reviewer", idempotencyKey: "approve" }, { now: () => "2026-08-21T12:00:00.000Z" });
    if (!approved.ok) throw new Error(approved.error.code);
    const service = new MissionIntakeService({ getRevision: async () => target } as unknown as ProjectTargetRepository, { get: async () => approved.value } as unknown as TestPlanRepository, { loadMissionForDispatch: async () => undefined } as unknown as PrdMissionRepository, { now: () => "2026-08-21T12:00:00.000Z" });
    await expect(service.create({ projectId: "project-1", targetId: "target-1", targetVersion: 1, targetSnapshotHash: target.snapshotHash, planId: approved.value.planId, planVersion: 2, idempotencyKey: "mission-create" })).rejects.toMatchObject({ code: "MissionInputMismatch" });
  });
  it("issues a current budget-bounded policy admitted by Runner", async () => {
    const now = "2026-08-21T12:00:00.000Z";
    const target = createTargetRevision({ targetId: "target-1", projectId: "project-1", displayName: "Web", runnerId: "runner-1", expectedVersion: 0, configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } });
    const draft = createDraftTestPlan({ projectId: "project-1", prdId: "prd-1", prdRevision: 1, proposal: validatedProposal() }, sequentialIds("mission-intake"));
    if (!draft.ok) throw new Error(draft.error.code);
    const approved = approveTestPlan(draft.value, { expectedVersion: 1, reviewerId: "reviewer", idempotencyKey: "approve" }, { now: () => now });
    if (!approved.ok) throw new Error(approved.error.code);
    let saved: Parameters<PrdMissionRepository["saveCompiledMission"]>[0] | undefined;
    const targets = { getRevision: async () => target } as unknown as ProjectTargetRepository;
    const plans = { get: async () => approved.value } as unknown as TestPlanRepository;
    const missions = { loadMissionForDispatch: async () => undefined, saveCompiledMission: async (input: Parameters<PrdMissionRepository["saveCompiledMission"]>[0]) => { saved = input; return { missionId: input.mission.missionId, missionRevision: input.mission.missionRevision, projectId: input.projectId, planId: input.planId, prdId: input.prdId, prdRevision: input.prdRevision, status: "approved", dispatch: input.dispatch, executionPolicy: input.mission.executionPolicy, stopOnBlockedTestCase: input.stopOnBlockedTestCase, jobs: input.mission.jobs.map((job) => ({ jobId: job.jobId, testCaseId: job.testCaseId, objective: job.testCaseSnapshot.objective, requiredCapabilities: job.requiredCapabilities, status: job.status, sourceRefs: job.testCaseSnapshot.sourceRefs, snapshot: job.testCaseSnapshot })) }; } } as unknown as PrdMissionRepository;
    const service = new MissionIntakeService(targets, plans, missions, { now: () => now });

    await service.create({ projectId: "project-1", targetId: "target-1", targetVersion: 1, targetSnapshotHash: target.snapshotHash, planId: approved.value.planId, planVersion: 2, idempotencyKey: "mission-create" });

    expect(saved?.mission.executionPolicy).toMatchObject({ issuedAt: now, expiresAt: "2026-08-21T12:01:00.000Z" });
    const job = saved?.mission.jobs[0];
    expect(DeterministicRunnerPolicyGate.admitJob({
      jobId: job?.jobId, runId: "run-1", projectId: "project-1", objective: job?.testCaseSnapshot.objective, target: { kind: "web", url: "https://example.test/" },
      policy: saved?.mission.executionPolicy,
    }, { now: () => Date.parse(now) + 1 })).toMatchObject({ status: "allowed" });
  });
});
