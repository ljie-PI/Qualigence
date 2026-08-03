import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresIntelligenceQueue } from "@qualigence/core-application";
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
    });
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

  it("re-leases a job after the holding worker crashes (connection lost)", async () => {
    const { job } = buildJobPair({
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
      now: now(),
      leaseDurationMs: 60_000,
    });
    expect(leased?.job.jobId).toBe("job-lease-2");

    // Simulate a crash: dropping the pool releases the held row lock.
    await crashing.close();

    const recovered = queue();
    try {
      const released = await recovered.lease({
        workerId: "worker-b",
        acceptedTypes,
        now: now(),
        leaseDurationMs: 60_000,
      });
      expect(released?.job.jobId).toBe("job-lease-2");
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
