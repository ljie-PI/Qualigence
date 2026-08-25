import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionRunRecord, RunTerminalUpdate } from "@qualigence/evidence";
import {
  createPostgresRuntime,
  PostgresRunStore,
  PostgresRunStoreError,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import {
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";

const TENANT_ID = "tenant-postgres-runs";

describe.skipIf(!dockerAvailable())("PostgresRunStore", () => {
  let fixture: PostgresFixture;
  let runtime: TenantTransactionProvider;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
    runtime = createPostgresRuntime(fixture.serverConfig);
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await fixture?.stop();
  });

  it("creates, completes idempotently, and lists a tenant's runs under RLS", async () => {
    await runtime.withTenant(TENANT_ID, async ({ db }) => {
      const runs = new PostgresRunStore(db, TENANT_ID);
      await runs.create(runningRun("run-1"));
      await runs.create({ ...runningRun("run-2"), createdAt: "2026-08-01T00:01:00.000Z" });

      await expect(runs.complete("run-1", passedAt("2026-08-01T00:05:00.000Z"))).resolves.toBe("completed");
      await expect(runs.complete("run-1", passedAt("2026-08-01T00:05:00.000Z"))).resolves.toBe("duplicate");
      await expect(runs.get("run-1")).resolves.toMatchObject({
        runId: "run-1",
        status: "passed",
        completedAt: "2026-08-01T00:05:00.000Z",
      });
      await expect(runs.list()).resolves.toMatchObject([
        { runId: "run-1", status: "passed" },
        { runId: "run-2", status: "running" },
      ]);
    });
  });

  it("does not expose another tenant's run and rejects conflicting terminals", async () => {
    await runtime.withTenant("tenant-runs-a", async ({ db }) => {
      const runs = new PostgresRunStore(db, "tenant-runs-a");
      await runs.create(runningRun("shared-run"));
      await runs.complete("shared-run", passedAt("2026-08-01T00:05:00.000Z"));
      await expect(runs.complete("shared-run", { status: "error", completedAt: "2026-08-01T00:09:00.000Z", errorCode: "Different" })).rejects.toBeInstanceOf(PostgresRunStoreError);
    });

    await runtime.withTenant("tenant-runs-b", async ({ db }) => {
      const runs = new PostgresRunStore(db, "tenant-runs-b");
      await expect(runs.get("shared-run")).resolves.toBeUndefined();
      await expect(runs.list()).resolves.toEqual([]);
      await expect(runs.complete("shared-run", passedAt("2026-08-01T00:05:00.000Z"))).rejects.toBeInstanceOf(PostgresRunStoreError);
    });
  });
});

function runningRun(runId: string): ExecutionRunRecord {
  return {
    runId,
    jobId: `job-${runId}`,
    targetKind: "web",
    objective: "verify checkout",
    status: "running",
    nextSequenceNumber: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function passedAt(at: string): RunTerminalUpdate {
  return { status: "passed", completedAt: at };
}
