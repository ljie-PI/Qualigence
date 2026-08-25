import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AcceptedMissionDispatch,
  MissionSchedulingIds,
  BlockedMissionDispatch,
  MissionDispatchAcceptanceReceipt,
  PendingMissionDispatch,
  PrdMissionRepository,
} from "@qualigence/mission";
import { MissionSchedulingService } from "@qualigence/mission";
import type { AcceptedExecutionJob, ExecutionJobLease } from "@qualigence/runner-protocol";
import { SqlitePrdMissionStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import { MissionDispatchLoop, type MissionDispatchLeaseReader, type MissionDispatchRunnerConnection } from "../../../apps/server/src/mission-dispatch-loop.js";
import { WEB_GRAPH_V1_REQUIREMENTS, WEB_TARGET_TOKEN, webJob } from "../../helpers/core-runner-harness.js";
import { schedulingFixture } from "../../contract/mission/prd-mission-repository.contract.js";

const clock = { now: () => "2026-08-24T00:00:00.000Z" };

function dispatch(overrides: Partial<PendingMissionDispatch> = {}): PendingMissionDispatch {
  const job = overrides.job ?? missionJob();
  return {
    attemptId: "attempt-1",
    missionId: "mission-1",
    runnerId: "runner-1",
    runnerJobId: job.jobId,
    runId: job.runId,
    requiredCapabilities: WEB_GRAPH_V1_REQUIREMENTS,
    job,
    status: "pending",
    version: 1,
    createdAt: "2026-08-23T12:00:00.000Z",
    ...overrides,
  };
}

function missionJob(overrides: Partial<PendingMissionDispatch["job"]> = {}): PendingMissionDispatch["job"] {
  return {
    ...webJob({ jobId: "runner-job-1", runId: "run-1", projectId: "project-1" }),
    policy: {
      policyId: "policy-test",
      environment: "isolated_test",
      allowedOrigins: ["https://shop.example.test"],
      allowedActionKinds: ["click"],
      maximumRisk: "Normal",
      explorationAllowed: false,
      issuedAt: "2026-08-24T00:00:00.000Z",
      expiresAt: "2026-08-24T00:01:00.000Z",
    },
    plan: {
      missionId: "mission-1",
      missionRevision: 1,
      testCaseId: "case-1",
      steps: [{ kind: "click", target: { role: "button", name: "Add to cart", purpose: "add item" } }],
      expectedClaimIds: ["claim-1"],
      budget: { maximumStepsPerJob: 1, maximumWallClockMs: 60_000, maximumModelTokens: 1_000 },
    },
    ...overrides,
  };
}

function leaseFor(job: AcceptedExecutionJob): ExecutionJobLease {
  return {
    jobId: job.jobId,
    runId: job.runId,
    leaseToken: `lease-${job.runId}`,
    leaseEpoch: 1,
    expiresAt: "2026-08-24T00:01:00.000Z",
  };
}

type DispatchRow = PendingMissionDispatch | AcceptedMissionDispatch | BlockedMissionDispatch;

class MissionDispatchRepositoryFake implements Pick<PrdMissionRepository, "pendingDispatches" | "markDispatchAccepted" | "markDispatchBlocked"> {
  readonly acceptCalls: Array<{ readonly attemptId: string; readonly receipt: MissionDispatchAcceptanceReceipt; readonly expectedVersion: number }> = [];
  readonly blockCalls: Array<{ readonly attemptId: string; readonly expectedVersion: number }> = [];
  rows: DispatchRow[] = [];
  failAccept = false;
  failBlock = false;

  async pendingDispatches(_limit: number): Promise<readonly PendingMissionDispatch[]> {
    return this.rows.filter((row): row is PendingMissionDispatch => row.status === "pending");
  }

  async markDispatchAccepted(
    attemptId: string,
    receipt: MissionDispatchAcceptanceReceipt,
    expectedVersion: number,
  ): Promise<AcceptedMissionDispatch> {
    this.acceptCalls.push({ attemptId, receipt, expectedVersion });
    if (this.failAccept) throw new Error("accept persistence failed");
    const current = this.rows.find((row) => row.attemptId === attemptId);
    if (current === undefined) throw new Error("missing dispatch");
    if (current.status === "accepted") return current;
    if (current.status !== "pending" || current.version !== expectedVersion) throw Object.assign(new Error("stale"), { code: "MissionDispatchVersionConflict" });
    const accepted = { ...current, status: "accepted" as const, version: expectedVersion + 1, acceptedAt: receipt.acceptedAt, receipt };
    this.rows = this.rows.map((row) => row.attemptId === attemptId ? accepted : row);
    return accepted;
  }

  async markDispatchBlocked(attemptId: string, expectedVersion: number): Promise<BlockedMissionDispatch> {
    this.blockCalls.push({ attemptId, expectedVersion });
    if (this.failBlock) throw new Error("block persistence failed");
    const current = this.rows.find((row) => row.attemptId === attemptId);
    if (current === undefined) throw new Error("missing dispatch");
    if (current.status === "blocked") return current;
    if (current.status !== "pending" || current.version !== expectedVersion) throw Object.assign(new Error("stale"), { code: "MissionDispatchVersionConflict" });
    const blocked = { ...current, status: "blocked" as const, version: expectedVersion + 1 };
    this.rows = this.rows.map((row) => row.attemptId === attemptId ? blocked : row);
    return blocked;
  }
}

class BlockingBarrierRepositoryFake extends MissionDispatchRepositoryFake {
  private readonly entered: Array<() => void> = [];
  private releaseBarrier: (() => void) | undefined;

  waitForBlockedCallers(count: number): Promise<void> {
    return new Promise((resolve) => {
      this.entered.push(resolve);
      if (this.blockCalls.length >= count) resolve();
    });
  }

  release(): void {
    this.releaseBarrier?.();
  }

  override async markDispatchAccepted(
    attemptId: string,
    receipt: MissionDispatchAcceptanceReceipt,
    expectedVersion: number,
  ): Promise<AcceptedMissionDispatch> {
    await this.awaitBarrier();
    return super.markDispatchAccepted(attemptId, receipt, expectedVersion);
  }

  override async markDispatchBlocked(attemptId: string, expectedVersion: number): Promise<BlockedMissionDispatch> {
    this.blockCalls.push({ attemptId, expectedVersion });
    for (const resolve of this.entered.splice(0)) resolve();
    await this.awaitBarrier();
    if (this.failBlock) throw new Error("block persistence failed");
    const current = this.rows.find((row) => row.attemptId === attemptId);
    if (current === undefined) throw new Error("missing dispatch");
    if (current.status === "blocked") return current;
    if (current.status !== "pending" || current.version !== expectedVersion) throw Object.assign(new Error("stale"), { code: "MissionDispatchVersionConflict" });
    const blocked = { ...current, status: "blocked" as const, version: expectedVersion + 1 };
    this.rows = this.rows.map((row) => row.attemptId === attemptId ? blocked : row);
    return blocked;
  }

  holdWrites(): void {
    this.releaseBarrier = undefined;
    const barrier = new Promise<void>((resolve) => {
      this.releaseBarrier = resolve;
    });
    this.awaitBarrier = () => barrier;
  }

  private awaitBarrier: () => Promise<void> = async () => undefined;
}

class RunnerDirectoryFake {
  connection: MissionDispatchRunnerConnection | undefined;
  readonly lookups: Array<{ readonly tenantId: string; readonly runnerId: string }> = [];

  async connectionFor(input: { readonly tenantId: string; readonly runnerId: string }): Promise<MissionDispatchRunnerConnection | undefined> {
    this.lookups.push(input);
    return this.connection;
  }
}

class LeaseReaderFake {
  leaseRecord: Awaited<ReturnType<MissionDispatchLeaseReader["lease"]>>;
  readonly lookups: string[] = [];

  async lease(runId: string) {
    this.lookups.push(runId);
    return this.leaseRecord;
  }
}

function connection(overrides: Partial<MissionDispatchRunnerConnection> = {}): MissionDispatchRunnerConnection {
  return {
    authenticatedRunner: {
      runnerId: "runner-1",
      scope: { kind: "tenant", tenantId: "tenant-1", projectIds: ["project-1"] },
      capabilities: WEB_GRAPH_V1_REQUIREMENTS,
    },
    offer: async (job) => leaseFor(job),
    ...overrides,
  };
}

function makeLoop(input: {
  readonly repository: MissionDispatchRepositoryFake;
  readonly runners?: RunnerDirectoryFake;
  readonly leases?: LeaseReaderFake;
  readonly initialBackoffMs?: number;
  readonly maximumBackoffMs?: number;
}): { readonly loop: MissionDispatchLoop; readonly runners: RunnerDirectoryFake; readonly leases: LeaseReaderFake } {
  const runners = input.runners ?? new RunnerDirectoryFake();
  const leases = input.leases ?? new LeaseReaderFake();
  const loop = new MissionDispatchLoop({
    tenantId: "tenant-1",
    repository: input.repository,
    runners,
    leases,
    clock,
    initialBackoffMs: input.initialBackoffMs ?? 100,
    maximumBackoffMs: input.maximumBackoffMs ?? 1_000,
  });
  return { loop, runners, leases };
}

describe("MissionDispatchLoop", () => {
  it("offers a scheduled Job only to its bound tenant Runner and records a stable acceptance receipt", async () => {
    const repository = new MissionDispatchRepositoryFake();
    const row = dispatch();
    repository.rows = [row];
    const offered: Array<{ readonly job: AcceptedExecutionJob; readonly requirements: readonly string[] }> = [];
    const { loop, runners } = makeLoop({ repository });
    runners.connection = connection({
      offer: async (job, requirements) => {
        offered.push({ job, requirements });
        return leaseFor(job);
      },
    });

    const result = await loop.runOnce();

    expect(runners.lookups).toEqual([{ tenantId: "tenant-1", runnerId: "runner-1" }]);
    expect(offered).toEqual([{ job: row.job, requirements: WEB_GRAPH_V1_REQUIREMENTS }]);
    expect(repository.acceptCalls).toEqual([{ attemptId: "attempt-1", expectedVersion: 1, receipt: { status: "accepted", jobId: "runner-job-1", runId: "run-1", acceptedAt: row.createdAt } }]);
    expect(result).toMatchObject({ totalPending: 1, attempted: 1, accepted: 1, pending: 0, blocked: 0 });
    expect(result.results[0]).toMatchObject({ outcome: "accepted", receipt: { status: "accepted", jobId: "runner-job-1", runId: "run-1", acceptedAt: row.createdAt } });
  });

  it("leaves an offline bound Runner pending with bounded loop-local backoff", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.rows = [dispatch()];
    const { loop } = makeLoop({ repository, initialBackoffMs: 100, maximumBackoffMs: 150 });

    const first = await loop.runOnce();
    const second = await loop.runOnce();

    expect(first.results).toEqual([{ outcome: "pending", attemptId: "attempt-1", runnerId: "runner-1", reason: "runner_offline", retryAfterMs: 100 }]);
    expect(second.results).toEqual([{ outcome: "pending", attemptId: "attempt-1", runnerId: "runner-1", reason: "backing_off", retryAfterMs: 100 }]);
    expect(repository.acceptCalls).toHaveLength(0);
    expect(repository.rows[0]?.status).toBe("pending");
  });

  it("blocks capability mismatch explicitly without selecting another Runner", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.rows = [dispatch({ requiredCapabilities: [...WEB_GRAPH_V1_REQUIREMENTS, "model:vision-input"] })];
    const { loop, runners } = makeLoop({ repository });
    const offered: AcceptedExecutionJob[] = [];
    runners.connection = connection({
      authenticatedRunner: {
        runnerId: "runner-1",
        scope: { kind: "tenant", tenantId: "tenant-1", projectIds: ["project-1"] },
        capabilities: WEB_GRAPH_V1_REQUIREMENTS,
      },
      offer: async (job) => {
        offered.push(job);
        return leaseFor(job);
      },
    });

    const result = await loop.runOnce();

    expect(result.results[0]).toMatchObject({ outcome: "blocked", attemptId: "attempt-1", runnerId: "runner-1", reason: "capability_mismatch", details: { missingCapabilities: ["model:vision-input"] } });
    expect(repository.rows[0]?.status).toBe("blocked");
    expect(offered).toEqual([]);
    expect(runners.lookups).toEqual([{ tenantId: "tenant-1", runnerId: "runner-1" }]);
    expect(repository.acceptCalls).toHaveLength(0);
  });

  it("blocks tenant/project scope mismatches before exposing the Job payload", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.rows = [dispatch()];
    const { loop, runners } = makeLoop({ repository });
    let offered = false;
    runners.connection = connection({
      authenticatedRunner: {
        runnerId: "runner-1",
        scope: { kind: "tenant", tenantId: "tenant-2", projectIds: ["project-1"] },
        capabilities: WEB_GRAPH_V1_REQUIREMENTS,
      },
      offer: async (job) => {
        offered = true;
        return leaseFor(job);
      },
    });

    await expect(loop.runOnce()).resolves.toMatchObject({ blocked: 1, results: [{ outcome: "blocked", reason: "tenant_scope_mismatch" }] });
    expect(offered).toBe(false);
    expect(repository.acceptCalls).toHaveLength(0);
    expect(repository.rows[0]?.status).toBe("blocked");
  });

  it("cancels before offer without writing a lease, receipt, or durable block", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.rows = [dispatch()];
    const controller = new AbortController();
    controller.abort();
    const runners = new RunnerDirectoryFake();
    const cancelled = new MissionDispatchLoop({
      tenantId: "tenant-1",
      repository,
      runners,
      leases: new LeaseReaderFake(),
      clock,
      signal: controller.signal,
      initialBackoffMs: 100,
      maximumBackoffMs: 1_000,
    });
    let offered = false;
    runners.connection = connection({ offer: async (job) => { offered = true; return leaseFor(job); } });

    const result = await cancelled.runOnce();

    expect(result.results).toEqual([{ outcome: "pending", attemptId: "attempt-1", runnerId: "runner-1", reason: "cancelled", retryAfterMs: 0 }]);
    expect(offered).toBe(false);
    expect(repository.acceptCalls).toHaveLength(0);
    expect(repository.blockCalls).toHaveLength(0);
    expect(repository.rows[0]?.status).toBe("pending");
  });

  it("defers before offer when the loop deadline is exhausted", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.rows = [dispatch()];
    const runners = new RunnerDirectoryFake();
    runners.connection = connection({ offer: async (job) => { throw new Error(`unexpected offer ${job.jobId}`); } });
    const loop = new MissionDispatchLoop({
      tenantId: "tenant-1",
      repository,
      runners,
      leases: new LeaseReaderFake(),
      clock,
      deadlineAt: clock.now(),
      initialBackoffMs: 100,
      maximumBackoffMs: 1_000,
    });

    await expect(loop.runOnce()).resolves.toMatchObject({ pending: 1, results: [{ outcome: "pending", reason: "deadline_exceeded", retryAfterMs: 100 }] });
    expect(repository.acceptCalls).toHaveLength(0);
    expect(repository.blockCalls).toHaveLength(0);
  });

  it("blocks policy invalid through the existing execution policy seam before offer", async () => {
    const repository = new MissionDispatchRepositoryFake();
    const invalidPolicyJob = missionJob({
      policy: {
        policyId: "policy-invalid",
        environment: "isolated_test",
        allowedOrigins: ["https://shop.example.test"],
        allowedActionKinds: ["click"],
        maximumRisk: "Normal",
        explorationAllowed: false,
        issuedAt: "2026-08-18T00:00:00.000Z",
        expiresAt: "2026-08-18T00:00:00.000Z",
      },
    });
    repository.rows = [dispatch({ job: invalidPolicyJob })];
    const { loop, runners } = makeLoop({ repository });
    let offered = false;
    runners.connection = connection({ offer: async (job) => { offered = true; return leaseFor(job); } });

    await expect(loop.runOnce()).resolves.toMatchObject({ blocked: 1, results: [{ outcome: "blocked", reason: "policy_invalid" }] });
    expect(offered).toBe(false);
    expect(repository.rows[0]?.status).toBe("blocked");
  });

  it("blocks an expired execution policy before offer using the loop clock", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.rows = [dispatch({
      job: missionJob({
        policy: {
          policyId: "policy-expired",
          environment: "isolated_test",
          allowedOrigins: ["https://shop.example.test"],
          allowedActionKinds: ["click"],
          maximumRisk: "Normal",
          explorationAllowed: false,
          issuedAt: "2026-08-23T00:00:00.000Z",
          expiresAt: "2026-08-23T00:01:00.000Z",
        },
      }),
    })];
    const { loop, runners } = makeLoop({ repository });
    let offered = false;
    runners.connection = connection({ offer: async (job) => { offered = true; return leaseFor(job); } });

    await expect(loop.runOnce()).resolves.toMatchObject({ blocked: 1, results: [{ outcome: "blocked", reason: "policy_invalid", details: { error: "Execution policy is expired." } }] });
    expect(offered).toBe(false);
  });

  it("reconciles an existing lease to the canonical already_active receipt instead of minting a second lease", async () => {
    const repository = new MissionDispatchRepositoryFake();
    const row = dispatch();
    repository.rows = [row];
    const leases = new LeaseReaderFake();
    leases.leaseRecord = { job: row.job, owner: { runnerId: "runner-1" } };
    const { loop, runners } = makeLoop({ repository, leases });
    let offered = false;
    runners.connection = connection({
      offer: async (job) => {
        offered = true;
        return leaseFor(job);
      },
    });

    const result = await loop.runOnce();

    expect(offered).toBe(false);
    expect(result.results[0]).toMatchObject({ outcome: "accepted", receipt: { status: "already_active", jobId: "runner-job-1", runId: "run-1", acceptedAt: row.createdAt } });
    expect(repository.acceptCalls).toHaveLength(1);
  });

  it("replays an accepted lease as already_active even after policy expiry", async () => {
    const repository = new MissionDispatchRepositoryFake();
    const expiredJob = missionJob({
      policy: {
        policyId: "policy-expired-after-accept",
        environment: "isolated_test",
        allowedOrigins: ["https://shop.example.test"],
        allowedActionKinds: ["click"],
        maximumRisk: "Normal",
        explorationAllowed: false,
        issuedAt: "2026-08-23T00:00:00.000Z",
        expiresAt: "2026-08-23T00:01:00.000Z",
      },
    });
    const row = dispatch({ job: expiredJob });
    repository.rows = [row];
    const leases = new LeaseReaderFake();
    leases.leaseRecord = { job: row.job, owner: { runnerId: "runner-1" } };
    const { loop, runners } = makeLoop({ repository, leases });
    let offered = false;
    runners.connection = connection({ offer: async (job) => { offered = true; return leaseFor(job); } });

    const result = await loop.runOnce();

    expect(result.results[0]).toMatchObject({ outcome: "accepted", receipt: { status: "already_active", jobId: "runner-job-1", runId: "run-1", acceptedAt: row.createdAt } });
    expect(repository.blockCalls).toHaveLength(0);
    expect(offered).toBe(false);
  });

  it("reconciles a persisted lease after an uncertain offer failure before applying retry backoff", async () => {
    const repository = new MissionDispatchRepositoryFake();
    const row = dispatch();
    repository.rows = [row];
    const leases = new LeaseReaderFake();
    const { loop, runners } = makeLoop({ repository, leases });
    let attempts = 0;
    runners.connection = connection({
      offer: async (job) => {
        attempts += 1;
        leases.leaseRecord = { job, owner: { runnerId: "runner-1" } };
        throw Object.assign(new Error("stream closed after accept commit"), { code: "SessionClosed" });
      },
    });

    const result = await loop.runOnce();

    expect(attempts).toBe(1);
    expect(result.results[0]).toMatchObject({ outcome: "accepted", receipt: { status: "already_active", jobId: "runner-job-1", runId: "run-1", acceptedAt: row.createdAt } });
    expect(repository.acceptCalls).toHaveLength(1);
  });

  it("returns the repository CAS receipt as canonical for duplicate dispatch", async () => {
    const repository = new class extends MissionDispatchRepositoryFake {
      override async markDispatchAccepted(attemptId: string, receipt: MissionDispatchAcceptanceReceipt, expectedVersion: number): Promise<AcceptedMissionDispatch> {
        await super.markDispatchAccepted(attemptId, receipt, expectedVersion);
        const current = this.rows[0]!;
        const canonical = { status: "already_active", jobId: current.runnerJobId, runId: current.runId, acceptedAt: current.createdAt } as const;
        return { ...current, status: "accepted", version: expectedVersion + 1, acceptedAt: canonical.acceptedAt, receipt: canonical };
      }
    }();
    repository.rows = [dispatch()];
    const { loop, runners } = makeLoop({ repository });
    runners.connection = connection();

    const result = await loop.runOnce();

    expect(result.results[0]).toMatchObject({ outcome: "accepted", receipt: { status: "already_active", jobId: "runner-job-1", runId: "run-1", acceptedAt: "2026-08-23T12:00:00.000Z" } });
  });

  it("lets one concurrent dispatcher durably block and makes the loser observe non-dispatchable state", async () => {
    const repository = new BlockingBarrierRepositoryFake();
    repository.rows = [dispatch({ requiredCapabilities: [...WEB_GRAPH_V1_REQUIREMENTS, "model:vision-input"] })];
    repository.holdWrites();
    const runners = new RunnerDirectoryFake();
    runners.connection = connection({
      authenticatedRunner: { runnerId: "runner-1", scope: { kind: "tenant", tenantId: "tenant-1", projectIds: ["project-1"] }, capabilities: [WEB_TARGET_TOKEN] },
    });
    const first = makeLoop({ repository, runners }).loop.runOnce();
    const second = makeLoop({ repository, runners }).loop.runOnce();
    await repository.waitForBlockedCallers(2);
    repository.release();

    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.blocked)).toEqual([1, 1]);
    expect(results.flatMap((result) => result.results).every((result) => result.outcome === "blocked")).toBe(true);
    expect(repository.rows[0]?.status).toBe("blocked");
    expect(await repository.pendingDispatches(1)).toEqual([]);
  });

  it("keeps deterministic rejects pending when durable block persistence fails", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.rows = [dispatch({ requiredCapabilities: [...WEB_GRAPH_V1_REQUIREMENTS, "model:vision-input"] })];
    repository.failBlock = true;
    const { loop, runners } = makeLoop({ repository });
    runners.connection = connection({
      authenticatedRunner: { runnerId: "runner-1", scope: { kind: "tenant", tenantId: "tenant-1", projectIds: ["project-1"] }, capabilities: [WEB_TARGET_TOKEN] },
    });

    await expect(loop.runOnce()).resolves.toMatchObject({ pending: 1, results: [{ outcome: "pending", reason: "block_persistence_failed" }] });
    expect(repository.rows[0]?.status).toBe("pending");
    expect(repository.acceptCalls).toHaveLength(0);
  });

  it("does not report success when terminal acceptance persistence fails after a lease is granted", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.rows = [dispatch()];
    repository.failAccept = true;
    const { loop, runners, leases } = makeLoop({ repository });
    runners.connection = connection({
      offer: async (job) => {
        leases.leaseRecord = { job, owner: { runnerId: "runner-1" } };
        return leaseFor(job);
      },
    });

    const result = await loop.runOnce();

    expect(result.results).toEqual([{ outcome: "pending", attemptId: "attempt-1", runnerId: "runner-1", reason: "acceptance_persistence_failed", retryAfterMs: 100 }]);
    expect(repository.rows[0]?.status).toBe("pending");
  });
});

describe("Mission dispatch durable blocking", () => {
  it("persists blocked dispatches across restart and omits them from pending", async () => {
    const harness = await openSqliteMissionHarness("block-restart");
    try {
      await seedMission(harness.runtime, "block-restart");
      await startMission(harness.store, "block-restart", ids("block-restart"));
      const pending = (await harness.store.pendingDispatches(1))[0]!;

      const blocked = await harness.store.markDispatchBlocked(pending.attemptId, pending.version);
      expect(blocked).toMatchObject({ status: "blocked", version: 2, attemptId: pending.attemptId });
      await expect(harness.store.pendingDispatches(1)).resolves.toEqual([]);

      await harness.runtime.close();
      const reopened = await SqliteRuntime.open({ filename: harness.database, busyTimeoutMs: 5_000 });
      const reopenedStore = new SqlitePrdMissionStore(reopened);
      try {
        await expect(reopenedStore.pendingDispatches(1)).resolves.toEqual([]);
        await expect(reopenedStore.markDispatchBlocked(pending.attemptId, pending.version)).resolves.toEqual(blocked);
      } finally {
        await reopened.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("rolls back a terminal block when attempt persistence fails", async () => {
    const harness = await openSqliteMissionHarness("block-rollback");
    try {
      await seedMission(harness.runtime, "block-rollback");
      await startMission(harness.store, "block-rollback", ids("block-rollback"));
      const pending = (await harness.store.pendingDispatches(1))[0]!;
      const failing = new SqlitePrdMissionStore(harness.runtime, 2);

      await expect(failing.markDispatchBlocked(pending.attemptId, pending.version)).rejects.toThrow("InjectedFailureAfterWrite:2");
      await expect(harness.store.pendingDispatches(1)).resolves.toEqual([pending]);
    } finally {
      await harness.close();
    }
  });

  it("prevents conflicting accepted and blocked terminal dispatch decisions", async () => {
    const harness = await openSqliteMissionHarness("block-conflict");
    try {
      await seedMission(harness.runtime, "block-conflict");
      await startMission(harness.store, "block-conflict", ids("block-conflict"));
      const pending = (await harness.store.pendingDispatches(1))[0]!;
      const accepted = await harness.store.markDispatchAccepted(pending.attemptId, receiptFor(pending, "accepted"), pending.version);

      await expect(harness.store.markDispatchBlocked(pending.attemptId, pending.version)).rejects.toMatchObject({ code: "MissionDispatchVersionConflict", actualVersion: accepted.version });
      await expect(harness.store.markDispatchAccepted(pending.attemptId, accepted.receipt, pending.version)).resolves.toEqual(accepted);
    } finally {
      await harness.close();
    }
  });
});

async function openSqliteMissionHarness(name: string): Promise<{ readonly database: string; readonly runtime: SqliteRuntime; readonly store: SqlitePrdMissionStore; close(): Promise<void> }> {
  const directory = await mkdtemp(join(process.cwd(), `.tmp-ticket-05-${name}-`));
  const database = join(directory, "qualigence.db");
  const runtime = await SqliteRuntime.open({ filename: database, busyTimeoutMs: 5_000 });
  return {
    database,
    runtime,
    store: new SqlitePrdMissionStore(runtime),
    close: async () => {
      await runtime.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function ids(suffix: string): MissionSchedulingIds {
  return { allocateAttemptId: () => `attempt-${suffix}`, allocateRunnerJobId: () => `runner-job-${suffix}`, allocateRunId: () => `run-${suffix}` };
}

function startMission(store: SqlitePrdMissionStore, name: string, allocated: MissionSchedulingIds) {
  return new MissionSchedulingService(store, allocated, { now: () => "2026-08-22T00:00:00.000Z" }).start({
    missionId: schedulingFixture(name).missionId,
    expectedVersion: 1,
    idempotencyKey: `start-${name}`,
  });
}

async function seedMission(runtime: SqliteRuntime, name: string): Promise<void> {
  const fixture = schedulingFixture(name);
  const plan = JSON.parse(fixture.planJson) as { projectId: string; prdId: string; prdRevision: number };
  const compiled = JSON.parse(fixture.compiledJson) as { projectId: string; targetId: string };
  const dispatch = JSON.parse(fixture.dispatchJson) as { binding: { runnerId: string; configuration: { kind: string } } };
  await runtime.db.insertInto("project_targets").values({ target_id: fixture.targetId, project_id: compiled.projectId, current_version: 1, created_at: "2026-08-22T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z" }).execute();
  await runtime.db.insertInto("target_revisions").values({ target_id: fixture.targetId, version: 1, project_id: compiled.projectId, display_name: "Target", runner_id: dispatch.binding.runnerId, kind: dispatch.binding.configuration.kind, snapshot_hash: `target-hash-${name}`, configuration_json: JSON.stringify(dispatch.binding.configuration), idempotency_key: `target-${name}`, created_at: "2026-08-22T00:00:00.000Z" }).execute();
  await runtime.db.insertInto("test_plan_heads").values({ plan_id: fixture.planId, project_id: plan.projectId, current_version: 2, created_at: "2026-08-22T00:00:00.000Z", updated_at: "2026-08-22T00:00:00.000Z" }).execute();
  await runtime.db.insertInto("test_plan_version_revisions").values({ plan_id: fixture.planId, version: 2, project_id: plan.projectId, prd_id: plan.prdId, prd_revision: plan.prdRevision, status: "approved", reviewer_id: "reviewer-1", approved_at: "2026-08-22T00:00:00.000Z", idempotency_key: `approve-${name}`, plan_json: fixture.planJson, created_at: "2026-08-22T00:00:00.000Z" }).execute();
  await runtime.db.insertInto("missions").values({ mission_id: fixture.missionId, revision: 1, project_id: compiled.projectId, plan_id: fixture.planId, prd_id: plan.prdId, prd_revision: plan.prdRevision, target_id: fixture.targetId, compiled_hash: fixture.compiledHash, status: "approved", dispatch_json: fixture.dispatchJson, stop_on_blocked: 1 }).execute();
  await runtime.db.insertInto("mission_scheduling_heads").values({ mission_id: fixture.missionId, mission_revision: 1, version: 1, compiled_hash: fixture.compiledHash }).execute();
  await runtime.db.insertInto("mission_revisions").values({ mission_id: fixture.missionId, revision: 1, compiled_json: fixture.compiledJson, created_at: "2026-08-22T00:00:00.000Z" }).execute();
  const snapshot = JSON.parse(fixture.jobSnapshotJson) as { id: string; objective: string };
  await runtime.db.insertInto("execution_jobs").values({ job_id: fixture.logicalJobId, mission_id: fixture.missionId, mission_revision: 1, test_case_id: snapshot.id, objective: snapshot.objective, required_capabilities_json: fixture.requiredCapabilitiesJson, source_refs_json: fixture.sourceRefsJson, snapshot_hash: fixture.jobSnapshotHash, snapshot_json: fixture.jobSnapshotJson, idempotency_key: `logical-${name}`, status: "queued" }).execute();
}

function receiptFor(pending: PendingMissionDispatch, status: MissionDispatchAcceptanceReceipt["status"]): MissionDispatchAcceptanceReceipt {
  return { status, jobId: pending.runnerJobId, runId: pending.runId, acceptedAt: "2026-08-22T00:00:01.000Z" };
}
