import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ServerIntelligenceResultConsumer } from "@qualigence/core-application";
import { WorkerLoop, type JobProcessor } from "@qualigence/intelligence-worker";
import {
  acquirePostgresOperationLock,
  createPostgresRuntime,
  PostgresIntelligenceQueue,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { buildJobPair, readCaseVersion, seedInvestigationCase, seedJob } from "../../helpers/intelligence-fixtures.js";
import { setupPostgresFixture, type PostgresFixture } from "../../helpers/postgres-fixture.js";

const { Client } = pg;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Self-hosted Intelligence Worker lease acceptance", () => {
  let fixture: PostgresFixture;
  let provider: TenantTransactionProvider;

  beforeAll(async () => {
    if (!dockerAvailable()) {
      throw new Error("DockerUnavailable: PostgreSQL is required for Intelligence Worker lease acceptance");
    }
    fixture = await setupPostgresFixture();
    provider = createPostgresRuntime(fixture.serverConfig);
  }, 180_000);

  afterAll(async () => {
    await provider?.close();
    await fixture?.stop();
  });

  function queue(): PostgresIntelligenceQueue {
    return new PostgresIntelligenceQueue(fixture.workerConfig, acquirePostgresOperationLock);
  }

  it("proves lease, renewal, restart fencing, and forced-RLS through the real Worker/PostgreSQL path", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-e2e-intel",
      caseId: "case-e2e-intel",
      jobId: "job-e2e-intel",
      baseAggregateVersion: 0,
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: job.tenantId,
      caseId: "case-e2e-intel",
      version: 0,
    });
    await seedJob(fixture.adminConfig, job);

    const worker = queue();
    const processor: JobProcessor = {
      process: async (leased, signal) => {
        expect(signal?.aborted ?? false).toBe(false);
        expect(leased.jobId).toBe(job.jobId);
        await delay(500);
        return result;
      },
    };
    try {
      const errors: unknown[] = [];
      const loop = new WorkerLoop({
        store: worker,
        inbox: worker,
        processor,
        workerId: "worker-e2e-a",
        acceptedTypes: ["investigation.reproduction-planning"],
        leaseDurationMs: 1_000,
        idleBackoffMs: 5,
        onError: (error) => { errors.push(error); },
      });
      const outcome = await loop.runOnce();
      expect(errors).toEqual([]);
      expect(outcome).toBe("processed");
    } finally {
      await worker.close();
    }

    const admin = new Client(fixture.adminConfig);
    await admin.connect();
    try {
      const leaseRows = await admin.query(
        `select worker_id, attempt, renewal_count, released_at, completed_at
           from intelligence_leases
          where tenant_id = $1 and job_id = $2`,
        [job.tenantId, job.jobId],
      );
      expect(leaseRows.rows).toEqual([
        expect.objectContaining({
          worker_id: "worker-e2e-a",
          attempt: 1,
          released_at: null,
        }),
      ]);
      expect(leaseRows.rows[0].renewal_count).toBeGreaterThan(0);
      expect(leaseRows.rows[0].completed_at).toEqual(expect.any(String));

      const inboxRows = await admin.query(
        `select tenant_id, job_id, worker_id, lease_attempt
           from intelligence_result_inbox
          where tenant_id = $1 and idempotency_key = $2`,
        [job.tenantId, result.idempotencyKey],
      );
      expect(inboxRows.rows).toEqual([
        expect.objectContaining({
          tenant_id: job.tenantId,
          job_id: job.jobId,
          worker_id: "worker-e2e-a",
          lease_attempt: 1,
        }),
      ]);
    } finally {
      await admin.end();
    }

    const consumer = new ServerIntelligenceResultConsumer(provider);
    await expect(consumer.consumeForTenant(job.tenantId)).resolves.toMatchObject({ applied: 1 });
    await expect(readCaseVersion(fixture.adminConfig, "case-e2e-intel")).resolves.toBe(1);

    const { job: restartJob } = buildJobPair({
      tenantId: "tenant-e2e-restart",
      caseId: "case-e2e-restart",
      jobId: "job-e2e-restart",
      baseAggregateVersion: 0,
      jobType: "investigation.bug-analysis",
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: restartJob.tenantId,
      caseId: "case-e2e-restart",
      version: 0,
    });
    await seedJob(fixture.adminConfig, restartJob);

    const owner = queue();
    const contender = queue();
    try {
      const owned = await owner.lease({
        workerId: "worker-e2e-owner",
        acceptedTypes: ["investigation.bug-analysis"],
        now: "1900-01-01T00:00:00.000Z",
        leaseDurationMs: 60_000,
      });
      expect(owned?.job.jobId).toBe(restartJob.jobId);
      await expect(contender.lease({
        workerId: "worker-e2e-contender",
        acceptedTypes: ["investigation.bug-analysis"],
        now: new Date().toISOString(),
        leaseDurationMs: 60_000,
      })).resolves.toBeUndefined();
      await expect(contender.abandon({
        tenantId: restartJob.tenantId,
        jobId: restartJob.jobId,
        workerId: "worker-e2e-owner",
        leaseAttempt: owned!.lease.attempt,
        leaseToken: "forged-token",
      })).resolves.toEqual({ disposition: "not-active" });
      await expect(owner.abandon({
        tenantId: restartJob.tenantId,
        jobId: restartJob.jobId,
        workerId: "worker-e2e-owner",
        leaseAttempt: owned!.lease.attempt,
        leaseToken: owned!.lease.leaseToken,
      })).resolves.toEqual({ disposition: "released" });
      const reowned = await contender.lease({
        workerId: "worker-e2e-contender",
        acceptedTypes: ["investigation.bug-analysis"],
        now: new Date().toISOString(),
        leaseDurationMs: 60_000,
      });
      expect(reowned?.job.jobId).toBe(restartJob.jobId);
      expect(reowned?.lease.attempt).toBe(2);
    } finally {
      await owner.close();
      await contender.close();
    }

    const workerClient = new Client(fixture.workerConfig);
    await workerClient.connect();
    try {
      await expect(workerClient.query("select * from investigation_cases")).rejects.toMatchObject({ code: "42501" });
      await expect(workerClient.query("select * from intelligence_jobs")).rejects.toMatchObject({ code: "42501" });
      await expect(workerClient.query("select * from intelligence_result_inbox")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await workerClient.end();
    }
  }, 180_000);
});
