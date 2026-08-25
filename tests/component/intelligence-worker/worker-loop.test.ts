import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { IntelligenceJobStore, IntelligenceResultInbox } from "@qualigence/core-application";
import { WorkerLoop, type Clock } from "@qualigence/intelligence-worker";
import {
  acquirePostgresOperationLock,
  PostgresIntelligenceQueue,
} from "@qualigence/postgres-runtime";
import type { JobProcessor } from "@qualigence/intelligence-worker";
import type { IntelligenceJob, IntelligenceResult } from "@qualigence/intelligence";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupPostgresFixture, type PostgresFixture } from "../../helpers/postgres-fixture.js";
import { buildJobPair, seedInvestigationCase, seedJob } from "../../helpers/intelligence-fixtures.js";

const { Client } = pg;
const skip = !dockerAvailable();
const describeMaybe = skip ? describe.skip : describe;

const fixedClock: Clock = {
  now: () => new Date().toISOString(),
  sleep: async () => {},
};

describeMaybe("Intelligence Worker loop", () => {
  let fixture: PostgresFixture;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
  }, 180_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  function queue(): PostgresIntelligenceQueue {
    return new PostgresIntelligenceQueue(
      {
        host: fixture.workerConfig.host,
        port: fixture.workerConfig.port,
        database: fixture.workerConfig.database,
        user: fixture.workerConfig.user,
        password: fixture.workerConfig.password,
      },
      acquirePostgresOperationLock,
    );
  }

  async function resultCount(idempotencyKey: string): Promise<number> {
    const client = new Client(fixture.adminConfig);
    await client.connect();
    try {
      const rows = await client.query(
        "select count(*)::int as n from intelligence_results where idempotency_key = $1",
        [idempotencyKey],
      );
      return rows.rows[0].n as number;
    } finally {
      await client.end();
    }
  }

  function loopWith(
    q: PostgresIntelligenceQueue,
    processor: JobProcessor,
    onError?: (e: unknown) => void,
  ): WorkerLoop {
    const store: IntelligenceJobStore = q;
    const inbox: IntelligenceResultInbox = q;
    return new WorkerLoop({
      store,
      inbox,
      processor,
      workerId: "worker-loop-a",
      acceptedTypes: ["investigation.reproduction-planning"],
      leaseDurationMs: 60_000,
      idleBackoffMs: 5,
      clock: fixedClock,
      ...(onError ? { onError } : {}),
    });
  }

  it("leases a job, processes it, and durably appends the result exactly once", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-a",
      caseId: "case-loop-1",
      jobId: "job-loop-1",
      baseAggregateVersion: 0,
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-a",
      caseId: "case-loop-1",
      version: 0,
    });
    await seedJob(fixture.adminConfig, job);

    const q = queue();
    const processor: JobProcessor = { process: async (leased: IntelligenceJob) => {
      expect(leased.jobId).toBe("job-loop-1");
      return result;
    } };
    try {
      expect(await loopWith(q, processor).runOnce()).toBe("processed");
      expect(await resultCount(result.idempotencyKey)).toBe(1);
      // No job remains pending, so the next step is idle.
      expect(await loopWith(q, processor).runOnce()).toBe("idle");
    } finally {
      await q.close();
    }
  });

  it("returns idle when no job of an accepted type is pending", async () => {
    const q = queue();
    const processor: JobProcessor = { process: async () => {
      throw new Error("should not be called");
    } };
    try {
      expect(await loopWith(q, processor).runOnce()).toBe("idle");
    } finally {
      await q.close();
    }
  });

  it("abandons the lease on a processing failure so the job is re-leasable and never applied", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-a",
      caseId: "case-loop-3",
      jobId: "job-loop-3",
      baseAggregateVersion: 0,
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-a",
      caseId: "case-loop-3",
      version: 0,
    });
    await seedJob(fixture.adminConfig, job);

    const failing = queue();
    const errors: unknown[] = [];
    const failProcessor: JobProcessor = { process: async () => {
      throw new Error("model exploded");
    } };
    try {
      expect(await loopWith(failing, failProcessor, (e) => errors.push(e)).runOnce()).toBe("failed");
      expect(errors).toHaveLength(1);
      // Nothing was appended.
      expect(await resultCount(result.idempotencyKey)).toBe(0);
    } finally {
      await failing.close();
    }

    // A fresh worker re-leases the same job and succeeds.
    const recovering = queue();
    const okProcessor: JobProcessor = { process: async () => result };
    try {
      expect(await loopWith(recovering, okProcessor).runOnce()).toBe("processed");
      expect(await resultCount(result.idempotencyKey)).toBe(1);
    } finally {
      await recovering.close();
    }
  });

  it("run() processes pending work then stops when the signal aborts", async () => {
    const { job, result } = buildJobPair({
      tenantId: "tenant-a",
      caseId: "case-loop-4",
      jobId: "job-loop-4",
      baseAggregateVersion: 0,
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: "tenant-a",
      caseId: "case-loop-4",
      version: 0,
    });
    await seedJob(fixture.adminConfig, job);

    const q = queue();
    const controller = new AbortController();
    const processor: JobProcessor = { process: async () => {
      // Abort after the single job is processed so run() exits the loop.
      controller.abort();
      return result;
    } };
    try {
      await loopWith(q, processor).run(controller.signal);
      expect(await resultCount(result.idempotencyKey)).toBe(1);
    } finally {
      await q.close();
    }
  });
});
