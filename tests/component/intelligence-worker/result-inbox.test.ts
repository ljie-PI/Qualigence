import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresIntelligenceQueue,
  ServerIntelligenceResultConsumer,
} from "@qualigence/core-application";
import {
  createPostgresRuntime,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupPostgresFixture, type PostgresFixture } from "../../helpers/postgres-fixture.js";
import {
  buildJobPair,
  readCaseVersion,
  seedInvestigationCase,
  seedJob,
} from "../../helpers/intelligence-fixtures.js";

const skip = !dockerAvailable();
const describeMaybe = skip ? describe.skip : describe;

describeMaybe("Intelligence Worker result inbox and server-only apply", () => {
  let fixture: PostgresFixture;
  let provider: TenantTransactionProvider;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
    provider = createPostgresRuntime(fixture.serverConfig);
  }, 180_000);

  afterAll(async () => {
    await provider?.close();
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

  it("leases a job, appends its result once, and the server applies it exactly once", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-a",
      caseId: "case-inbox-1",
      jobId: "job-inbox-1",
      baseAggregateVersion: 0,
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-a",
      caseId: "case-inbox-1",
      version: 0,
    });
    await seedJob(fixture.adminConfig, job);

    const q = queue();
    try {
      const leased = await q.lease({
        workerId: "worker-a",
        acceptedTypes: ["investigation.reproduction-planning"],
        now: now(),
        leaseDurationMs: 60_000,
      });
      expect(leased?.job.jobId).toBe("job-inbox-1");

      const first = await q.append({
        tenantId: "tenant-a",
        jobId: job.jobId,
        leaseToken: leased!.lease.leaseToken,
        leaseAttempt: leased!.lease.attempt,
        workerId: "worker-a",
        baseAggregateVersion: 0,
        result,
      });
      expect(first).toEqual({ disposition: "accepted" });

      // A duplicate append of the same result is de-duplicated, not doubled.
      const second = await q.append({
        tenantId: "tenant-a",
        jobId: job.jobId,
        leaseToken: leased!.lease.leaseToken,
        leaseAttempt: leased!.lease.attempt,
        workerId: "worker-a",
        baseAggregateVersion: 0,
        result,
      });
      expect(second).toEqual({ disposition: "duplicate" });
    } finally {
      await q.close();
    }

    // The Server (never the Worker) applies the result deterministically.
    const consumer = new ServerIntelligenceResultConsumer(provider);
    const summary = await consumer.consumeForTenant("tenant-a");
    expect(summary.applied).toBe(1);
    expect(await readCaseVersion(fixture.adminConfig, "case-inbox-1")).toBe(1);

    // Re-consuming is idempotent: the result is applied exactly once.
    const again = await consumer.consumeForTenant("tenant-a");
    expect(again.applied).toBe(0);
    expect(again.duplicate).toBe(0);
    expect(await readCaseVersion(fixture.adminConfig, "case-inbox-1")).toBe(1);
  });

  it("rejects a forged lease token append and never inserts a result", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-a",
      caseId: "case-inbox-2",
      jobId: "job-inbox-2",
      baseAggregateVersion: 0,
      jobType: "investigation.bug-analysis",
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-a",
      caseId: "case-inbox-2",
      version: 0,
    });
    await seedJob(fixture.adminConfig, job);

    const q = queue();
    try {
      const leased = await q.lease({
        workerId: "worker-a",
        acceptedTypes: ["investigation.bug-analysis"],
        now: now(),
        leaseDurationMs: 60_000,
      });
      expect(leased?.job.jobId).toBe("job-inbox-2");

      await expect(
        q.append({
          tenantId: "tenant-a",
          jobId: job.jobId,
          leaseToken: "forged-token",
          leaseAttempt: leased!.lease.attempt,
          workerId: "worker-a",
          baseAggregateVersion: 0,
          result,
        }),
      ).rejects.toMatchObject({ code: "LeaseTokenMismatch" });
    } finally {
      await q.close();
    }
  });

  it("rejects an append whose base aggregate version does not match the job", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-a",
      caseId: "case-inbox-3",
      jobId: "job-inbox-3",
      baseAggregateVersion: 0,
      jobType: "skill.induction",
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-a",
      caseId: "case-inbox-3",
      version: 0,
    });
    await seedJob(fixture.adminConfig, job);

    const q = queue();
    try {
      const leased = await q.lease({
        workerId: "worker-a",
        acceptedTypes: ["skill.induction"],
        now: now(),
        leaseDurationMs: 60_000,
      });
      await expect(
        q.append({
          tenantId: "tenant-a",
          jobId: job.jobId,
          leaseToken: leased!.lease.leaseToken,
          leaseAttempt: leased!.lease.attempt,
          workerId: "worker-a",
          baseAggregateVersion: 7,
          result,
        }),
      ).rejects.toMatchObject({ code: "BaseVersionMismatch" });
    } finally {
      await q.close();
    }
  });

  it("returns recompute for a stale base version at apply time", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-a",
      caseId: "case-inbox-4",
      jobId: "job-inbox-4",
      baseAggregateVersion: 0,
      jobType: "skill.evaluation",
    });
    // The aggregate has already moved to version 1, so the result is stale.
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-a",
      caseId: "case-inbox-4",
      version: 1,
    });
    await seedJob(fixture.adminConfig, job);

    const q = queue();
    try {
      const leased = await q.lease({
        workerId: "worker-a",
        acceptedTypes: ["skill.evaluation"],
        now: now(),
        leaseDurationMs: 60_000,
      });
      await q.append({
        tenantId: "tenant-a",
        jobId: job.jobId,
        leaseToken: leased!.lease.leaseToken,
        leaseAttempt: leased!.lease.attempt,
        workerId: "worker-a",
        baseAggregateVersion: 0,
        result,
      });
    } finally {
      await q.close();
    }

    const consumer = new ServerIntelligenceResultConsumer(provider);
    const summary = await consumer.consumeForTenant("tenant-a");
    expect(summary.recompute).toBe(1);
    expect(summary.applied).toBe(0);
    expect(await readCaseVersion(fixture.adminConfig, "case-inbox-4")).toBe(1);
  });
});
