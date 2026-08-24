import { describe, expect, it } from "vitest";
import type {
  AcceptedMissionDispatch,
  MissionDispatchAcceptanceReceipt,
  PendingMissionDispatch,
  PrdMissionRepository,
} from "@qualigence/mission";
import type { AcceptedExecutionJob, ExecutionJobLease } from "@qualigence/runner-protocol";
import { MissionDispatchLoop, type MissionDispatchLeaseReader, type MissionDispatchRunnerConnection } from "../../../apps/server/src/mission-dispatch-loop.js";
import { WEB_TARGET_TOKEN, webJob } from "../../helpers/core-runner-harness.js";

const clock = { now: () => "2026-08-24T00:00:00.000Z" };

function dispatch(overrides: Partial<PendingMissionDispatch> = {}): PendingMissionDispatch {
  const job = (overrides.job ?? webJob({ jobId: "runner-job-1", runId: "run-1", projectId: "project-1" })) as PendingMissionDispatch["job"];
  return {
    attemptId: "attempt-1",
    missionId: "mission-1",
    runnerId: "runner-1",
    runnerJobId: job.jobId,
    runId: job.runId,
    requiredCapabilities: [WEB_TARGET_TOKEN],
    job,
    status: "pending",
    version: 1,
    createdAt: "2026-08-23T12:00:00.000Z",
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

class MissionDispatchRepositoryFake implements Pick<PrdMissionRepository, "pendingDispatches" | "markDispatchAccepted"> {
  readonly acceptCalls: Array<{ readonly attemptId: string; readonly receipt: MissionDispatchAcceptanceReceipt; readonly expectedVersion: number }> = [];
  pendingRows: PendingMissionDispatch[] = [];

  async pendingDispatches(_limit: number): Promise<readonly PendingMissionDispatch[]> {
    return [...this.pendingRows];
  }

  async markDispatchAccepted(
    attemptId: string,
    receipt: MissionDispatchAcceptanceReceipt,
    expectedVersion: number,
  ): Promise<AcceptedMissionDispatch> {
    this.acceptCalls.push({ attemptId, receipt, expectedVersion });
    const current = this.pendingRows.find((row) => row.attemptId === attemptId);
    if (current === undefined) throw new Error("missing dispatch");
    return { ...current, status: "accepted", version: expectedVersion + 1, acceptedAt: receipt.acceptedAt, receipt };
  }
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
      capabilities: [WEB_TARGET_TOKEN],
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
    repository.pendingRows = [row];
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
    expect(offered).toEqual([{ job: row.job, requirements: [WEB_TARGET_TOKEN] }]);
    expect(repository.acceptCalls).toEqual([{ attemptId: "attempt-1", expectedVersion: 1, receipt: { status: "accepted", jobId: "runner-job-1", runId: "run-1", acceptedAt: row.createdAt } }]);
    expect(result).toMatchObject({ totalPending: 1, attempted: 1, accepted: 1, pending: 0, blocked: 0 });
    expect(result.results[0]).toMatchObject({ outcome: "accepted", receipt: { status: "accepted", jobId: "runner-job-1", runId: "run-1", acceptedAt: row.createdAt } });
  });

  it("leaves an offline bound Runner pending with bounded loop-local backoff", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.pendingRows = [dispatch()];
    const { loop } = makeLoop({ repository, initialBackoffMs: 100, maximumBackoffMs: 150 });

    const first = await loop.runOnce();
    const second = await loop.runOnce();

    expect(first.results).toEqual([{ outcome: "pending", attemptId: "attempt-1", runnerId: "runner-1", reason: "runner_offline", retryAfterMs: 100 }]);
    expect(second.results).toEqual([{ outcome: "pending", attemptId: "attempt-1", runnerId: "runner-1", reason: "backing_off", retryAfterMs: 100 }]);
    expect(repository.acceptCalls).toHaveLength(0);
    expect(repository.pendingRows[0]?.status).toBe("pending");
  });

  it("blocks capability mismatch explicitly without selecting another Runner", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.pendingRows = [dispatch({ requiredCapabilities: [WEB_TARGET_TOKEN, "model:vision-input"] })];
    const { loop, runners } = makeLoop({ repository });
    const offered: AcceptedExecutionJob[] = [];
    runners.connection = connection({
      authenticatedRunner: {
        runnerId: "runner-1",
        scope: { kind: "tenant", tenantId: "tenant-1", projectIds: ["project-1"] },
        capabilities: [WEB_TARGET_TOKEN],
      },
      offer: async (job) => {
        offered.push(job);
        return leaseFor(job);
      },
    });

    const result = await loop.runOnce();

    expect(result.results).toEqual([{ outcome: "blocked", attemptId: "attempt-1", runnerId: "runner-1", reason: "capability_mismatch", retryAfterMs: 100, details: { missingCapabilities: ["model:vision-input"] } }]);
    expect(offered).toEqual([]);
    expect(runners.lookups).toEqual([{ tenantId: "tenant-1", runnerId: "runner-1" }]);
    expect(repository.acceptCalls).toHaveLength(0);
  });

  it("blocks tenant/project scope mismatches before exposing the Job payload", async () => {
    const repository = new MissionDispatchRepositoryFake();
    repository.pendingRows = [dispatch()];
    const { loop, runners } = makeLoop({ repository });
    let offered = false;
    runners.connection = connection({
      authenticatedRunner: {
        runnerId: "runner-1",
        scope: { kind: "tenant", tenantId: "tenant-2", projectIds: ["project-1"] },
        capabilities: [WEB_TARGET_TOKEN],
      },
      offer: async (job) => {
        offered = true;
        return leaseFor(job);
      },
    });

    await expect(loop.runOnce()).resolves.toMatchObject({ blocked: 1, results: [{ outcome: "blocked", reason: "tenant_scope_mismatch" }] });
    expect(offered).toBe(false);
    expect(repository.acceptCalls).toHaveLength(0);
  });

  it("reconciles an existing lease to the canonical already_active receipt instead of minting a second lease", async () => {
    const repository = new MissionDispatchRepositoryFake();
    const row = dispatch();
    repository.pendingRows = [row];
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

  it("reconciles a persisted lease after an uncertain offer failure before applying retry backoff", async () => {
    const repository = new MissionDispatchRepositoryFake();
    const row = dispatch();
    repository.pendingRows = [row];
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
        const current = this.pendingRows[0]!;
        const canonical = { status: "already_active", jobId: current.runnerJobId, runId: current.runId, acceptedAt: current.createdAt } as const;
        return { ...current, status: "accepted", version: expectedVersion + 1, acceptedAt: canonical.acceptedAt, receipt: canonical };
      }
    }();
    repository.pendingRows = [dispatch()];
    const { loop, runners } = makeLoop({ repository });
    runners.connection = connection();

    const result = await loop.runOnce();

    expect(result.results[0]).toMatchObject({ outcome: "accepted", receipt: { status: "already_active", jobId: "runner-job-1", runId: "run-1", acceptedAt: "2026-08-23T12:00:00.000Z" } });
  });
});
