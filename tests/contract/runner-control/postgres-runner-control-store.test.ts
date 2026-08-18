import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresRuntime,
  PostgresRunnerControlStore,
  type TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { dockerAvailable } from "../../helpers/docker-container.js";
import {
  setupPostgresFixture,
  type PostgresFixture,
} from "../../helpers/postgres-fixture.js";
import {
  runnerControlStoreContract,
  type RunnerControlStoreContractHarness,
} from "./runner-control-store.contract.js";

const TENANT_ID = "tenant-runner-control";

let fixture: PostgresFixture | undefined;

beforeAll(async () => {
  if (!dockerAvailable()) {
    throw new Error("DockerUnavailable: RunnerControlStore PostgreSQL contract requires Docker.");
  }
  fixture = await setupPostgresFixture();
}, 120_000);

afterAll(async () => {
  await fixture?.stop();
});

async function truncateRunnerControlTables(fixtureToClean: PostgresFixture): Promise<void> {
  const admin = await import("pg").then((module) => new module.default.Client(fixtureToClean.adminConfig));
  await admin.connect();
  try {
    await admin.query(
      "TRUNCATE TABLE execution_completions, execution_leases, runner_resume_tokens, runner_sessions",
    );
  } finally {
    await admin.end();
  }
}

function storeIn(
  getRuntime: () => TenantTransactionProvider,
): RunnerControlStoreContractHarness["runPrimary"] {
  return (operation) =>
    getRuntime().withTenant(TENANT_ID, ({ db }) =>
      operation(new PostgresRunnerControlStore(db, TENANT_ID)),
    );
}

async function createHarness(): Promise<RunnerControlStoreContractHarness> {
  if (!dockerAvailable()) {
    throw new Error("DockerUnavailable: RunnerControlStore PostgreSQL contract requires Docker.");
  }
  if (fixture === undefined) {
    throw new Error("PostgreSQL RunnerControlStore fixture was not initialized.");
  }
  const f = fixture;
  await truncateRunnerControlTables(f);
  let primary = createPostgresRuntime(f.serverConfig);
  let concurrent = createPostgresRuntime(f.serverConfig);

  return {
    runPrimary: storeIn(() => primary),
    runConcurrent: storeIn(() => concurrent),
    // A real reopen: fresh pools and connections against the same database, so
    // the restart contract observes durable state across connections.
    async reopen() {
      await concurrent.close();
      await primary.close();
      primary = createPostgresRuntime(f.serverConfig);
      concurrent = createPostgresRuntime(f.serverConfig);
    },
    async close() {
      await concurrent.close();
      await primary.close();
    },
  };
}

runnerControlStoreContract("PostgreSQL", createHarness);

describe("PostgresRunnerControlStore persisted policy migration", () => {
  it("rejects every policyless persisted Job on read and renewal without changing expiry", async () => {
    if (fixture === undefined) throw new Error("PostgreSQL fixture was not initialized.");
    await truncateRunnerControlTables(fixture);
    const runtime = createPostgresRuntime(fixture.serverConfig);
    const expiresAt = "2026-08-18T00:01:00.000Z";
    try {
      await runtime.withTenant(TENANT_ID, async ({ db }) => {
        await db.insertInto("execution_leases").values({
          tenant_id: TENANT_ID, run_id: "run-policyless", job_id: "job-policyless", runner_id: "runner-1", session_id: "session-1",
          lease_epoch: 1, lease_token_hash: "token-hash", expires_at: expiresAt, lost_at: null, completed_at: null,
          recovery_of_run_id: null,
          job_json: JSON.stringify({ jobId: "job-policyless", runId: "run-policyless", target: { kind: "web", url: "https://example.test/" }, objective: "legacy" }),
        }).execute();
        const store = new PostgresRunnerControlStore(db, TENANT_ID);
        await expect(store.lease("run-policyless")).rejects.toMatchObject({ code: "PolicyMissing" });
        await expect(store.renewLease({ runId: "run-policyless", jobId: "job-policyless", owner: { runnerId: "runner-1", sessionId: "session-1" }, leaseEpoch: 1, leaseTokenHash: "token-hash", checkedAt: "2026-08-18T00:00:30.000Z", newExpiresAt: "2026-08-18T00:02:00.000Z" })).rejects.toMatchObject({ code: "PolicyMissing" });
        const row = await db.selectFrom("execution_leases").select("expires_at").where("run_id", "=", "run-policyless").executeTakeFirstOrThrow();
        expect(row.expires_at).toBe(expiresAt);
      });
    } finally {
      await runtime.close();
    }
  });

  it.each([
    ["malformed Job identity", { jobId: 12 }],
    ["malformed target", { target: { kind: "web" } }],
    ["invalid policy timestamp", { policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "invalid" } }],
    ["inverted policy timestamp", { policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:01:00.000Z", expiresAt: "2026-08-18T00:00:00.000Z" } }],
  ])("rejects persisted %s without mutating renewal expiry", async (_name, invalid) => {
    if (fixture === undefined) throw new Error("PostgreSQL fixture was not initialized.");
    await truncateRunnerControlTables(fixture);
    const runtime = createPostgresRuntime(fixture.serverConfig);
    const expiresAt = "2026-08-18T00:01:00.000Z";
    try {
      await runtime.withTenant(TENANT_ID, async ({ db }) => {
        await db.insertInto("execution_leases").values({
          tenant_id: TENANT_ID, run_id: "run-malformed", job_id: "job-malformed", runner_id: "runner-1", session_id: "session-1", lease_epoch: 1,
          lease_token_hash: "token-hash", expires_at: expiresAt, lost_at: null, completed_at: null, recovery_of_run_id: null,
          job_json: JSON.stringify({ jobId: "job-malformed", runId: "run-malformed", target: { kind: "web", url: "https://example.test/" }, objective: "legacy", policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" }, ...invalid }),
        }).execute();
        const store = new PostgresRunnerControlStore(db, TENANT_ID);
        await expect(store.lease("run-malformed")).rejects.toMatchObject({ code: "PolicyMissing" });
        await expect(store.renewLease({ runId: "run-malformed", jobId: "job-malformed", owner: { runnerId: "runner-1", sessionId: "session-1" }, leaseEpoch: 1, leaseTokenHash: "token-hash", checkedAt: "2026-08-18T00:00:30.000Z", newExpiresAt: "2026-08-18T00:02:00.000Z" })).rejects.toMatchObject({ code: "PolicyMissing" });
        await expect(db.selectFrom("execution_leases").select("expires_at").where("run_id", "=", "run-malformed").executeTakeFirstOrThrow()).resolves.toMatchObject({ expires_at: expiresAt });
      });
    } finally {
      await runtime.close();
    }
  });
});
