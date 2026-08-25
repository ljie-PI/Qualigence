import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  acquirePostgresOperationLock,
  PostgresIntelligenceResultWakeupStore,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupPostgresFixture, type PostgresFixture } from "../../helpers/postgres-fixture.js";

const { Client } = pg;
const skip = !dockerAvailable();
const describeMaybe = skip ? describe.skip : describe;

describeMaybe("Postgres Intelligence Result wakeup store", () => {
  let fixture: PostgresFixture;

  beforeAll(async () => {
    fixture = await setupPostgresFixture();
  }, 180_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  function store(): PostgresIntelligenceResultWakeupStore {
    return new PostgresIntelligenceResultWakeupStore(fixture.serverConfig, acquirePostgresOperationLock);
  }

  async function seedWakeup(tenantId: string, generation = 1): Promise<void> {
    const admin = new Client(fixture.adminConfig);
    await admin.connect();
    try {
      await admin.query(
        `insert into intelligence_result_wakeups
          (tenant_id, generation, status, available_at, lease_owner, lease_generation,
           lease_expires_at, last_claimed_at, last_completed_at, failure_count, last_error,
           created_at, updated_at)
         values ($1, $2, 'pending', '2000-01-01T00:00:00.000Z', null, null,
           null, null, null, 0, null, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
        [tenantId, generation],
      );
    } finally {
      await admin.end();
    }
  }

  async function wakeup(tenantId: string): Promise<{
    readonly status: string;
    readonly generation: number;
    readonly lease_owner: string | null;
    readonly lease_generation: number | null;
    readonly failure_count: number;
  }> {
    const admin = new Client(fixture.adminConfig);
    await admin.connect();
    try {
      const row = await admin.query(
        `select status, generation, lease_owner, lease_generation, failure_count
           from intelligence_result_wakeups
          where tenant_id = $1`,
        [tenantId],
      );
      return row.rows[0] as {
        readonly status: string;
        readonly generation: number;
        readonly lease_owner: string | null;
        readonly lease_generation: number | null;
        readonly failure_count: number;
      };
    } finally {
      await admin.end();
    }
  }

  it("claims due tenants in bounded batches and fences completion by owner and generation", async () => {
    await seedWakeup("tenant-wakeup-a");
    await seedWakeup("tenant-wakeup-b");
    await seedWakeup("tenant-wakeup-c");

    const wakeups = store();
    try {
      const claimed = await wakeups.claimDueTenants({
        consumerId: "consumer-a",
        leaseDurationMs: 30_000,
        batchSize: 2,
      });
      expect(claimed.map(({ tenantId }) => tenantId)).toEqual(["tenant-wakeup-a", "tenant-wakeup-b"]);
      expect(claimed.map(({ generation }) => generation)).toEqual([1, 1]);

      await expect(wakeups.complete({
        tenantId: "tenant-wakeup-a",
        generation: 1,
        consumerId: "other-consumer",
      })).resolves.toBe("stale");
      expect((await wakeup("tenant-wakeup-a")).lease_owner).toBe("consumer-a");

      await expect(wakeups.complete(claimed[0]!)).resolves.toBe("completed");
      expect(await wakeup("tenant-wakeup-a")).toMatchObject({
        status: "idle",
        generation: 1,
        lease_owner: null,
        lease_generation: null,
        failure_count: 0,
      });

      const nextClaim = await wakeups.claimDueTenants({
        consumerId: "consumer-b",
        leaseDurationMs: 30_000,
        batchSize: 2,
      });
      expect(nextClaim.map(({ tenantId }) => tenantId)).toEqual(["tenant-wakeup-c"]);
    } finally {
      await wakeups.close();
    }
  });

  it("schedules retries and preserves newer generations from stale completions", async () => {
    await seedWakeup("tenant-wakeup-retry", 3);

    const wakeups = store();
    try {
      const [first] = await wakeups.claimDueTenants({
        consumerId: "consumer-a",
        leaseDurationMs: 30_000,
        batchSize: 1,
      });
      expect(first).toMatchObject({ tenantId: "tenant-wakeup-retry", generation: 3 });

      await expect(wakeups.retry({
        ...first!,
        retryAfterMs: 0,
        error: "storage unavailable",
      })).resolves.toBe("scheduled");
      expect(await wakeup("tenant-wakeup-retry")).toMatchObject({
        status: "pending",
        generation: 3,
        lease_owner: null,
        failure_count: 1,
      });

      const [second] = await wakeups.claimDueTenants({
        consumerId: "consumer-b",
        leaseDurationMs: 30_000,
        batchSize: 1,
      });
      expect(second).toMatchObject({ tenantId: "tenant-wakeup-retry", generation: 3 });

      const admin = new Client(fixture.adminConfig);
      await admin.connect();
      try {
        await admin.query(
          `update intelligence_result_wakeups
              set generation = generation + 1, status = 'pending', updated_at = '2000-01-01T00:00:01.000Z'
            where tenant_id = 'tenant-wakeup-retry'`,
        );
      } finally {
        await admin.end();
      }

      await expect(wakeups.complete(second!)).resolves.toBe("stale-generation");
      expect(await wakeup("tenant-wakeup-retry")).toMatchObject({
        status: "pending",
        generation: 4,
        lease_owner: null,
      });
    } finally {
      await wakeups.close();
    }
  });
});
