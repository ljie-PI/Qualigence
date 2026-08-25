import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  acquirePostgresOperationLock,
  PostgresIntelligenceQueue,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupPostgresFixture, type PostgresFixture } from "../../helpers/postgres-fixture.js";
import { buildJobPair, seedInvestigationCase, seedJob } from "../../helpers/intelligence-fixtures.js";

const { Client } = pg;
const skip = !dockerAvailable();
const describeMaybe = skip ? describe.skip : describe;

describeMaybe("Intelligence Worker lease and recovery", () => {
  let fixture: PostgresFixture;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
  }, 180_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  function queue(): PostgresIntelligenceQueue {
    return new PostgresIntelligenceQueue({
      host: fixture.workerConfig.host,
      port: fixture.workerConfig.port,
      database: fixture.workerConfig.database,
      user: fixture.workerConfig.user,
      password: fixture.workerConfig.password,
    }, acquirePostgresOperationLock);
  }

  const now = () => new Date().toISOString();
  const acceptedTypes = ["investigation.reproduction-planning"] as const;

  it("never leases the same job to two workers simultaneously", async () => {
    const { job } = buildJobPair({
      tenantId: "tenant-a",
      caseId: "case-lease-1",
      jobId: "job-lease-1",
      baseAggregateVersion: 0,
      jobType: "prd.planning",
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-a",
      caseId: "case-lease-1",
      version: 0,
    });
    await seedJob(fixture.adminConfig, job);

    const q = queue();
    try {
      const [a, b] = await Promise.all([
        q.lease({ workerId: "worker-a", acceptedTypes: ["prd.planning"], now: now(), leaseDurationMs: 60_000 }),
        q.lease({ workerId: "worker-b", acceptedTypes: ["prd.planning"], now: now(), leaseDurationMs: 60_000 }),
      ]);
      expect([a, b].filter((lease) => lease !== undefined)).toHaveLength(1);
    } finally {
      await q.close();
    }
  });

  it("persists lease ownership and re-leases a job only after expiry", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-a",
      caseId: "case-lease-2",
      jobId: "job-lease-2",
      baseAggregateVersion: 0,
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-a",
      caseId: "case-lease-2",
      version: 0,
    });
    await seedJob(fixture.adminConfig, job);

    const crashing = queue();
    const leased = await crashing.lease({
      workerId: "worker-a",
      acceptedTypes,
      now: "2026-08-25T00:00:00.000Z",
      leaseDurationMs: 60_000,
    });
    expect(leased?.job.jobId).toBe("job-lease-2");
    expect(leased?.lease.attempt).toBe(1);

    const admin = new Client(fixture.adminConfig);
    await admin.connect();
    try {
      const leaseRows = await admin.query(
        `select worker_id, attempt, lease_token_hash, expires_at, renewal_count, released_at, completed_at
           from intelligence_leases
          where tenant_id = 'tenant-a' and job_id = 'job-lease-2'`,
      );
      expect(leaseRows.rows).toHaveLength(1);
      expect(leaseRows.rows[0]).toMatchObject({
        worker_id: "worker-a",
        attempt: 1,
        expires_at: "2026-08-25T00:01:00.000Z",
        renewal_count: 0,
        released_at: null,
        completed_at: null,
      });
      expect(leaseRows.rows[0].lease_token_hash).not.toBe(leased?.lease.leaseToken);
    } finally {
      await admin.end();
    }

    // Simulate a crash: the durable lease remains authoritative until expiry.
    await crashing.close();

    const blocked = queue();
    try {
      const stillHeld = await blocked.lease({
        workerId: "worker-b",
        acceptedTypes,
        now: "2026-08-25T00:00:30.000Z",
        leaseDurationMs: 60_000,
      });
      expect(stillHeld).toBeUndefined();
    } finally {
      await blocked.close();
    }

    const recovered = queue();
    try {
      const released = await recovered.lease({
        workerId: "worker-b",
        acceptedTypes,
        now: "2026-08-25T00:01:01.000Z",
        leaseDurationMs: 60_000,
      });
      expect(released?.job.jobId).toBe("job-lease-2");
      expect(released?.lease.attempt).toBe(2);
      await expect(
        recovered.abandon({
          tenantId: "tenant-a",
          jobId: job.jobId,
          leaseToken: leased!.lease.leaseToken,
          leaseAttempt: leased!.lease.attempt,
          workerId: "worker-a",
        }),
      ).resolves.toEqual({ disposition: "not-active" });
      await expect(
        recovered.lease({
          workerId: "worker-c",
          acceptedTypes,
          now: "2026-08-25T00:01:30.000Z",
          leaseDurationMs: 60_000,
        }),
      ).resolves.toBeUndefined();
      await expect(
        recovered.append({
          tenantId: "tenant-a",
          jobId: job.jobId,
          leaseToken: leased!.lease.leaseToken,
          leaseAttempt: leased!.lease.attempt,
          workerId: "worker-a",
          baseAggregateVersion: 0,
          result,
        }),
      ).rejects.toMatchObject({ code: "LeaseNotActive" });
    } finally {
      await recovered.close();
    }
  });

  it("never leases an ExecutionJob as an Intelligence Job", async () => {
    // An unrelated ExecutionJob exists, but the lease query only reads
    // intelligence_jobs, so it is invisible. With no intelligence jobs pending
    // of the accepted type, the lease returns undefined.
    const q = queue();
    try {
      const leased = await q.lease({
        workerId: "worker-a",
        acceptedTypes: ["skill.induction"],
        now: now(),
        leaseDurationMs: 60_000,
      });
      expect(leased).toBeUndefined();
    } finally {
      await q.close();
    }
  });

  it("denies the worker role any access to aggregate/run tables (42501)", async () => {
    const client = new Client({
      host: fixture.workerConfig.host,
      port: fixture.workerConfig.port,
      database: fixture.workerConfig.database,
      user: fixture.workerConfig.user,
      password: fixture.workerConfig.password,
    });
    await client.connect();
    try {
      await expect(client.query("select * from execution_runs")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(client.query("select * from investigation_cases")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await client.end();
    }
  });
});
