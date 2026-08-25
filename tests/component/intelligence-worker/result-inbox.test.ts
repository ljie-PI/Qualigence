import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ServerIntelligenceResultConsumer } from "@qualigence/core-application";
import {
  acquirePostgresOperationLock,
  createPostgresRuntime,
  PostgresIntelligenceQueue,
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

const { Client } = pg;
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
    }, acquirePostgresOperationLock);
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

      const admin = new Client(fixture.adminConfig);
      await admin.connect();
      try {
        const inboxRows = await admin.query(
          `select tenant_id, job_id, worker_id, lease_attempt, base_aggregate_version, result_hash
             from intelligence_result_inbox
            where tenant_id = 'tenant-a' and idempotency_key = $1`,
          [result.idempotencyKey],
        );
        expect(inboxRows.rows).toHaveLength(1);
        expect(inboxRows.rows[0]).toMatchObject({
          tenant_id: "tenant-a",
          job_id: job.jobId,
          worker_id: "worker-a",
          lease_attempt: leased!.lease.attempt,
          base_aggregate_version: 0,
        });
        expect(inboxRows.rows[0].result_hash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await admin.end();
      }

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

  it("rejects a replayed idempotency key with different Result data", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-conflict",
      caseId: "case-inbox-conflict",
      jobId: "job-inbox-conflict",
      baseAggregateVersion: 0,
      jobType: "investigation.bug-analysis",
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-conflict",
      caseId: "case-inbox-conflict",
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
      await q.append({
        tenantId: "tenant-conflict",
        jobId: job.jobId,
        leaseToken: leased!.lease.leaseToken,
        leaseAttempt: leased!.lease.attempt,
        workerId: "worker-a",
        baseAggregateVersion: 0,
        result,
      });

      await expect(
        q.append({
          tenantId: "tenant-conflict",
          jobId: job.jobId,
          leaseToken: leased!.lease.leaseToken,
          leaseAttempt: leased!.lease.attempt,
          workerId: "worker-a",
          baseAggregateVersion: 0,
          result: { ...result, confidence: 0.1 },
        }),
      ).rejects.toMatchObject({ code: "IdempotencyConflict" });
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

  it("does not apply a raw legacy result row without validated inbox metadata", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-raw-result",
      caseId: "case-raw-result",
      jobId: "job-raw-result",
      baseAggregateVersion: 0,
      jobType: "investigation.bug-analysis",
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-raw-result",
      caseId: "case-raw-result",
      version: 0,
    });
    await seedJob(fixture.adminConfig, job);

    const admin = new Client(fixture.adminConfig);
    await admin.connect();
    try {
      await admin.query(
        `insert into intelligence_results
          (tenant_id, idempotency_key, job_id, terminal_status, confidence, result_json, created_at)
         values ($1, $2, $3, $4, $5, $6, now()::text)`,
        [
          job.tenantId,
          result.idempotencyKey,
          result.jobId,
          result.terminalStatus,
          result.confidence,
          JSON.stringify(result),
        ],
      );
    } finally {
      await admin.end();
    }

    const consumer = new ServerIntelligenceResultConsumer(provider);
    const summary = await consumer.consumeForTenant("tenant-raw-result");
    expect(summary.applied).toBe(0);
    expect(summary.dispositions).toEqual([]);
    expect(await readCaseVersion(fixture.adminConfig, "case-raw-result")).toBe(0);
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
