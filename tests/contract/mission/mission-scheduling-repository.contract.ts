import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MissionSchedulingIds, ScheduledMission } from "@qualigence/mission";

export type SchedulingMutation =
  | "mission_revision"
  | "mission_hash"
  | "mission_status"
  | "mission_version"
  | "plan_version"
  | "plan_hash"
  | "plan_status";

export interface SchedulingState {
  readonly missionStatus: string;
  readonly missionVersion: number;
  readonly commands: number;
  readonly runs: number;
  readonly attempts: number;
  readonly runnerJobs: number;
  readonly provenance: number;
  readonly outbox: number;
  readonly wakeups: number;
  readonly acceptedJob?: unknown;
  readonly provenanceRecord?: Readonly<Record<string, unknown>>;
}

export interface MissionSchedulingHarness {
  seed(name: string, tenantId?: string): Promise<void>;
  start(input: {
    readonly name: string;
    readonly tenantId?: string;
    readonly idempotencyKey: string;
    readonly expectedVersion?: number;
    readonly ids: MissionSchedulingIds;
    readonly failAfterWrite?: number;
  }): Promise<ScheduledMission>;
  mutate(name: string, mutation: SchedulingMutation, tenantId?: string): Promise<void>;
  state(name: string, tenantId?: string): Promise<SchedulingState>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface MissionSchedulingContractAdapter {
  createHarness(): Promise<MissionSchedulingHarness>;
}

export interface MissionSchedulingFixture {
  readonly missionId: string;
  readonly planId: string;
  readonly targetId: string;
  readonly logicalJobId: string;
  readonly planJson: string;
  readonly planHash: string;
  readonly compiledJson: string;
  readonly compiledHash: string;
  readonly dispatchJson: string;
  readonly jobSnapshotJson: string;
  readonly jobSnapshotHash: string;
  readonly sourceRefsJson: string;
  readonly requiredCapabilitiesJson: string;
}

const NOW = "2026-08-22T00:00:00.000Z";

export function schedulingFixture(name: string): MissionSchedulingFixture {
  const missionId = `mission-${name}`;
  const planId = `plan-${name}`;
  const targetId = `target-${name}`;
  const logicalJobId = `logical-job-${name}`;
  const sourceRefs = [{ prdId: `prd-${name}`, revision: 1, startOffset: 0, endOffset: 8, quotedTextSha256: hash(`quote-${name}`) }];
  const claim = { claimId: `claim-${name}`, semanticKey: "checkout", statement: "checkout works", sourceRefs, confidence: 1 };
  const testCase = { id: `case-${name}`, title: "Checkout", objective: "verify checkout", preconditions: [], steps: [{ kind: "click", target: { role: "button", name: "Pay", purpose: "submit checkout" } }], expectedClaims: [claim], sourceRefs, priority: "high" };
  const plan = { planId, projectId: `project-${name}`, prdId: `prd-${name}`, prdRevision: 1, version: 2, status: "approved", expectedClaims: [claim], testCases: [testCase], approval: { reviewerId: "reviewer-1", approvedAt: NOW, idempotencyKey: `approve-${name}` } };
  const policy = { policyId: `policy-${name}`, environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: NOW, expiresAt: "2026-08-22T00:01:00.000Z" };
  const compiledJob = { jobId: logicalJobId, missionId, missionRevision: 1, testCaseId: testCase.id, testCaseSnapshot: testCase, targetId, requiredCapabilities: ["web.click"], budget: { maximumStepsPerJob: 10, maximumWallClockMs: 60_000, maximumModelTokens: 1_000 }, status: "queued", idempotencyKey: `${missionId}:1:${testCase.id}`, snapshotHash: hash(JSON.stringify(testCase)) };
  const compiled = { missionId, missionRevision: 1, projectId: `project-${name}`, targetId, executionPolicy: policy, jobs: [compiledJob], compiledHash: hash(JSON.stringify({ missionId, name })) };
  const dispatch = { targetUrl: "https://example.test/", modelProfileId: "default", headed: false, navigationTimeoutMs: 30_000, actionTimeoutMs: 10_000, binding: { targetId, targetVersion: 1, targetSnapshotHash: `target-hash-${name}`, runnerId: `runner-${name}`, planVersion: 2, configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } } };
  return { missionId, planId, targetId, logicalJobId, planJson: JSON.stringify(plan), planHash: hash(JSON.stringify(plan)), compiledJson: JSON.stringify(compiled), compiledHash: compiled.compiledHash, dispatchJson: JSON.stringify(dispatch), jobSnapshotJson: JSON.stringify(testCase), jobSnapshotHash: compiledJob.snapshotHash, sourceRefsJson: JSON.stringify(sourceRefs), requiredCapabilitiesJson: JSON.stringify(compiledJob.requiredCapabilities) };
}

export function missionSchedulingRepositoryContract(name: string, adapter: MissionSchedulingContractAdapter): void {
  describe(`Mission scheduling repository contract (${name})`, () => {
    it("atomically schedules complete immutable execution authority and survives restart", async () => {
      const harness = await adapter.createHarness();
      try {
        await harness.seed("complete");
        const result = await harness.start({ name: "complete", idempotencyKey: "start-complete", ids: ids("winner") });
        expect(result).toMatchObject({ missionVersion: 2, status: "running", runs: [{ logicalJobId: "logical-job-complete", attemptId: "attempt-winner", runnerJobId: "runner-job-winner", runId: "run-winner" }] });
        const state = await harness.state("complete");
        expect(state).toMatchObject({ missionStatus: "running", missionVersion: 2, commands: 1, runs: 1, attempts: 1, runnerJobs: 1, provenance: 1, outbox: 1, wakeups: 1 });
        expect(state.acceptedJob).toMatchObject({ jobId: "runner-job-winner", runId: "run-winner", projectId: "project-complete", policy: { policyId: "policy-complete" }, plan: { missionId: "mission-complete", testCaseId: "case-complete" } });
        expect(state.provenanceRecord).toMatchObject({ project_id: "project-complete", mission_compiled_hash: schedulingFixture("complete").compiledHash, plan_version: 2, plan_snapshot_hash: schedulingFixture("complete").planHash, target_version: 1, target_snapshot_hash: "target-hash-complete", runner_id: "runner-complete" });
        expect(JSON.parse(String(state.provenanceRecord?.target_snapshot_json))).toMatchObject({ targetId: "target-complete", displayName: "Target", runnerId: "runner-complete", version: 1 });
        expect(JSON.parse(String(state.provenanceRecord?.plan_snapshot_json))).toMatchObject({ planId: "plan-complete", version: 2, status: "approved" });
        expect(JSON.parse(String(state.provenanceRecord?.mission_snapshot_json))).toMatchObject({ missionId: "mission-complete", compiledHash: schedulingFixture("complete").compiledHash });
        await harness.restart();
        await expect(harness.start({ name: "complete", idempotencyKey: "start-complete", ids: throwingIds() })).resolves.toEqual(result);
      } finally { await harness.close(); }
    });

    it("returns stable idempotency and stale-input conflicts without writes", async () => {
      const harness = await adapter.createHarness();
      try {
        await harness.seed("conflict");
        await harness.start({ name: "conflict", idempotencyKey: "same-key", ids: ids("first") });
        await expect(harness.start({ name: "conflict", idempotencyKey: "same-key", expectedVersion: 0, ids: throwingIds() })).rejects.toMatchObject({ code: "IdempotencyConflict", actualVersion: 2 });
        expect(await harness.state("conflict")).toMatchObject({ commands: 1, runs: 1, attempts: 1, outbox: 1, wakeups: 1 });
      } finally { await harness.close(); }
    });

    it.each([
      ["mission_revision", "MissionRevisionConflict"], ["mission_hash", "MissionHashConflict"],
      ["mission_status", "MissionStatusConflict"], ["mission_version", "MissionVersionConflict"],
      ["plan_version", "PlanVersionConflict"], ["plan_hash", "PlanHashConflict"],
      ["plan_status", "PlanStatusConflict"],
    ] as const)("rejects stale %s before writing", async (mutation, code) => {
      const harness = await adapter.createHarness();
      try {
        await harness.seed(mutation);
        await harness.mutate(mutation, mutation);
        await expect(harness.start({ name: mutation, idempotencyKey: `start-${mutation}`, ids: throwingIds() })).rejects.toMatchObject({ code });
        expect(await harness.state(mutation)).toMatchObject({ commands: 0, runs: 0, attempts: 0, runnerJobs: 0, provenance: 0, outbox: 0, wakeups: 0 });
      } finally { await harness.close(); }
    });

    it("rolls back after every scheduling write", async () => {
      const harness = await adapter.createHarness();
      try {
        for (let write = 1; write <= 9; write += 1) {
          const scenario = `rollback-${write}`;
          await harness.seed(scenario);
          await expect(harness.start({ name: scenario, idempotencyKey: `start-${scenario}`, ids: ids(scenario), failAfterWrite: write })).rejects.toThrow(`InjectedFailureAfterWrite:${write}`);
          expect(await harness.state(scenario)).toMatchObject({ missionStatus: "approved", missionVersion: 1, commands: 0, runs: 0, attempts: 0, runnerJobs: 0, provenance: 0, outbox: 0, wakeups: 0 });
        }
      } finally { await harness.close(); }
    });

    it("allocates identities once under concurrent semantic replay", async () => {
      const harness = await adapter.createHarness();
      try {
        await harness.seed("concurrent");
        let allocations = 0;
        const allocatingIds: MissionSchedulingIds = { allocateAttemptId: () => `attempt-${++allocations}`, allocateRunnerJobId: () => `runner-job-${++allocations}`, allocateRunId: () => `run-${++allocations}` };
        const [first, second] = await Promise.all([
          harness.start({ name: "concurrent", idempotencyKey: "same-command", ids: allocatingIds }),
          new Promise((resolve) => setTimeout(resolve, 25)).then(() => harness.start({ name: "concurrent", idempotencyKey: "same-command", ids: allocatingIds })),
        ]);
        expect(second).toEqual(first);
        expect(allocations).toBe(3);
        expect(await harness.state("concurrent")).toMatchObject({ commands: 1, runs: 1, attempts: 1, outbox: 1, wakeups: 1 });
      } finally { await harness.close(); }
    });

    it("isolates tenant scheduling and permits the same key in another tenant", async () => {
      const harness = await adapter.createHarness();
      try {
        await harness.seed("tenant", "tenant-a");
        await harness.seed("tenant", "tenant-b");
        await harness.start({ name: "tenant", tenantId: "tenant-a", idempotencyKey: "tenant-key", ids: ids("a") });
        expect(await harness.state("tenant", "tenant-b")).toMatchObject({ missionStatus: "approved", commands: 0, runs: 0, outbox: 0 });
        await expect(harness.start({ name: "tenant", tenantId: "tenant-b", idempotencyKey: "tenant-key", ids: ids("b") })).resolves.toMatchObject({ runs: [{ runId: "run-b" }] });
      } finally { await harness.close(); }
    });
  });
}

function ids(suffix: string): MissionSchedulingIds {
  return { allocateAttemptId: () => `attempt-${suffix}`, allocateRunnerJobId: () => `runner-job-${suffix}`, allocateRunId: () => `run-${suffix}` };
}

function throwingIds(): MissionSchedulingIds {
  const fail = (): string => { throw new Error("allocator invoked"); };
  return { allocateAttemptId: fail, allocateRunnerJobId: fail, allocateRunId: fail };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
