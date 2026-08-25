import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ServerIntelligenceResultConsumer, type ConsumeSummary } from "@qualigence/core-application";
import { WorkerLoop, type JobProcessor } from "@qualigence/intelligence-worker";
import {
  acquirePostgresOperationLock,
  createPostgresRuntime,
  PostgresIntelligenceQueue,
  PostgresIntelligenceResultWakeupStore,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { buildServer } from "../../../apps/server/src/server.js";
import { IntelligenceResultConsumerLoop } from "../../../apps/server/src/intelligence-result-consumer-loop.js";
import type { ServerDeps } from "../../../apps/server/src/server-context.js";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { buildJobPair, readCaseVersion, seedInvestigationCase, seedJob } from "../../helpers/intelligence-fixtures.js";
import { setupPostgresFixture, type PostgresFixture } from "../../helpers/postgres-fixture.js";

const { Client } = pg;

describe("Self-hosted Intelligence Result loop", () => {
  let fixture: PostgresFixture;
  let provider: TenantTransactionProvider;

  beforeAll(async () => {
    if (!dockerAvailable()) {
      throw new Error("DockerUnavailable: PostgreSQL is required for Intelligence Result loop acceptance");
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

  function wakeups(): PostgresIntelligenceResultWakeupStore {
    return new PostgresIntelligenceResultWakeupStore(fixture.serverConfig, acquirePostgresOperationLock);
  }

  it("proves restart, failure retry, readiness, and orderly shutdown with the real PostgreSQL wakeup path", async () => {
    const readyWakeups = wakeups();
    const readyLoop = new IntelligenceResultConsumerLoop({
      consumerId: "consumer-e2e-ready",
      wakeups: readyWakeups,
      consumer: { consumeForTenant: async () => emptySummary() },
      setTimeout: () => ({ timer: true }),
      clearTimeout: () => undefined,
    });
    const app = buildServer({
      readiness: () => readinessReport(readyLoop),
    } as unknown as ServerDeps);
    try {
      await expect(app.inject({ method: "GET", url: "/readyz" })).resolves.toMatchObject({ statusCode: 503 });
      readyLoop.start();
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        status: "ready",
        checks: [{ name: "intelligence_result_consumer", status: "pass" }],
      });
      await readyLoop.stop();
      const stopped = await app.inject({ method: "GET", url: "/readyz" });
      expect(stopped.statusCode).toBe(503);
      expect(stopped.json()).toMatchObject({
        status: "not-ready",
        checks: [{ name: "intelligence_result_consumer", status: "fail" }],
      });
    } finally {
      await readyLoop.stop();
      await readyWakeups.close();
      await app.close();
    }

    const restartPair = buildJobPair({
      tenantId: "tenant-result-restart",
      caseId: "case-result-restart",
      jobId: "job-result-restart",
      baseAggregateVersion: 0,
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: restartPair.job.tenantId,
      caseId: "case-result-restart",
      version: 0,
    });
    await seedJob(fixture.adminConfig, restartPair.job);
    await appendThroughRealWorker(restartPair.job.jobId, restartPair.result, "worker-result-restart");

    const failingWakeups = wakeups();
    try {
      const failingLoop = new IntelligenceResultConsumerLoop({
        consumerId: "consumer-e2e-retry",
        wakeups: failingWakeups,
        consumer: {
          async consumeForTenant() {
            throw new Error("injected result consumer failure");
          },
        },
        errorBackoffMs: 10,
      });
      await expect(failingLoop.runOnce()).resolves.toMatchObject({ claimed: 1, retried: 1, completed: 0 });
      const wakeup = await readWakeup(restartPair.job.tenantId);
      expect(wakeup).toMatchObject({ status: "pending", lease_owner: null });
      expect(String(wakeup?.last_error)).toContain("injected result consumer failure");
    } finally {
      await failingWakeups.close();
    }

    const restartedWakeups = wakeups();
    try {
      const restartedLoop = new IntelligenceResultConsumerLoop({
        consumerId: "consumer-e2e-restarted",
        wakeups: restartedWakeups,
        consumer: new ServerIntelligenceResultConsumer(provider),
        idleBackoffMs: 10,
      });
      await expect(restartedLoop.runOnce()).resolves.toMatchObject({ claimed: 1, applied: 1, completed: 1 });
      await expect(readCaseVersion(fixture.adminConfig, "case-result-restart")).resolves.toBe(1);
    } finally {
      await restartedWakeups.close();
    }

    const shutdownPair = buildJobPair({
      tenantId: "tenant-result-shutdown",
      caseId: "case-result-shutdown",
      jobId: "job-result-shutdown",
      baseAggregateVersion: 0,
    });
    await seedInvestigationCase(fixture.adminConfig, {
      tenantId: shutdownPair.job.tenantId,
      caseId: "case-result-shutdown",
      version: 0,
    });
    await seedJob(fixture.adminConfig, shutdownPair.job);
    await appendThroughRealWorker(shutdownPair.job.jobId, shutdownPair.result, "worker-result-shutdown");

    const shutdown = new AbortController();
    const stoppingWakeups = wakeups();
    try {
      const stoppingLoop = new IntelligenceResultConsumerLoop({
        consumerId: "consumer-e2e-shutdown",
        wakeups: stoppingWakeups,
        signal: shutdown.signal,
        consumer: {
          async consumeForTenant(_tenantId, options) {
            shutdown.abort();
            if (options?.signal?.aborted === true) {
              const error = new Error("aborted before dispatch");
              error.name = "IntelligenceResultConsumerAbortError";
              throw error;
            }
            throw new Error("missing abort signal");
          },
        },
      });
      await expect(stoppingLoop.runOnce()).resolves.toMatchObject({ claimed: 1, retried: 1, completed: 0 });
      await expect(dispositionCount(shutdownPair.job.tenantId, shutdownPair.result.idempotencyKey)).resolves.toBe(0);
      const wakeup = await readWakeup(shutdownPair.job.tenantId);
      expect(wakeup).toMatchObject({ status: "pending", lease_owner: null, last_error: "aborted" });
    } finally {
      await stoppingWakeups.close();
    }

    const afterShutdownWakeups = wakeups();
    try {
      const afterShutdownLoop = new IntelligenceResultConsumerLoop({
        consumerId: "consumer-e2e-after-shutdown",
        wakeups: afterShutdownWakeups,
        consumer: new ServerIntelligenceResultConsumer(provider),
      });
      await expect(afterShutdownLoop.runOnce()).resolves.toMatchObject({ claimed: 1, applied: 1, completed: 1 });
      await expect(readCaseVersion(fixture.adminConfig, "case-result-shutdown")).resolves.toBe(1);
    } finally {
      await afterShutdownWakeups.close();
    }
  }, 180_000);

  async function appendThroughRealWorker(
    jobId: string,
    result: ReturnType<typeof buildJobPair>["result"],
    workerId: string,
  ): Promise<void> {
    const worker = queue();
    const processor: JobProcessor = {
      process: async (leased) => {
        expect(leased.jobId).toBe(jobId);
        return result;
      },
    };
    try {
      const loop = new WorkerLoop({
        store: worker,
        inbox: worker,
        processor,
        workerId,
        acceptedTypes: ["investigation.reproduction-planning"],
        leaseDurationMs: 60_000,
        idleBackoffMs: 5,
      });
      await expect(loop.runOnce()).resolves.toBe("processed");
    } finally {
      await worker.close();
    }
  }

  function readinessReport(loop: IntelligenceResultConsumerLoop) {
    const state = loop.readiness();
    const pass = state.status === "ready";
    return {
      status: pass ? "ready" as const : "not-ready" as const,
      checks: [{
        name: "intelligence_result_consumer" as const,
        status: pass ? "pass" as const : "fail" as const,
        safeMessage: pass
          ? "intelligence result consumer loop is running"
          : "intelligence result consumer loop cannot make progress",
        details: { ...state },
      }],
    };
  }

  async function dispositionCount(tenantId: string, idempotencyKey: string): Promise<number> {
    const rows = await readAdminRows(
      `select count(*)::int as count
         from intelligence_result_dispositions
        where tenant_id = $1 and idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    return rows[0]?.count as number;
  }

  async function readWakeup(tenantId: string): Promise<Record<string, unknown> | undefined> {
    const rows = await readAdminRows(
      `select status, lease_owner, last_error
         from intelligence_result_wakeups
        where tenant_id = $1`,
      [tenantId],
    );
    return rows[0];
  }

  async function readAdminRows(query: string, values: readonly unknown[] = []): Promise<Array<Record<string, unknown>>> {
    const admin = new Client(fixture.adminConfig);
    await admin.connect();
    try {
      const result = await admin.query<Record<string, unknown>>(query, [...values]);
      return result.rows;
    } finally {
      await admin.end();
    }
  }
});

function emptySummary(): ConsumeSummary {
  return {
    applied: 0,
    duplicate: 0,
    recompute: 0,
    rejected: 0,
    processed: 0,
    hasMore: false,
    dispositions: [],
  };
}
