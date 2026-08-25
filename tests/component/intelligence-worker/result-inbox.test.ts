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

      const wakeupRows = await readAdminRows(fixture.adminConfig,
        `select generation, status, lease_owner
           from intelligence_result_wakeups
          where tenant_id = 'tenant-a'`,
      );
      expect(wakeupRows.rows).toEqual([{ generation: 1, status: "pending", lease_owner: null }]);

      // A duplicate append of the same result is de-duplicated, not doubled,
      // and does not create another tenant wakeup generation.
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
      const unchangedWakeupRows = await readAdminRows(fixture.adminConfig,
        `select generation, status, lease_owner
           from intelligence_result_wakeups
          where tenant_id = 'tenant-a'`,
      );
      expect(unchangedWakeupRows.rows).toEqual([{ generation: 1, status: "pending", lease_owner: null }]);
    } finally {
      await q.close();
    }

    // The Server (never the Worker) applies the result deterministically.
    const consumer = new ServerIntelligenceResultConsumer(provider);
    const summary = await consumer.consumeForTenant("tenant-a");
    expect(summary.applied).toBe(1);
    expect(await readCaseVersion(fixture.adminConfig, "case-inbox-1")).toBe(1);
    const dispositions = await readAdminRows(fixture.adminConfig,
      `select status, aggregate_type, aggregate_id, new_version
         from intelligence_result_dispositions
        where tenant_id = 'tenant-a' and idempotency_key = $1`,
      [result.idempotencyKey],
    );
    expect(dispositions.rows).toEqual([
      { status: "applied", aggregate_type: "investigation", aggregate_id: "case-inbox-1", new_version: 1 },
    ]);

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

  it("durably records rejected and duplicate dispositions without unauthorized aggregate mutation", async () => {
    const rejectedPair = buildJobPair({
      tenantId: "tenant-disposition",
      caseId: "case-rejected-disposition",
      jobId: "job-rejected-disposition",
      baseAggregateVersion: 0,
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-disposition",
      caseId: "case-rejected-disposition",
      version: 0,
    });
    await seedJob(fixture.adminConfig, rejectedPair.job);

    const duplicatePair = buildJobPair({
      tenantId: "tenant-disposition",
      caseId: "case-duplicate-disposition",
      jobId: "job-duplicate-disposition",
      baseAggregateVersion: 0,
      idempotencyKey: "idem-duplicate-disposition",
      jobType: "investigation.bug-analysis",
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-disposition",
      caseId: "case-duplicate-disposition",
      version: 0,
    });
    await seedJob(fixture.adminConfig, duplicatePair.job);

    const q = queue();
    try {
      const rejectedLease = await q.lease({
        workerId: "worker-a",
        acceptedTypes: ["investigation.reproduction-planning"],
        now: now(),
        leaseDurationMs: 60_000,
      });
      await q.append({
        tenantId: "tenant-disposition",
        jobId: rejectedPair.job.jobId,
        leaseToken: rejectedLease!.lease.leaseToken,
        leaseAttempt: rejectedLease!.lease.attempt,
        workerId: "worker-a",
        baseAggregateVersion: 0,
        result: { ...rejectedPair.result, terminalStatus: "failed" },
      });

      const duplicateLease = await q.lease({
        workerId: "worker-a",
        acceptedTypes: ["investigation.bug-analysis"],
        now: now(),
        leaseDurationMs: 60_000,
      });
      await q.append({
        tenantId: "tenant-disposition",
        jobId: duplicatePair.job.jobId,
        leaseToken: duplicateLease!.lease.leaseToken,
        leaseAttempt: duplicateLease!.lease.attempt,
        workerId: "worker-a",
        baseAggregateVersion: 0,
        result: duplicatePair.result,
      });
    } finally {
      await q.close();
    }

    await readAdminRows(fixture.adminConfig,
      `insert into intelligence_applied_results
        (tenant_id, idempotency_key, aggregate_type, aggregate_id, new_version, summary, created_at)
       values ('tenant-disposition', 'idem-duplicate-disposition', 'investigation', 'case-duplicate-disposition', 1, 'already applied', now()::text)`,
    );

    const consumer = new ServerIntelligenceResultConsumer(provider);
    const summary = await consumer.consumeForTenant("tenant-disposition");
    expect(summary).toMatchObject({ rejected: 1, duplicate: 1, applied: 0 });
    expect(await readCaseVersion(fixture.adminConfig, "case-rejected-disposition")).toBe(0);
    expect(await readCaseVersion(fixture.adminConfig, "case-duplicate-disposition")).toBe(0);
    const dispositions = await readAdminRows(fixture.adminConfig,
      `select idempotency_key, status, code, aggregate_id, new_version
         from intelligence_result_dispositions
        where tenant_id = 'tenant-disposition'
        order by idempotency_key`,
    );
    expect(dispositions.rows).toEqual([
      {
        idempotency_key: "idem-duplicate-disposition",
        status: "duplicate",
        code: null,
        aggregate_id: "case-duplicate-disposition",
        new_version: 1,
      },
      {
        idempotency_key: rejectedPair.result.idempotencyKey,
        status: "rejected",
        code: "TerminalNotSucceeded",
        aggregate_id: null,
        new_version: null,
      },
    ]);
  });

  it("rejects policy-authored model proposals before aggregate execution", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-policy-invalid",
      caseId: "case-policy-invalid",
      jobId: "job-policy-invalid",
      baseAggregateVersion: 0,
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-policy-invalid",
      caseId: "case-policy-invalid",
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
      await q.append({
        tenantId: "tenant-policy-invalid",
        jobId: job.jobId,
        leaseToken: leased!.lease.leaseToken,
        leaseAttempt: leased!.lease.attempt,
        workerId: "worker-a",
        baseAggregateVersion: 0,
        result: {
          ...result,
          proposals: [{ ...result.proposals[0]!, policyId: "model-authored-policy" }],
        },
      });
    } finally {
      await q.close();
    }

    const consumer = new ServerIntelligenceResultConsumer(provider);
    const summary = await consumer.consumeForTenant("tenant-policy-invalid");
    expect(summary).toMatchObject({ rejected: 1, applied: 0 });
    expect(await readCaseVersion(fixture.adminConfig, "case-policy-invalid")).toBe(0);
    const dispositions = await readAdminRows(fixture.adminConfig,
      `select status, code, aggregate_id
         from intelligence_result_dispositions
        where tenant_id = 'tenant-policy-invalid' and idempotency_key = $1`,
      [result.idempotencyKey],
    );
    expect(dispositions.rows).toEqual([
      { status: "rejected", code: "PolicyViolation", aggregate_id: null },
    ]);
  });

  it("does not apply a raw legacy result row without validated inbox metadata", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-raw-result",
      caseId: "case-raw-result",
      jobId: "job-raw-result",
      baseAggregateVersion: 0,
      jobType: "skill.induction",
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
    expect(summary.hasMore).toBe(true);
    expect(await readCaseVersion(fixture.adminConfig, "case-inbox-4")).toBe(1);
    const dispositions = await readAdminRows(fixture.adminConfig,
      `select status, reason, new_version
         from intelligence_result_dispositions
        where tenant_id = 'tenant-a' and idempotency_key = $1`,
      [result.idempotencyKey],
    );
    expect(dispositions.rows).toHaveLength(1);
    expect(dispositions.rows[0]).toMatchObject({ status: "recompute", new_version: null });
    expect(dispositions.rows[0]?.reason).toContain("Base aggregate version 0");

    const retrySummary = await consumer.consumeForTenant("tenant-a");
    expect(retrySummary.recompute).toBe(1);
    const dispositionCount = await readAdminRows(fixture.adminConfig,
      `select count(*)::int as count
         from intelligence_result_dispositions
        where tenant_id = 'tenant-a' and idempotency_key = $1`,
      [result.idempotencyKey],
    );
    expect(dispositionCount.rows).toEqual([{ count: 1 }]);
  });

  it("ignores model-authored BugEpisode IDs and persists only the deterministic server ID", async () => {
    const caseId = "case-bug-id-owner";
    const attemptId = "attempt-bug-id-owner";
    const { job, result } = buildJobPair({
      tenantId: "tenant-bug-id-owner",
      caseId,
      jobId: "job-bug-id-owner",
      baseAggregateVersion: 1,
      jobType: "investigation.bug-analysis",
    });
    const analysisResult = {
      ...result,
      proposals: [{
        kind: "bug-analysis",
        episodeId: "model-authored-episode-id",
        confirmedAttemptIds: [attemptId],
        expectedClaims: ["expected behavior"],
        observedFacts: ["observed failure"],
        minimalSteps: [{ kind: "navigate", path: "/" }],
        environment: { browser: "chromium" },
      }],
    };
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-bug-id-owner",
      caseId,
      version: 1,
    });
    await seedReproducingAttempt(fixture.adminConfig, {
      tenantId: "tenant-bug-id-owner",
      caseId,
      attemptId,
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
        tenantId: "tenant-bug-id-owner",
        jobId: job.jobId,
        leaseToken: leased!.lease.leaseToken,
        leaseAttempt: leased!.lease.attempt,
        workerId: "worker-a",
        baseAggregateVersion: 1,
        result: analysisResult,
      });
    } finally {
      await q.close();
    }

    const consumer = new ServerIntelligenceResultConsumer(provider);
    await expect(consumer.consumeForTenant("tenant-bug-id-owner")).resolves.toMatchObject({ applied: 1 });
    const rows = await readAdminRows(fixture.adminConfig,
      `select c.bug_episode_id, e.episode_id, e.episode_json
         from investigation_cases c
         join investigation_bug_episodes e on e.episode_id = c.bug_episode_id
        where c.tenant_id = 'tenant-bug-id-owner' and c.case_id = $1`,
      [caseId],
    );
    const deterministicId = `${caseId}:episode:${result.idempotencyKey}`;
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.bug_episode_id).toBe(deterministicId);
    expect(rows.rows[0]?.episode_id).toBe(deterministicId);
    expect(JSON.parse(rows.rows[0]?.episode_json as string)).toMatchObject({
      episodeId: deterministicId,
      caseId,
    });
  });
});

async function seedReproducingAttempt(
  config: PostgresFixture["adminConfig"],
  input: { readonly tenantId: string; readonly caseId: string; readonly attemptId: string },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const attempt = {
    attemptId: input.attemptId,
    caseId: input.caseId,
    ordinal: 1,
    planRevision: 1,
    environmentRef: "environment-1",
    startedAt: nowIso,
    completedAt: nowIso,
    outcome: "reproduced",
    evidenceRefs: ["evidence-1"],
    budgetConsumed: {
      reproductionAttempts: 1,
      planningRevisions: 0,
      environmentRetries: 0,
      wallClockMs: 1,
      modelTokens: 0,
      environmentResets: 0,
      destructiveActions: 0,
    },
  };
  await readAdminRows(config,
    `update investigation_cases
        set status = 'reproducing', usage_json = $1, updated_at = $2
      where tenant_id = $3 and case_id = $4`,
    [JSON.stringify(attempt.budgetConsumed), nowIso, input.tenantId, input.caseId],
  );
  await readAdminRows(config,
    `insert into investigation_attempts
       (tenant_id, attempt_id, case_id, ordinal, plan_revision, outcome, attempt_json, created_at)
     values ($1, $2, $3, 1, 1, 'reproduced', $4, $5)`,
    [input.tenantId, input.attemptId, input.caseId, JSON.stringify(attempt), nowIso],
  );
}

async function readAdminRows(
  config: PostgresFixture["adminConfig"],
  query: string,
  values: readonly unknown[] = [],
): Promise<{ readonly rows: Array<Record<string, unknown>> }> {
  const admin = new Client(config);
  await admin.connect();
  try {
    return await admin.query<Record<string, unknown>>(query, [...values]);
  } finally {
    await admin.end();
  }
}
