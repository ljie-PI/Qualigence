import { createHash } from "node:crypto";
import type { ProjectTargetRepository, TargetRevision } from "@qualigence/project-target";
import { MissionCompiler } from "./mission-compiler.js";
import type { DispatchableMission, PrdMissionRepository } from "./prd-mission-repository.js";
import type { TestPlanRepository } from "./test-plan-repository.js";
import type { ApprovedExecutionPolicy } from "../exploration-policy.js";
import type { MissionStatus, TestMission } from "../domain/test-mission.js";
import type { Clock } from "@qualigence/shared-kernel";

export class MissionIntakeError extends Error {
  constructor(
    readonly code: "MissionInputNotFound" | "MissionInputMismatch" | "MissionIdempotencyConflict" | "MissionCompilationFailed",
    message: string,
    readonly currentVersion?: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "MissionIntakeError";
  }
}

export interface CreateMissionCommand {
  readonly projectId: string;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly targetSnapshotHash: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly idempotencyKey: string;
}

export interface MissionIntakeResult {
  readonly missionId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly version: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly targetSnapshotHash: string;
  readonly runnerId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly status: MissionStatus;
}

function missionId(key: string): string {
  return createHash("sha256").update(`mission\0${key}`).digest("hex").slice(0, 32);
}

function bindingOf(mission: Pick<DispatchableMission, "dispatch">) {
  const binding = mission.dispatch.binding;
  if (binding === undefined) throw new MissionIntakeError("MissionInputMismatch", "Mission binding snapshot is missing");
  return binding;
}

function assertCommandBinding(mission: DispatchableMission, command: CreateMissionCommand): void {
  const binding = bindingOf(mission);
  if (
    mission.projectId !== command.projectId ||
    mission.planId !== command.planId ||
    binding.targetId !== command.targetId ||
    binding.targetVersion !== command.targetVersion ||
    binding.targetSnapshotHash !== command.targetSnapshotHash ||
    binding.planVersion !== command.planVersion
  ) {
    throw new MissionIntakeError(
      "MissionIdempotencyConflict",
      "idempotency key is bound to another Mission command",
      mission.missionRevision,
    );
  }
}

function resultOf(mission: DispatchableMission): MissionIntakeResult {
  const binding = bindingOf(mission);
  return {
    missionId: mission.missionId,
    projectId: mission.projectId,
    revision: mission.missionRevision,
    version: mission.missionVersion ?? 1,
    targetId: binding.targetId,
    targetVersion: binding.targetVersion,
    targetSnapshotHash: binding.targetSnapshotHash,
    runnerId: binding.runnerId,
    planId: mission.planId,
    planVersion: binding.planVersion,
    status: mission.status,
  };
}

function supportedKinds(target: TargetRevision) {
  return target.configuration.kind === "web"
    ? (["navigate", "click", "input", "verify"] as const)
    : (["click", "input", "verify"] as const);
}

function approvedPolicy(target: TargetRevision, issuedAt: string, maximumWallClockMs: number): ApprovedExecutionPolicy {
  const allowedOrigins = target.configuration.kind === "web"
    ? target.configuration.allowedOrigins
    : ["https://desktop.invalid"];
  return {
    policyId: `target:${target.targetId}:${target.version}:${target.snapshotHash}`,
    environment: "isolated_test",
    allowedOrigins,
    allowedActionKinds: target.configuration.kind === "web" ? ["navigate", "click", "input"] : ["click", "input"],
    maximumRisk: "Normal",
    explorationAllowed: false,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + maximumWallClockMs).toISOString(),
  };
}

export class MissionIntakeService {
  constructor(
    private readonly targets: ProjectTargetRepository,
    private readonly plans: TestPlanRepository,
    private readonly missions: PrdMissionRepository,
    private readonly clock: Clock,
    private readonly compiler = new MissionCompiler(),
  ) {}

  async create(command: CreateMissionCommand): Promise<MissionIntakeResult> {
    const id = missionId(command.idempotencyKey);
    const existing = await this.missions.loadMissionForDispatch(id);
    if (existing !== undefined) {
      assertCommandBinding(existing, command);
      return resultOf(existing);
    }

    const target = await this.targets.getRevision(command.targetId, command.targetVersion);
    const plan = await this.plans.get(command.planId, command.planVersion);
    if (target === undefined || plan === undefined || plan.status !== "approved") throw new MissionIntakeError("MissionInputNotFound", "approved Target and Test Plan revisions are required");
    if (target.projectId !== command.projectId || plan.projectId !== command.projectId || target.snapshotHash !== command.targetSnapshotHash) throw new MissionIntakeError("MissionInputMismatch", "Mission input provenance does not match");
    if (target.configuration.kind === "web" && !target.configuration.allowedOrigins.includes(new URL(target.configuration.startUrl).origin)) {
      throw new MissionIntakeError("MissionInputMismatch", "Web Target startUrl origin is not allowed");
    }

    const testCaseIds = plan.testCases.map((testCase) => testCase.id);
    const [firstTestCaseId, ...restTestCaseIds] = testCaseIds;
    if (firstTestCaseId === undefined) throw new MissionIntakeError("MissionCompilationFailed", "approved Test Plan has no test cases");
    const maximumWallClockMs = 60_000;
    const mission: TestMission = {
      missionId: id,
      projectId: command.projectId,
      revision: 1,
      targetId: target.targetId,
      testCaseIds: [firstTestCaseId, ...restTestCaseIds],
      executionBudget: { maximumJobs: plan.testCases.length, maximumStepsPerJob: 100, maximumWallClockMs, maximumModelTokens: 100_000, stopOnBlockedTestCase: true },
      executionPolicy: approvedPolicy(target, this.clock.now(), maximumWallClockMs),
      status: "approved",
    };
    const compiled = this.compiler.compile(plan, mission, { targetId: target.targetId, supportedStepKinds: supportedKinds(target), capabilities: [] });
    if (!compiled.ok) throw new MissionIntakeError("MissionCompilationFailed", compiled.error.message);
    const targetUrl = target.configuration.kind === "web" ? target.configuration.startUrl : "https://desktop.invalid/";
    const saved = await this.missions.saveCompiledMission({
      mission: compiled.value,
      projectId: command.projectId,
      planId: plan.planId,
      prdId: plan.prdId,
      prdRevision: plan.prdRevision,
      dispatch: {
        targetUrl,
        modelProfileId: "default",
        headed: target.configuration.kind === "desktop",
        navigationTimeoutMs: 30_000,
        actionTimeoutMs: 10_000,
        binding: { targetId: target.targetId, targetVersion: target.version, targetSnapshotHash: target.snapshotHash, runnerId: target.runnerId, planVersion: plan.version, configuration: target.configuration },
      },
      stopOnBlockedTestCase: true,
    });
    const persisted = saved ?? await this.missions.loadMissionForDispatch(id);
    if (persisted === undefined) throw new MissionIntakeError("MissionCompilationFailed", "persisted Mission winner is unavailable");
    assertCommandBinding(persisted, command);
    return resultOf(persisted);
  }

  async get(missionId: string): Promise<MissionIntakeResult | undefined> {
    const mission = await this.missions.loadMissionForDispatch(missionId);
    if (mission === undefined) return undefined;
    return resultOf(mission);
  }

  async list(): Promise<readonly MissionIntakeResult[]> {
    const ids = await this.missions.listMissionIds?.() ?? [];
    return (await Promise.all(ids.map((id) => this.get(id)))).filter((mission): mission is MissionIntakeResult => mission !== undefined);
  }
}
