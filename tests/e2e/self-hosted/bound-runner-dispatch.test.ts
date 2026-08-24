import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AcceptedMissionExecutionJob, PendingMissionDispatch } from "@qualigence/mission";
import { startCoreDaemon } from "@qualigence/core-daemon";
import { MissionDispatchLoop, type MissionDispatchRunnerConnection } from "../../../apps/server/src/mission-dispatch-loop.js";
import { createGrpcTestPki, type GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { makeHello, makeTestClient } from "../../helpers/grpc-harness.js";
import { UNSUPPORTED_TOKEN, WEB_TARGET_TOKEN, webJob } from "../../helpers/core-runner-harness.js";

let pki: GrpcTestPki;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  pki = createGrpcTestPki();
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("Self-hosted bound Runner dispatch acceptance", () => {
  it("offers work only to the exact authenticated bound Runner", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qualigence-e2e-bound-runner-"));
    const daemon = await startCoreDaemon({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      leaseDurationMs: 30_000,
      tls: { ca: pki.ca, cert: pki.server.cert, key: pki.server.key },
    });
    const client = makeTestClient(pki, daemon.port, pki.clientFor("runner-bound"));
    cleanups.push(async () => {
      await client.close();
      await daemon.shutdown();
      await rm(dataDir, { recursive: true, force: true });
    });
    const session = await client.connect(makeHello("runner-bound"));
    const connection = await daemon.server.waitForConnection("runner-bound");
    const row = dispatch({ runnerId: "runner-bound" });
    const accepted: unknown[] = [];
    const loop = new MissionDispatchLoop({
      tenantId: "tenant-a",
      repository: {
        pendingDispatches: async () => [row],
        markDispatchAccepted: async (attemptId, receipt, expectedVersion) => {
          accepted.push({ attemptId, receipt, expectedVersion });
          return { ...row, status: "accepted", version: expectedVersion + 1, acceptedAt: receipt.acceptedAt, receipt };
        },
        markDispatchBlocked: async () => { throw new Error("unexpected block"); },
      },
      runners: {
        connectionFor: ({ tenantId, runnerId }) => {
          expect({ tenantId, runnerId }).toEqual({ tenantId: "tenant-a", runnerId: "runner-bound" });
          return {
            authenticatedRunner: { runnerId: "runner-bound", scope: { kind: "tenant", tenantId: "tenant-a", projectIds: ["project-test"] }, capabilities: connection.authenticatedRunner.capabilities },
            offer: (job, requirements) => connection.offer(job, requirements),
          } satisfies MissionDispatchRunnerConnection;
        },
      },
      leases: { lease: async () => undefined },
      clock: { now: () => "2026-08-24T00:00:01.000Z" },
    });

    const running = loop.runOnce();
    const offer = await session.nextOffer(new AbortController().signal);
    expect(offer.job).toEqual(row.job);
    const lease = await session.accept(offer.offerId);

    await expect(running).resolves.toMatchObject({ accepted: 1, pending: 0, blocked: 0 });
    expect(lease).toMatchObject({ runId: row.runId, jobId: row.runnerJobId });
    expect(accepted).toEqual([{ attemptId: row.attemptId, expectedVersion: 1, receipt: { status: "accepted", jobId: row.runnerJobId, runId: row.runId, acceptedAt: row.createdAt } }]);
  }, 60_000);

  it("leaves an offline bound Runner durably pending", async () => {
    const row = dispatch();
    const loop = new MissionDispatchLoop({
      tenantId: "tenant-a",
      repository: repositoryFor(row),
      runners: { connectionFor: async () => undefined },
      leases: { lease: async () => undefined },
      clock: { now: () => "2026-08-24T00:00:01.000Z" },
    });

    await expect(loop.runOnce()).resolves.toMatchObject({ pending: 1, blocked: 0, accepted: 0, results: [{ outcome: "pending", reason: "runner_offline" }] });
    await expect(loop.runOnce()).resolves.toMatchObject({ pending: 1, results: [{ outcome: "pending", reason: "backing_off" }] });
  });

  it("durably blocks a capability-mismatched bound Runner without selecting another Runner", async () => {
    const row = dispatch({ requiredCapabilities: [WEB_TARGET_TOKEN, UNSUPPORTED_TOKEN] });
    const blocked: string[] = [];
    const loop = new MissionDispatchLoop({
      tenantId: "tenant-a",
      repository: repositoryFor(row, blocked),
      runners: { connectionFor: async () => connectionFor(row, [WEB_TARGET_TOKEN]) },
      leases: { lease: async () => undefined },
      clock: { now: () => "2026-08-24T00:00:01.000Z" },
    });

    await expect(loop.runOnce()).resolves.toMatchObject({ pending: 0, blocked: 1, accepted: 0, results: [{ outcome: "blocked", reason: "capability_mismatch" }] });
    expect(blocked).toEqual([row.attemptId]);
  });
});

function dispatch(overrides: Partial<PendingMissionDispatch> = {}): PendingMissionDispatch {
  const job = webJob({
    jobId: "runner-job-bound",
    runId: "run-bound",
    policy: { ...webJob().policy, issuedAt: "2026-08-24T00:00:00.000Z", expiresAt: "2026-08-24T00:01:00.000Z" },
    plan: {
      missionId: "mission-bound",
      missionRevision: 1,
      testCaseId: "case-bound",
      steps: [{ kind: "click", target: { role: "button", name: "Add to cart", purpose: "add item" } }],
      expectedClaimIds: ["claim-bound"],
      budget: { maximumStepsPerJob: 1, maximumWallClockMs: 60_000, maximumModelTokens: 1_000 },
    },
  }) as AcceptedMissionExecutionJob;
  return {
    attemptId: "attempt-bound",
    missionId: "mission-bound",
    runnerId: "runner-bound",
    runnerJobId: job.jobId,
    runId: job.runId,
    requiredCapabilities: [WEB_TARGET_TOKEN],
    job,
    status: "pending",
    version: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

function repositoryFor(row: PendingMissionDispatch, blocked: string[] = []) {
  return {
    pendingDispatches: async () => [row],
    markDispatchAccepted: async () => { throw new Error("unexpected accept"); },
    markDispatchBlocked: async (attemptId: string, expectedVersion: number) => {
      blocked.push(attemptId);
      return { ...row, status: "blocked" as const, version: expectedVersion + 1, blockedAt: row.createdAt };
    },
  };
}

function connectionFor(row: PendingMissionDispatch, capabilities: readonly string[]): MissionDispatchRunnerConnection {
  return {
    authenticatedRunner: { runnerId: row.runnerId, scope: { kind: "tenant", tenantId: "tenant-a", projectIds: [row.job.projectId] }, capabilities },
    offer: async () => { throw new Error("capability mismatch must block before offer"); },
  };
}
