import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { capabilities, negotiateCapabilities } from "@qualigence/runner-protocol";
import type {
  AcceptedMissionDispatch,
  MissionDispatchAcceptanceReceipt,
  MissionSchedulingIds,
  PendingMissionDispatch,
  ScheduledMission,
} from "@qualigence/mission";

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
  mutateBeforeStart(name: string, mutation: SchedulingMutation, tenantId?: string): Promise<void>;
  overlap(inputs: readonly [MissionSchedulingOverlapInput, MissionSchedulingOverlapInput]): Promise<readonly [MissionSchedulingOverlapResult, MissionSchedulingOverlapResult]>;
  pendingDispatches(limit: number, tenantId?: string): Promise<readonly PendingMissionDispatch[]>;
  markDispatchAccepted(input: {
    readonly attemptId: string;
    readonly receipt: MissionDispatchAcceptanceReceipt;
    readonly expectedVersion: number;
    readonly tenantId?: string;
  }): Promise<AcceptedMissionDispatch>;
  mutateLogicalJobCapabilities(name: string, capabilities: readonly string[], tenantId?: string): Promise<void>;
  overlapAccept(inputs: readonly [MissionDispatchAcceptInput, MissionDispatchAcceptInput]): Promise<readonly [PromiseSettledResult<AcceptedMissionDispatch>, PromiseSettledResult<AcceptedMissionDispatch>]>;
  state(name: string, tenantId?: string): Promise<SchedulingState>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface MissionSchedulingStartInput {
  readonly name: string;
  readonly tenantId?: string;
  readonly idempotencyKey: string;
  readonly expectedVersion?: number;
  readonly ids: MissionSchedulingIds;
  readonly failAfterWrite?: number;
}

export interface MissionSchedulingOverlapInput extends Omit<MissionSchedulingStartInput, "ids"> {
  readonly allocatorSuffix: string;
}

export interface MissionSchedulingOverlapResult {
  readonly outcome: PromiseSettledResult<ScheduledMission>;
  readonly allocations: number;
}

export interface MissionDispatchAcceptInput {
  readonly attemptId: string;
  readonly receipt: MissionDispatchAcceptanceReceipt;
  readonly expectedVersion: number;
  readonly tenantId?: string;
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
  const compiledJob = { jobId: logicalJobId, missionId, missionRevision: 1, testCaseId: testCase.id, testCaseSnapshot: testCase, targetId, requiredCapabilities: ["action:click", "model:structured-output", "target:web-playwright"], budget: { maximumStepsPerJob: 10, maximumWallClockMs: 60_000, maximumModelTokens: 1_000 }, status: "queued", idempotencyKey: `${missionId}:1:${testCase.id}`, snapshotHash: hash(JSON.stringify(testCase)) };
  const planHash = hash(JSON.stringify(plan));
  const compiled = { missionId, missionRevision: 1, projectId: `project-${name}`, planId, planVersion: 2, planSnapshotHash: planHash, targetId, targetVersion: 1, targetSnapshotHash: `target-hash-${name}`, executionPolicy: policy, jobs: [compiledJob], compiledHash: hash(JSON.stringify({ missionId, name })) };
  const dispatch = { targetUrl: "https://example.test/", modelProfileId: "default", headed: false, navigationTimeoutMs: 30_000, actionTimeoutMs: 10_000, binding: { targetId, targetVersion: 1, targetSnapshotHash: `target-hash-${name}`, runnerId: `runner-${name}`, planVersion: 2, planSnapshotHash: planHash, configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } } };
  return { missionId, planId, targetId, logicalJobId, planJson: JSON.stringify(plan), planHash, compiledJson: JSON.stringify(compiled), compiledHash: compiled.compiledHash, dispatchJson: JSON.stringify(dispatch), jobSnapshotJson: JSON.stringify(testCase), jobSnapshotHash: compiledJob.snapshotHash, sourceRefsJson: JSON.stringify(sourceRefs), requiredCapabilitiesJson: JSON.stringify(compiledJob.requiredCapabilities) };
}

export function prdMissionRepositorySchedulingContract(name: string, adapter: MissionSchedulingContractAdapter): void {
  describe(`PrdMissionRepository scheduling contract (${name})`, () => {
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
        expect(await harness.pendingDispatches(1)).toEqual([
          expect.objectContaining({
            attemptId: "attempt-winner",
            requiredCapabilities: ["action:click", "model:structured-output", "target:web-playwright"],
            status: "pending",
            version: 1,
          }),
        ]);
        await harness.restart();
        await expect(harness.start({ name: "complete", idempotencyKey: "start-complete", ids: throwingIds() })).resolves.toEqual(result);
      } finally { await harness.close(); }
    });

    it("selects pending dispatches in stable order and validates the batch bound", async () => {
      const harness = await adapter.createHarness();
      const tenantId = "tenant-pending-order";
      try {
        await harness.seed("pending-z", tenantId);
        await harness.seed("pending-a", tenantId);
        await harness.start({ name: "pending-z", tenantId, idempotencyKey: "start-z", ids: ids("z") });
        await harness.start({ name: "pending-a", tenantId, idempotencyKey: "start-a", ids: ids("a") });

        for (const invalidLimit of [0, 257, 1.5, Number.POSITIVE_INFINITY]) {
          await expect(harness.pendingDispatches(invalidLimit, tenantId)).rejects.toThrow("Invalid Mission dispatch batch limit");
        }
        expect((await harness.pendingDispatches(1, tenantId)).map(({ attemptId }) => attemptId)).toEqual(["attempt-a"]);
        expect((await harness.pendingDispatches(2, tenantId)).map(({ attemptId }) => attemptId)).toEqual(["attempt-a", "attempt-z"]);
      } finally { await harness.close(); }
    });

    it("accepts with CAS, replays the exact token-free receipt after restart, and preserves requirements", async () => {
      const harness = await adapter.createHarness();
      const tenantId = "tenant-accept-replay";
      try {
        await harness.seed("accept-replay", tenantId);
        await harness.start({ name: "accept-replay", tenantId, idempotencyKey: "start-accept-replay", ids: ids("accept-replay") });
        const pending = (await harness.pendingDispatches(1, tenantId))[0]!;
        const receipt = receiptFor(pending, "accepted");

        await expect(harness.markDispatchAccepted({
          attemptId: pending.attemptId,
          receipt: { ...receipt, ...({ leaseToken: "forbidden-secret" } as Record<string, string>) },
          expectedVersion: pending.version,
          tenantId,
        })).rejects.toThrow("Invalid Mission dispatch acceptance receipt");
        const accepted = await harness.markDispatchAccepted({ attemptId: pending.attemptId, receipt, expectedVersion: pending.version, tenantId });
        expect(accepted).toMatchObject({ status: "accepted", version: 2, acceptedAt: receipt.acceptedAt, receipt });
        expect(accepted.requiredCapabilities).toEqual(pending.requiredCapabilities);
        await harness.restart();
        await expect(harness.markDispatchAccepted({ attemptId: pending.attemptId, receipt, expectedVersion: pending.version, tenantId })).resolves.toEqual(accepted);
        await expect(harness.pendingDispatches(1, tenantId)).resolves.toEqual([]);
      } finally { await harness.close(); }
    });

    it("keeps outbox requirements immutable and negotiates exact Runner protocol tokens", async () => {
      const harness = await adapter.createHarness();
      const tenantId = "tenant-capabilities";
      try {
        await harness.seed("capabilities", tenantId);
        await harness.start({ name: "capabilities", tenantId, idempotencyKey: "start-capabilities", ids: ids("capabilities") });
        await harness.mutateLogicalJobCapabilities("capabilities", ["model:vision-input"], tenantId);
        const pending = (await harness.pendingDispatches(1, tenantId))[0]!;

        expect(pending.requiredCapabilities).toEqual([
          "action:click",
          "model:structured-output",
          "target:web-playwright",
        ]);
        expect(negotiateCapabilities(capabilities({
          targetAdapters: ["web-playwright"],
          actionKinds: ["click"],
        }), pending.requiredCapabilities)).toEqual({ outcome: "accepted" });
        expect(negotiateCapabilities(capabilities({
          targetAdapters: ["web-playwright"],
          actionKinds: [],
        }), pending.requiredCapabilities)).toEqual({
          outcome: "rejected",
          rejection: { code: "CapabilityMismatch", missingCapabilities: ["action:click"] },
        });
        await expect(harness.pendingDispatches(1, tenantId)).resolves.toEqual([pending]);
      } finally { await harness.close(); }
    });

    it("rejects stale acceptance without changing the pending dispatch", async () => {
      const harness = await adapter.createHarness();
      const tenantId = "tenant-accept-stale";
      try {
        await harness.seed("accept-stale", tenantId);
        await harness.start({ name: "accept-stale", tenantId, idempotencyKey: "start-accept-stale", ids: ids("accept-stale") });
        const pending = (await harness.pendingDispatches(1, tenantId))[0]!;
        await expect(harness.markDispatchAccepted({ attemptId: pending.attemptId, receipt: receiptFor(pending, "accepted"), expectedVersion: 0, tenantId })).rejects.toMatchObject({ code: "MissionDispatchVersionConflict", actualVersion: 1 });
        await expect(harness.pendingDispatches(1, tenantId)).resolves.toEqual([pending]);
      } finally { await harness.close(); }
    });

    it("allows one concurrent acceptance winner and rejects the conflicting receipt", async () => {
      const harness = await adapter.createHarness();
      const tenantId = "tenant-accept-race";
      try {
        await harness.seed("accept-race", tenantId);
        await harness.start({ name: "accept-race", tenantId, idempotencyKey: "start-accept-race", ids: ids("accept-race") });
        const pending = (await harness.pendingDispatches(1, tenantId))[0]!;
        const outcomes = await harness.overlapAccept([
          { attemptId: pending.attemptId, receipt: receiptFor(pending, "accepted"), expectedVersion: pending.version, tenantId },
          { attemptId: pending.attemptId, receipt: receiptFor(pending, "already_active"), expectedVersion: pending.version, tenantId },
        ]);
        expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter(({ status }) => status === "rejected").map((outcome) => outcome.status === "rejected" ? outcome.reason : undefined)).toEqual([
          expect.objectContaining({ code: "MissionDispatchReceiptConflict", actualVersion: 2 }),
        ]);
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

    it("rejects a Test Plan changed before Mission pre-load without allocating or writing", async () => {
      const harness = await adapter.createHarness();
      try {
        await harness.seed("preload-plan-hash");
        await harness.mutateBeforeStart("preload-plan-hash", "plan_hash");
        await expect(harness.start({ name: "preload-plan-hash", idempotencyKey: "start-preload-plan-hash", ids: throwingIds() })).rejects.toMatchObject({ code: "PlanHashConflict" });
        expect(await harness.state("preload-plan-hash")).toMatchObject({ missionStatus: "approved", missionVersion: 1, commands: 0, runs: 0, attempts: 0, runnerJobs: 0, provenance: 0, outbox: 0, wakeups: 0 });
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

    it("overlaps same-key same-command writers and replays the winner without a second allocation", async () => {
      const harness = await adapter.createHarness();
      try {
        await harness.seed("same-command");
        const results = await harness.overlap([
          { name: "same-command", idempotencyKey: "same-command-overlap-key", allocatorSuffix: "first" },
          { name: "same-command", idempotencyKey: "same-command-overlap-key", allocatorSuffix: "second" },
        ]);
        const outcomes = results.map(({ outcome }) => outcome);
        expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
        const values = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
        expect(values[1]).toEqual(values[0]);
        expect(results.map(({ allocations }) => allocations).sort()).toEqual([0, 3]);
        expect(await harness.state("same-command")).toMatchObject({ missionStatus: "running", missionVersion: 2, commands: 1, runs: 1, attempts: 1, runnerJobs: 1, provenance: 1, outbox: 1, wakeups: 1 });
      } finally { await harness.close(); }
    });

    it("overlaps same-key different-command writers and binds the key to one atomic winner", async () => {
      const harness = await adapter.createHarness();
      try {
        await harness.seed("different-command-a");
        await harness.seed("different-command-b");
        const results = await harness.overlap([
          { name: "different-command-a", idempotencyKey: "shared-key", allocatorSuffix: "different-a" },
          { name: "different-command-b", idempotencyKey: "shared-key", allocatorSuffix: "different-b" },
        ]);
        const outcomes = results.map(({ outcome }) => outcome);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason)).toEqual([
          expect.objectContaining({ code: "IdempotencyConflict", actualVersion: 2 }),
        ]);
        expect(results.map(({ allocations }) => allocations).sort()).toEqual([0, 3]);
        const states = await Promise.all([harness.state("different-command-a"), harness.state("different-command-b")]);
        expect(states.map((state) => state.missionStatus).sort()).toEqual(["approved", "running"]);
        for (const field of ["commands", "runs", "attempts", "runnerJobs", "provenance", "outbox", "wakeups"] as const) {
          expect(states.reduce((sum, state) => sum + state[field], 0), field).toBe(1);
        }
      } finally { await harness.close(); }
    });

    it("overlaps different-key writers and returns a stable stale-version conflict with one atomic state", async () => {
      const harness = await adapter.createHarness();
      try {
        await harness.seed("different-key");
        const results = await harness.overlap([
          { name: "different-key", idempotencyKey: "key-a", allocatorSuffix: "first-key" },
          { name: "different-key", idempotencyKey: "key-b", allocatorSuffix: "second-key" },
        ]);
        const outcomes = results.map(({ outcome }) => outcome);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason)).toEqual([
          expect.objectContaining({ code: "MissionVersionConflict", actualVersion: 2 }),
        ]);
        expect(await harness.state("different-key")).toMatchObject({ missionStatus: "running", missionVersion: 2, commands: 1, runs: 1, attempts: 1, runnerJobs: 1, provenance: 1, outbox: 1, wakeups: 1 });
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

function receiptFor(pending: PendingMissionDispatch, status: MissionDispatchAcceptanceReceipt["status"]): MissionDispatchAcceptanceReceipt {
  return {
    status,
    jobId: pending.runnerJobId,
    runId: pending.runId,
    acceptedAt: "2026-08-22T00:00:01.000Z",
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
